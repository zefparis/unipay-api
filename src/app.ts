import 'dotenv/config';
import { buildServer } from './server';
import { env } from './config/env';
import { startBscPoller } from './services/bscscan';
import { startGasMonitor } from './services/gas-monitor';

const start = async () => {
  const server = await buildServer();

  try {
    await server.listen({ port: parseInt(env.PORT), host: '0.0.0.0' });
    // Start BSC deposit poller (no-op when BSCSCAN_API_KEY or UNIPAY_HD_WALLET_MNEMONIC absent)
    startBscPoller(server.supabase, { info: server.log.info.bind(server.log), error: server.log.error.bind(server.log) });
    // Start BSC gas monitor (no-op when HOT_WALLET_USDT_PRIVATE_KEY absent)
    startGasMonitor({ info: server.log.info.bind(server.log), warn: server.log.warn.bind(server.log), error: server.log.error.bind(server.log) });
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
