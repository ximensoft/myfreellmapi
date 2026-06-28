import './env.js';
import { createApp } from './app.js';
import { initDb, getDb, getSetting } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyBypass } from './lib/proxy.js';
import { startCatalogSync } from './services/catalog-sync.js';
import { installProcessSafetyNet } from './lib/process-safety-net.js';
import { NodeScheduler } from './lib/scheduler.js';
import { loadConfig } from './lib/config.js';
import { applyDeclarativeConfigFromEnv } from './services/declarative-config.js';
import { restoreDbBackupIfNeeded, startDbBackupPump } from './lib/db-backup.js';

async function main() {
  const config = loadConfig();
  const { port: PORT, host: HOST } = config;

  // Install first so a late provider socket reset (undici HTTP/2 error with no
  // listener) can't take the proxy down. Genuine bugs still exit 1.
  installProcessSafetyNet();

  const scheduler = new NodeScheduler();

  if (config.dbPath) {
    await restoreDbBackupIfNeeded(config.dbPath);
  } else {
    await restoreDbBackupIfNeeded();
  }
  initDb(config.dbPath ?? undefined);
  applyDeclarativeConfigFromEnv();

  // Load the persisted proxy settings from the DB (env var wins if set).
  // Must happen after initDb so the settings table is ready.
  applyProxyUrl(getSetting('proxy_url') ?? '');
  applyProxyEnabled(getSetting('proxy_enabled') !== '0'); // default: enabled
  applyProxyBypass(getSetting('proxy_bypass') ?? '');

  // Debug: log custom model counts in fallback_config vs profile_models
  // so mis-sync (custom models missing from the active profile) is visible at boot.
  {
    const db = getDb();
    const customInFc = db.prepare(
      "SELECT COUNT(*) AS cnt FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id WHERE m.platform = 'custom' AND m.enabled = 1",
    ).get() as { cnt: number };
    const customInPm = db.prepare(
      "SELECT COUNT(*) AS cnt FROM profile_models pm JOIN models m ON m.id = pm.model_db_id WHERE m.platform = 'custom' AND m.enabled = 1",
    ).get() as { cnt: number };
    const ap = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
    console.log(`[boot] custom models — fallback_config: ${customInFc.cnt}, profile_models: ${customInPm.cnt}, active_profile_id: ${ap?.value ?? 'none'}`);
    if (customInFc.cnt > customInPm.cnt) {
      console.log(`[boot] WARNING: ${customInFc.cnt - customInPm.cnt} custom model(s) in fallback_config but NOT in profile_models — they will be invisible to the auto router!`);
    }
  }

  const app = createApp(config);

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker(scheduler);
    startCatalogSync(scheduler);
    startDbBackupPump(getDb(), scheduler, config.dbPath ?? undefined);
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
