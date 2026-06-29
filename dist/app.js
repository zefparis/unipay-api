"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const server_1 = require("./server");
const env_1 = require("./config/env");
const bscscan_1 = require("./services/bscscan");
const gas_monitor_1 = require("./services/gas-monitor");
const start = async () => {
    const server = await (0, server_1.buildServer)();
    try {
        await server.listen({ port: parseInt(env_1.env.PORT), host: '0.0.0.0' });
        // Start BSC deposit poller (no-op when BSCSCAN_API_KEY or UNIPAY_HD_WALLET_MNEMONIC absent)
        (0, bscscan_1.startBscPoller)(server.supabase, { info: server.log.info.bind(server.log), error: server.log.error.bind(server.log) });
        // Start BSC gas monitor (no-op when HOT_WALLET_USDT_PRIVATE_KEY absent)
        (0, gas_monitor_1.startGasMonitor)({ info: server.log.info.bind(server.log), warn: server.log.warn.bind(server.log), error: server.log.error.bind(server.log) });
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    process.exit(1);
});
start();
//# sourceMappingURL=app.js.map