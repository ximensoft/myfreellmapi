import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { hasProvider, resolveProvider } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { getActiveCooldownsForKeys, clearCooldownsForKey } from '../services/ratelimit.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
// SambaNova was dropped in V23 (free tier permanently retired).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aihorde', 'custom',
] as const;

// Built-in platform names that custom providers must NOT collide with.
const BUILTIN_PLATFORMS = new Set<string>(PLATFORMS.filter(p => p !== 'custom'));

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  anthropicBaseUrl: z.string().nullable().optional(),
}).refine(data =>
  data.enabled !== undefined ||
  data.label !== undefined ||
  data.apiKey !== undefined ||
  data.baseUrl !== undefined ||
  data.anthropicBaseUrl !== undefined,
  { message: 'At least one of enabled, label, apiKey, baseUrl, or anthropicBaseUrl must be provided' },
);

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const customModels = [
    ...db.prepare(`
      SELECT key_id, id, 'chat' AS kind, model_id, display_name, NULL AS family
        FROM models
       WHERE is_custom = 1 AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, 'embedding' AS kind, model_id, display_name, family
        FROM embedding_models
       WHERE is_custom = 1 AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, modality AS kind, model_id, display_name, NULL AS family
        FROM media_models
       WHERE is_custom = 1 AND key_id IS NOT NULL
    `).all() as any[],
  ];
  const modelsByKeyId = new Map<number, any[]>();
  for (const m of customModels) {
    const keyId = Number(m.key_id);
    if (!Number.isInteger(keyId)) continue;
    const list = modelsByKeyId.get(keyId) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      modelId: m.model_id,
      displayName: m.display_name,
      family: m.family ?? null,
    });
    modelsByKeyId.set(keyId, list);
  }
  for (const list of modelsByKeyId.values()) {
    list.sort((a, b) => {
      const ka = ['chat', 'embedding', 'image', 'audio'].indexOf(a.kind);
      const kb = ['chat', 'embedding', 'image', 'audio'].indexOf(b.kind);
      return (ka - kb) || String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  // Fetch active cooldowns for all keys
  const keyIdPlatforms = rows.map(row => ({ id: row.id, platform: row.platform }));
  const cooldowns = getActiveCooldownsForKeys(keyIdPlatforms);
  // Group cooldowns by key: "platform:keyId" → array of cooldown entries
  const cooldownsByKey = new Map<string, typeof cooldowns>();
  for (const c of cooldowns) {
    const key = `${c.platform}:${c.keyId}`;
    const list = cooldownsByKey.get(key) ?? [];
    list.push(c);
    cooldownsByKey.set(key, list);
  }

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    const keyCooldowns = cooldownsByKey.get(`${row.platform}:${row.id}`) ?? [];
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      anthropicBaseUrl: row.anthropic_base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      isCustom: row.is_custom === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
      models: row.is_custom === 1 ? (modelsByKeyId.get(row.id) ?? []) : undefined,
      cooldowns: keyCooldowns.length > 0 ? keyCooldowns.map(c => ({
        modelId: c.modelId,
        remainingMs: c.remainingMs,
      })) : undefined,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;
  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  const db = getDb();

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(keyToStore),
    status: 'unknown',
    enabled: true,
  });
});

// ── Custom OpenAI-compatible providers (#117, #212) ───────────────────────
// User-configured endpoints (llama.cpp / LM Studio / vLLM / Ollama / any
// OpenAI-compatible base_url). Each DISTINCT base_url gets its own 'custom'
// api_keys row, and every registered model binds to its endpoint's key via
// models.key_id — so several custom providers coexist without overwriting
// each other (#212). Re-submitting an existing base_url updates its key/label;
// re-registering an existing model id re-binds it to the submitted endpoint.
// A model can be given as a bare id ("qwen3:4b") or as {model, displayName}.
// `model`/`displayName` (singular) stay supported for older clients; `models`
// (plural) lets one submit bind several model ids to the same endpoint. (#281)
const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), displayName: z.string().optional() }),
]);
const customProviderSchema = z.object({
  providerName: z.string().min(1).max(60).regex(/^[a-zA-Z0-9_-]+$/, 'Provider name must contain only letters, numbers, hyphens, and underscores').default('custom'),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  anthropicBaseUrl: z.string().url('anthropicBaseUrl must be a valid URL').optional(),
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
}).refine(
  d => (d.model && d.model.trim().length > 0) || (d.models && d.models.length > 0),
  { message: 'model or models is required' },
);

keysRouter.post('/custom', (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const providerName = parsed.data.providerName.trim();
  // Validate: provider name must not collide with a built-in platform
  if (BUILTIN_PLATFORMS.has(providerName)) {
    res.status(400).json({ error: { message: `Provider name '${providerName}' is reserved for built-in platform. Choose a different name.` } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const anthropicBaseUrl = parsed.data.anthropicBaseUrl?.trim().replace(/\/+$/, '') || null;
  // Local servers often need no key; keep a sentinel so there's always a bearer.
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;

  // Flatten singular + plural inputs into one list, dedupe by model id, drop
  // blanks. The singular `displayName` only applies to a lone `model` (it can't
  // sensibly fan out across many ids).
  const entries: { modelId: string; displayName: string }[] = [];
  const seen = new Set<string>();
  const addEntry = (rawId: string, rawDisplay?: string) => {
    const modelId = rawId.trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    entries.push({ modelId, displayName: (rawDisplay?.trim() || modelId) });
  };
  if (parsed.data.model?.trim()) addEntry(parsed.data.model, parsed.data.displayName);
  for (const m of parsed.data.models ?? []) {
    if (typeof m === 'string') addEntry(m);
    else addEntry(m.model, m.displayName);
  }

  if (entries.length === 0) {
    res.status(400).json({ error: { message: 'model or models is required' } });
    return;
  }

  const db = getDb();
  const upsert = db.transaction(() => {
    // One key row per (platform, base_url). Re-submitting the same provider
    // name + endpoint updates its key/label; a new base_url gets its own row
    // instead of clobbering the previous provider. (#212) Re-submitting with a
    // blank key preserves the stored key; only a provided key updates credentials.
    const existing = db.prepare('SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND base_url = ? AND is_custom = 1 LIMIT 1')
      .get(providerName, baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
    let keyId: number;
    let storedKeyForMask = providedKey ?? 'no-key';
    if (existing) {
      keyId = existing.id;
      if (providedKey) {
        const { encrypted, iv, authTag } = encrypt(providedKey);
        db.prepare("UPDATE api_keys SET label = COALESCE(?, label), encrypted_key = ?, iv = ?, auth_tag = ?, anthropic_base_url = ?, status = 'unknown', enabled = 1 WHERE id = ?")
          .run(label ?? null, encrypted, iv, authTag, anthropicBaseUrl, existing.id);
        storedKeyForMask = providedKey;
      } else {
        try {
          storedKeyForMask = decrypt(existing.encrypted_key, existing.iv, existing.auth_tag);
        } catch {
          storedKeyForMask = 'no-key';
        }
        db.prepare("UPDATE api_keys SET label = COALESCE(?, label), anthropic_base_url = ?, status = 'unknown', enabled = 1 WHERE id = ?")
          .run(label ?? null, anthropicBaseUrl, existing.id);
      }
    } else {
      const keyToStore = providedKey ?? 'no-key';
      const { encrypted, iv, authTag } = encrypt(keyToStore);
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, is_custom, anthropic_base_url)
        VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?, 1, ?)
      `).run(providerName, label ?? providerName, encrypted, iv, authTag, baseUrl, anthropicBaseUrl);
      keyId = Number(r.lastInsertRowid);
      storedKeyForMask = keyToStore;
    }

    const registered: { modelDbId: number; model: string; displayName: string }[] = [];
    for (const { modelId, displayName } of entries) {
      // Register each model bound to THIS endpoint's key. Custom models carry no
      // rate limits and sort last in the intelligence preset (size_label tier).
      // Re-registering an existing model id re-binds it (model ids are unique
      // per platform, so one id can't live on two endpoints at once).
      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id, is_custom)
        VALUES (?, ?, ?, 50, 50, 'Custom', NULL, NULL, NULL, NULL, '', NULL, 1, ?, 1)
        ON CONFLICT(platform, model_id)
        DO UPDATE SET display_name = excluded.display_name, key_id = excluded.key_id, enabled = 1
      `).run(providerName, modelId, displayName, keyId);

      const modelRow = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(providerName, modelId) as { id: number };

      // Append to the fallback chain if not already present.
      const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
      if (!inChain) {
        const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
      }

      // Also add to every profile's profile_models so the custom model is
      // visible when an active profile is in use (getActiveChain reads from
      // profile_models, not fallback_config — missing rows mean the model is
      // invisible to the router).
      const profiles = db.prepare('SELECT id FROM profiles').all() as { id: number }[];
      for (const profile of profiles) {
        const inProfile = db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profile.id, modelRow.id);
        if (!inProfile) {
          const maxP = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM profile_models WHERE profile_id = ?').get(profile.id) as { m: number };
          db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(profile.id, modelRow.id, maxP.m + 1);
        }
      }

      registered.push({ modelDbId: modelRow.id, model: modelId, displayName });
    }

    return { keyId, registered, storedKeyForMask };
  });

  const { keyId, registered, storedKeyForMask } = upsert();
  // `model`/`displayName`/`modelDbId` echo the first model for older clients;
  // `models` carries the full set registered in this call.
  const first = registered[0]!;
  res.status(201).json({
    success: true,
    keyId,
    modelDbId: first.modelDbId,
    platform: providerName,
    baseUrl,
    model: first.model,
    displayName: first.displayName,
    models: registered,
    maskedKey: maskKey(storedKeyForMask),
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform, is_custom FROM api_keys WHERE id = ?').get(id) as { platform: string; is_custom: number } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    // Custom models exist only because POST /custom registered them alongside
    // their endpoint key (#117) — they can't route without it. Cascade away
    // the models bound to THIS endpoint (#212); other custom providers keep
    // theirs. Legacy rows (key_id NULL) are swept once no custom keys remain,
    // so they never linger in the fallback chain forever (#189).
    if (row.is_custom === 1) {
      const defaultEmbedding = db.prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get() as { value: string } | undefined;
      // Collect model db ids before deleting so profile_models can be cleaned up too.
      const customModelIds = db.prepare('SELECT id FROM models WHERE is_custom = 1 AND key_id = ?').all(id) as { id: number }[];
      db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE is_custom = 1 AND key_id = ?)').run(id);
      db.prepare('DELETE FROM models WHERE is_custom = 1 AND key_id = ?').run(id);
      db.prepare('DELETE FROM embedding_models WHERE is_custom = 1 AND key_id = ?').run(id);
      db.prepare('DELETE FROM media_models WHERE is_custom = 1 AND key_id = ?').run(id);
      // Remove from all profiles' profile_models as well.
      const deleteFromProfile = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
      for (const m of customModelIds) deleteFromProfile.run(m.id);
      // If no more custom keys for this platform remain, clean up any orphaned
      // custom models that were bound to this platform (legacy rows with key_id NULL).
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE platform = ? AND is_custom = 1').get(row.platform) as { n: number };
      if (remaining.n === 0) {
        const allCustomModelIds = db.prepare('SELECT id FROM models WHERE is_custom = 1 AND platform = ?').all(row.platform) as { id: number }[];
        db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE is_custom = 1 AND platform = ?)').run(row.platform);
        db.prepare('DELETE FROM models WHERE is_custom = 1 AND platform = ?').run(row.platform);
        db.prepare('DELETE FROM embedding_models WHERE is_custom = 1 AND platform = ?').run(row.platform);
        db.prepare('DELETE FROM media_models WHERE is_custom = 1 AND platform = ?').run(row.platform);
        for (const m of allCustomModelIds) deleteFromProfile.run(m.id);
      }
      if (defaultEmbedding) {
        const stillExists = db.prepare('SELECT 1 FROM embedding_models WHERE family = ? LIMIT 1').get(defaultEmbedding.value);
        if (!stillExists) {
          const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
          if (replacement) {
            db.prepare("UPDATE settings SET value = ? WHERE key = 'embeddings_default_family'").run(replacement.family);
          }
        }
      }
    }
  });
  remove();

  res.json({ success: true });
});

// Clear all cooldowns for a key (manual unlock from the dashboard)
keysRouter.delete('/:id/cooldowns', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const cleared = clearCooldownsForKey(row.platform, id);
  res.json({ success: true, cleared });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Update key (toggle enable/disable, edit label, or update credentials/URL for custom keys)
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label, apiKey, baseUrl, anthropicBaseUrl } = parsed.data;
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }
  if (baseUrl !== undefined) {
    updates.push('base_url = ?');
    values.push(baseUrl.trim().replace(/\/+$/, ''));
  }
  if (anthropicBaseUrl !== undefined) {
    updates.push('anthropic_base_url = ?');
    values.push(anthropicBaseUrl ? anthropicBaseUrl.trim().replace(/\/+$/, '') : null);
  }
  if (apiKey !== undefined) {
    const keyToStore = apiKey.trim() || 'no-key';
    const { encrypted, iv, authTag } = encrypt(keyToStore);
    updates.push('encrypted_key = ?', 'iv = ?', 'auth_tag = ?', "status = 'unknown'");
    values.push(encrypted, iv, authTag);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});
