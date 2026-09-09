import 'dotenv/config';
import { buildServer } from './server';
import { env } from './config/env';
import { startBscPoller } from './services/bscscan';
import { startGasMonitor } from './services/gas-monitor';
import { startOnchainReconciler } from './services/onchain-reconciliation';

/**
 * Fail-closed check: in production, FIXIE_URL is required for Unipesa/Avada
 * payment calls that rely on IP whitelisting. Without it, the service would
 * silently fall back to a direct connection and get rejected by the whitelist
 * — or worse, work unpredictably if the whitelist is not strict.
 *
 * The per-call guard in avada.ts/unipesa.ts throws FIXIE_PROXY_REQUIRED
 * regardless of NODE_ENV. This boot check is an early, loud failure so the
 * service never starts in a broken state in production.
 */
function assertFixieConfigured(): void {
  const skip = env.UNIPESA_SKIP_FIXIE_CHECK === '1' || env.UNIPESA_SKIP_FIXIE_CHECK === 'true';
  if (skip) {
    console.warn('[WARN] UNIPESA_SKIP_FIXIE_CHECK is set — Unipesa/Avada calls will bypass the Fixie proxy. This must NEVER be used in production.');
    return;
  }
  if (env.NODE_ENV === 'production' && !env.FIXIE_URL) {
    console.error('[FATAL] FIXIE_URL is not set in production. Unipesa/Avada payment calls require a whitelisted egress IP. Refusing to start.');
    process.exit(1);
  }
  if (env.NODE_ENV !== 'production' && !env.FIXIE_URL) {
    console.warn('[WARN] FIXIE_URL is not set — Unipesa/Avada calls will throw FIXIE_PROXY_REQUIRED at call time. Set UNIPESA_SKIP_FIXIE_CHECK=1 for local dev/mock only.');
  }
}

const start = async () => {
  assertFixieConfigured();
  const server = await buildServer();

  try {
    await server.listen({ port: parseInt(env.PORT), host: '0.0.0.0' });
    // Start BSC deposit poller (no-op when BSCSCAN_API_KEY or UNIPAY_HD_WALLET_MNEMONIC absent)
    startBscPoller(server.supabase, { info: server.log.info.bind(server.log), error: server.log.error.bind(server.log) });
    // Start BSC gas monitor (no-op when BSC_OWNER_KEY absent)
    startGasMonitor({ info: server.log.info.bind(server.log), warn: server.log.warn.bind(server.log), error: server.log.error.bind(server.log) });
    startOnchainReconciler(server.supabase, server.log);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

start();
