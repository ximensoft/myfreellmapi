# /v1/responses/compact 端点设计与实现方案

## 1. 背景与需求

### 1.1 问题描述

当 Codex CLI 的对话上下文接近模型 context window 上限时，会触发 **compaction**（上下文压缩）机制。compaction 会向 `{base_url}/responses/compact` 发送一个 POST 请求，让服务端把长对话历史压缩成摘要，然后返回压缩后的 `ResponseItem` 列表。

当前网关已实现 `/v1/responses`（正常对话请求），但未实现 `/v1/responses/compact`。当 Codex 触发 compaction 时会收到 404，导致压缩失败。

### 1.2 需求

1. **正常请求** → 转发到第三方 API（当前已支持）
2. **Compaction 请求**（`POST /v1/responses/compact`）→ 转发到真实 OpenAI compaction 端点
   - 提供商名称为 `myopenai`（用户手动添加的自定义 provider）
   - 如果查不到 `myopenai` 或调用失败 → 返回 400 或 401
3. 所有请求和返回信息记录到 `logs/compact.log`
4. 控制台只打印简短日志（让用户看到触发了远程压缩即可）

---

## 2. 可行性调研

### 2.1 Codex CLI 源码分析

通过阅读 [openai/codex](https://github.com/openai/codex) 仓库源码，确认了以下关键事实：

#### 2.1.1 端点定义

文件 `codex-rs/core/src/client.rs` 第 159 行：

```rust
const RESPONSES_COMPACT_ENDPOINT: &str = "/responses/compact";
```

URL 构建方式（`codex-rs/codex-api/src/provider.rs`）：

```rust
pub fn url_for_path(&self, path: &str) -> String {
    let base = self.base_url.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}
```

因此实际请求 URL = `{base_url}/responses/compact`。对于 OpenAI 官方，`base_url = https://api.openai.com/v1`，完整 URL 为 `https://api.openai.com/v1/responses/compact`。

#### 2.1.2 请求体格式

文件 `codex-rs/codex-api/src/common.rs` 中的 `CompactionInput` 结构：

```rust
#[derive(Debug, Clone, Serialize)]
pub struct CompactionInput<'a> {
    pub model: &'a str,
    pub input: &'a [ResponseItem],
    #[serde(skip_serializing_if = "str::is_empty")]
    pub instructions: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
}
```

对应的 JSON：

```json
{
  "model": "o3",
  "input": [ /* ResponseItem 数组 — 完整对话历史 */ ],
  "instructions": "system prompt text",
  "tools": [ /* 工具定义 */ ],
  "parallel_tool_calls": false,
  "reasoning": { "effort": "high", "summary": "auto" },
  "service_tier": "default",
  "prompt_cache_key": "...",
  "text": { "verbosity": "medium" }
}
```

#### 2.1.3 响应体格式

文件 `codex-rs/codex-api/src/endpoint/compact.rs`：

```rust
#[derive(Debug, Deserialize)]
struct CompactHistoryResponse {
    output: Vec<ResponseItem>,
}
```

对应的 JSON：

```json
{
  "output": [ /* ResponseItem 数组 — 压缩后的对话历史 */ ]
}
```

#### 2.1.4 请求特性

- **Unary 请求**（非流式）：Codex 发送一个完整的 POST，等待一个完整的 JSON 响应。不涉及 SSE 流式传输。
- 注释明确说明：`// /responses/compact is unary, so the timeout covers the full response rather than one idle period between stream events.`
- **超时**：使用 `COMPACT_REQUEST_TIMEOUT_IDLE_MULTIPLIER = 4` 倍的普通请求超时。

#### 2.1.5 触发条件

文件 `codex-rs/core/src/compact_remote.rs` 和 `compact_remote_v2.rs` 中有两种触发方式：

- **自动触发**（`run_inline_remote_auto_compact_task`）：当对话 token 数接近 context window 上限时自动触发
- **手动触发**（`run_remote_compact_task`）：用户输入 `/compact` 命令时触发

### 2.2 当前网关代码分析

#### 2.2.1 路由挂载

文件 `server/src/app.ts`：

```typescript
app.use('/v1', anthropicRouter);  // Anthropic Messages API
app.use('/v1', proxyRouter);       // OpenAI Chat Completions API
app.use('/v1', responsesRouter);   // OpenAI Responses API (Codex CLI)
```

`responsesRouter` 当前只有 `POST /responses` 一个端点。需要新增 `POST /responses/compact`。

#### 2.2.2 自定义 Provider 机制

文件 `server/src/providers/index.ts`：

```typescript
export function resolveProvider(platform: string, baseUrl?: string | null): BaseProvider | undefined {
  const builtin = providers.get(platform as Platform);
  if (builtin) return builtin;

  // Not a built-in provider → treat as a custom endpoint.
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  return new OpenAICompatProvider({
    platform: platform as Platform,
    name: `${platform}`,
    baseUrl: trimmed,
    // ...
  });
}
```

`myopenai` 是用户手动添加的自定义 provider，在数据库 `api_keys` 表中有一行 `platform='myopenai'`，带有 `base_url`（指向真实 OpenAI API 地址）和加密的 API key。

#### 2.2.3 认证机制

文件 `server/src/routes/proxy.ts`：

```typescript
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  // ... fallback to x-api-key header
}

// 使用统一 API Key 验证
const token = extractApiToken(req);
const unifiedKey = getUnifiedApiKey();
if (!token || !timingSafeStringEqual(token, unifiedKey)) {
  res.status(401).json({ error: { message: 'Invalid API key' } });
  return;
}
```

Codex 发来的请求携带的是网关的统一 API Key（`Authorization: Bearer freellmapi-xxx`），需要验证后替换为 `myopenai` 的真实 OpenAI API Key。

#### 2.2.4 代理机制

文件 `server/src/lib/proxy.ts`：

```typescript
export async function proxyFetch(
  url: string,
  init?: RequestInit,
  platform?: string,
): Promise<Response>
```

`proxyFetch` 会根据代理配置和 bypass 列表决定是否通过代理发送请求。compact 转发也应使用 `proxyFetch`。

### 2.3 结论

**完全可行。** Codex 的 compaction 端点是一个标准的 unary HTTP POST，请求/响应都是普通 JSON。网关只需：

1. 接收 Codex 的请求
2. 验证统一 API Key
3. 从 DB 查找 `myopenai` provider 的真实 key 和 base_url
4. 替换 Authorization header，透传请求体，转发到 `{base_url}/responses/compact`
5. 返回上游响应
6. 记录日志

---

## 3. 设计方案

### 3.1 整体流程

```
Codex CLI                     你的网关                          真实 OpenAI
   |                             |                                |
   |  POST /v1/responses/compact |                                |
   |  Authorization: Bearer      |                                |
   |    {统一API Key}             |                                |
   |  Body: { model, input, ... }|                                |
   |---------------------------->|                                |
   |                             | 1. 验证统一 API Key             |
   |                             | 2. 查 DB: myopenai provider    |
   |                             |    → 取 base_url + 解密 api_key |
   |                             | 3. POST {base_url}/responses/compact
   |                             |    Authorization: Bearer {真实key}
   |                             |    Body: 透传                   |
   |                             |------------------------------>|
   |                             |                                |
   |                             |  4. 返回 { output: [...] }     |
   |                             |<------------------------------|
   |                             | 5. 记录到 logs/compact.log     |
   |                             |    控制台打印简短日志           |
   |  6. 透传响应体               |                                |
   |<----------------------------|                                |
```

### 3.2 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/src/routes/responses.ts` | 修改 | 新增 `POST /responses/compact` 端点 |
| `server/src/lib/compact-logger.ts` | 新建 | compact 日志记录模块 |
| `.gitignore` | 无需修改 | `server/logs/` 已在上一轮添加 |

### 3.3 新增端点：`POST /responses/compact`

在 `server/src/routes/responses.ts` 文件末尾新增：

```typescript
// ── Compaction endpoint ────────────────────────────────────────────────────
// Codex CLI triggers context compaction by POSTing to /responses/compact.
// This is a unary (non-streaming) call that sends the full conversation
// history and expects a compressed version back. We forward it directly to
// the real OpenAI API using the "myopenai" custom provider's key + base_url.
responsesRouter.post('/responses/compact', async (req: Request, res: Response) => {
  // 1. Authenticate with the unified API key
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // 2. Look up the "myopenai" custom provider in the database
  const db = getDb();
  const keyRow = db.prepare(
    'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 LIMIT 1',
  ).get('myopenai') as any;

  if (!keyRow) {
    logCompact({
      timestamp: new Date().toISOString(),
      requestModel: req.body?.model ?? 'unknown',
      inputItemCount: Array.isArray(req.body?.input) ? req.body.input.length : 0,
      requestSize: Buffer.byteLength(JSON.stringify(req.body ?? {})),
      httpStatus: 401,
      outputItemCount: 0,
      responseSize: 0,
      latencyMs: 0,
      error: 'myopenai provider not found or disabled',
      requestBody: JSON.stringify(req.body),
      responseBody: '',
    });
    res.status(401).json({
      error: { message: 'Compaction provider (myopenai) not configured', type: 'configuration_error' },
    });
    return;
  }

  // 3. Decrypt the real API key
  let realApiKey: string;
  try {
    realApiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch {
    res.status(401).json({
      error: { message: 'Failed to decrypt myopenai API key', type: 'configuration_error' },
    });
    return;
  }

  // 4. Build the target URL
  const baseUrl = keyRow.base_url?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    res.status(400).json({
      error: { message: 'myopenai provider has no base_url configured', type: 'configuration_error' },
    });
    return;
  }
  const targetUrl = `${baseUrl}/responses/compact`;

  // 5. Forward the request — body is passed through unchanged
  const requestBody = JSON.stringify(req.body);
  const start = Date.now();

  try {
    const upstreamRes = await proxyFetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${realApiKey}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: AbortSignal.timeout(120_000), // compaction can take a while
    }, 'myopenai');

    const responseBody = await upstreamRes.text();
    const latencyMs = Date.now() - start;

    // Parse output count for logging (non-fatal if parse fails)
    let outputItemCount = 0;
    try {
      const parsed = JSON.parse(responseBody);
      if (Array.isArray(parsed.output)) outputItemCount = parsed.output.length;
    } catch { /* non-JSON response — log as-is */ }

    // 6. Log to compact.log
    logCompact({
      timestamp: new Date().toISOString(),
      requestModel: req.body?.model ?? 'unknown',
      inputItemCount: Array.isArray(req.body?.input) ? req.body.input.length : 0,
      requestSize: Buffer.byteLength(requestBody),
      httpStatus: upstreamRes.status,
      outputItemCount,
      responseSize: Buffer.byteLength(responseBody),
      latencyMs,
      error: upstreamRes.ok ? undefined : `HTTP ${upstreamRes.status}`,
      requestBody,
      responseBody,
    });

    // 7. Console log — one concise line
    console.log(
      `[compact] 远程压缩 model=${req.body?.model ?? '?'} inputItems=${Array.isArray(req.body?.input) ? req.body.input.length : 0} → ${upstreamRes.status} ${upstreamRes.statusText} outputItems=${outputItemCount} lat=${latencyMs}ms`,
    );

    // 8. Return the upstream response
    res.status(upstreamRes.status).set('Content-Type', 'application/json').send(responseBody);
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const errorMsg = err.message ?? 'network error';

    logCompact({
      timestamp: new Date().toISOString(),
      requestModel: req.body?.model ?? 'unknown',
      inputItemCount: Array.isArray(req.body?.input) ? req.body.input.length : 0,
      requestSize: Buffer.byteLength(requestBody),
      httpStatus: 0,
      outputItemCount: 0,
      responseSize: 0,
      latencyMs,
      error: errorMsg,
      requestBody,
      responseBody: '',
    });

    console.log(
      `[compact] 远程压缩失败 model=${req.body?.model ?? '?'} error=${errorMsg} lat=${latencyMs}ms`,
    );

    // Network error / timeout → return 400 to Codex
    res.status(400).json({
      error: { message: `Compaction request failed: ${errorMsg}`, type: 'api_error' },
    });
  }
});
```

### 3.4 新增日志模块：`server/src/lib/compact-logger.ts`

```typescript
/**
 * Compact logger — appends every /v1/responses/compact request to
 * logs/compact.log for evaluation and tracing. Unlike the console log
 * (which is a one-line summary), this file captures the FULL request
 * and response bodies so compaction quality can be evaluated offline.
 *
 * Format: JSON-lines (one JSON object per line).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_DIR = process.env.FREEAPI_LOG_DIR?.trim()
  || path.resolve(__dirname, '../../logs');

const COMPACT_LOG_PATH = path.join(LOG_DIR, 'compact.log');

// Ensure the directory exists synchronously on module load.
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // Non-fatal — the per-write call below will try again.
}

export interface CompactLogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Model requested in the compaction body */
  requestModel: string;
  /** Number of items in the input array */
  inputItemCount: number;
  /** Request body size in bytes */
  requestSize: number;
  /** HTTP status from upstream (0 = network error) */
  httpStatus: number;
  /** Number of items in the output array */
  outputItemCount: number;
  /** Response body size in bytes */
  responseSize: number;
  /** End-to-end latency in milliseconds */
  latencyMs: number;
  /** Error message if the request failed */
  error?: string;
  /** Full request body (JSON string) */
  requestBody: string;
  /** Full response body (JSON string, empty on network error) */
  responseBody: string;
}

/**
 * Append a compaction event to logs/compact.log.
 *
 * Safe to call from any catch block — never throws. If the file system
 * is unavailable the log entry is silently dropped.
 */
export function logCompact(entry: CompactLogEntry): void {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(COMPACT_LOG_PATH, line, { encoding: 'utf8' });
  } catch {
    // Swallow — the console log already informed the user.
  }
}
```

### 3.5 需要添加的 import

在 `server/src/routes/responses.ts` 顶部新增：

```typescript
import { decrypt } from '../lib/crypto.js';
import { getDb } from '../db/index.js';
import { proxyFetch } from '../lib/proxy.js';
import { logCompact } from '../lib/compact-logger.js';
```

同时需要从 `proxy.ts` 导入 `extractApiToken`、`timingSafeStringEqual`、`getUnifiedApiKey`：

```typescript
// 这些已从 ./proxy.js 导入（检查是否已存在）
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { getUnifiedApiKey } from '../db/index.js';
```

### 3.6 日志文件示例

#### compact.log（每行一个 JSON）

```json
{"timestamp":"2026-07-07T10:23:45.123Z","requestModel":"o3","inputItemCount":42,"requestSize":85632,"httpStatus":200,"outputItemCount":3,"responseSize":4521,"latencyMs":8234,"requestBody":"{\"model\":\"o3\",\"input\":[...],\"instructions\":\"...\"}","responseBody":"{\"output\":[...]}"}
{"timestamp":"2026-07-07T10:25:01.456Z","requestModel":"o3","inputItemCount":38,"requestSize":78234,"httpStatus":200,"outputItemCount":3,"responseSize":4102,"latencyMs":7890,"requestBody":"{...}","responseBody":"{...}"}
```

查看日志：

```bash
# 查看最近 10 条压缩记录
tail -10 server/logs/compact.log | jq .

# 统计压缩效果
cat server/logs/compact.log | jq -s '
  | map({
      timestamp,
      model: .requestModel,
      inputItems: .inputItemCount,
      outputItems: .outputItemCount,
      compressionRatio: (.outputItemCount / .inputItemCount),
      latencyMs
    })
'
```

#### 控制台输出

```
[compact] 远程压缩 model=o3 inputItems=42 → 200 OK outputItems=3 lat=8234ms
[compact] 远程压缩失败 model=o3 error=timeout lat=120001ms
```

---

## 4. 关键设计决策

| 决策点 | 方案 | 原因 |
|--------|------|------|
| 查找 myopenai key | `SELECT * FROM api_keys WHERE platform='myopenai' AND enabled=1 LIMIT 1` | 自定义 provider 的 platform 就是用户定义的名字 |
| 转发 URL | `{base_url}/responses/compact` | Codex 的 `url_for_path()` 是 `base_url.trim_end('/') + '/' + path.trim_start('/')` |
| 请求体 | 完全透传 `req.body` | Codex 的 compaction 请求体格式和标准 Responses API 一致，OpenAI 原生支持 |
| Authorization | 替换为 myopenai 的真实 key | 统一 API Key 对 OpenAI 无效，必须用真实 key |
| 失败处理 | 上游 4xx → 透传上游状态码；网络错误/超时 → 返回 400 | 按需求，查不到或调用错误返回 400/401 |
| compact.log 内容 | 完整请求体 + 完整响应体 + 元数据 | 用于后续评估 compaction 效果 |
| 控制台 | 一行简短摘要 | 避免刷屏，用户只需知道触发了压缩 |
| 超时 | 120 秒 | compaction 是大模型推理，可能耗时 30-60 秒 |

---

## 5. 注意事项

### 5.1 base_url 必须包含 /v1

`myopenai` provider 的 `base_url` 应为 `https://api.openai.com/v1`（包含 `/v1`）。如果填的是 `https://api.openai.com`（不含 `/v1`），则转发 URL 会变成 `https://api.openai.com/responses/compact`，OpenAI 会返回 404。

代码中直接使用 `base_url + '/responses/compact'`，不做任何路径补全，与 Codex CLI 的行为一致。

### 5.2 请求体大小

compaction 请求包含完整对话历史，可能很大（10MB+）。网关已设置 `express.json({ limit: '10mb' })`，应该够用。如果遇到 413 错误，可能需要调大这个限制。

### 5.3 非 OpenAI provider 不支持

`/responses/compact` 是 OpenAI 专有端点。如果 `myopenai` 指向的不是真实 OpenAI API（而是其他第三方），该端点可能不存在，会返回 404。这种情况下网关会把 404 透传给 Codex，Codex 会将 compaction 视为失败。

### 5.4 myopenai provider 未配置时的行为

如果数据库中找不到 `platform='myopenai'` 的记录，或该 key 被 disabled，网关返回 401。Codex 会将 compaction 视为失败，但不影响正常对话（`/v1/responses` 不受影响）。

### 5.5 与现有 /v1/responses 的关系

`POST /v1/responses/compact` 和 `POST /v1/responses` 是两个完全独立的端点。compact 端点不经过路由器（router）、不触发 fallback、不计速率限制、不触发冷却。它是一个简单的透传代理。

### 5.6 日志文件增长

`compact.log` 会持续增长，因为它记录了完整的请求和响应体。建议定期清理或使用 logrotate。后续可以考虑添加日志轮转功能（如按日期分割、限制最大文件大小等）。

---

## 6. 实现步骤

1. 新建 `server/src/lib/compact-logger.ts`
2. 在 `server/src/routes/responses.ts` 中：
   - 添加必要的 import
   - 在文件末尾添加 `POST /responses/compact` 端点
3. 运行 `tsc --noEmit` 确认编译通过
4. 运行测试确认无回归
5. 手动测试：用 curl 模拟 Codex 发送 compaction 请求
