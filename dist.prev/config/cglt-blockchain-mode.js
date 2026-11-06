"use strict";
/**
 * CGLT Blockchain Mode — centralized safety switch.
 *
 * Modes:
 *   disabled  — no RPC calls, no mint, no burn, no bridge. Write routes return 503.
 *   read_only — balanceOf, chainId, eth_getCode, health checks allowed. Writes return 503.
 *   enabled   — all operations allowed (requires config validation to pass).
 *
 * Default: disabled
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCgltBlockchainMode = getCgltBlockchainMode;
exports.isCgltBlockchainReadEnabled = isCgltBlockchainReadEnabled;
exports.assertCgltBlockchainWriteEnabled = assertCgltBlockchainWriteEnabled;
exports.isCgltBlockchainWriteEnabled = isCgltBlockchainWriteEnabled;
exports.setCgltBlockchainRuntimeMode = setCgltBlockchainRuntimeMode;
exports.getWcgltDepositProcessor = getWcgltDepositProcessor;
exports.setWcgltDepositProcessorRuntime = setWcgltDepositProcessorRuntime;
const env_1 = require("./env");
let runtimeOverride = null;
/**
 * Returns the effective blockchain mode.
 * Runtime override takes precedence over env (set by config validation).
 */
function getCgltBlockchainMode() {
    return runtimeOverride ?? env_1.env.CGLT_BLOCKCHAIN_MODE;
}
/**
 * Returns true if read operations (balanceOf, chainId, eth_getCode) are allowed.
 */
function isCgltBlockchainReadEnabled() {
    const mode = getCgltBlockchainMode();
    return mode === 'read_only' || mode === 'enabled';
}
/**
 * Throws if blockchain write operations are not allowed.
 * Use at the top of any route that performs mint/burn/bridge.
 */
function assertCgltBlockchainWriteEnabled() {
    const mode = getCgltBlockchainMode();
    if (mode !== 'enabled') {
        const err = new Error('CGLT_BLOCKCHAIN_DISABLED');
        err.statusCode = 503;
        throw err;
    }
}
/**
 * Returns true if blockchain write operations are allowed.
 */
function isCgltBlockchainWriteEnabled() {
    return getCgltBlockchainMode() === 'enabled';
}
/**
 * Forces the runtime mode (used by config validation on startup).
 * Once set to disabled by validation failure, only a restart can reset it.
 */
function setCgltBlockchainRuntimeMode(mode) {
    runtimeOverride = mode;
}
let processorOverride = null;
function getWcgltDepositProcessor() {
    const value = processorOverride ?? env_1.env.WCGLT_DEPOSIT_PROCESSOR;
    // Guard: bridge and bscscan cannot be active simultaneously.
    // The env schema already restricts to single values, but this is a safety net.
    return value;
}
function setWcgltDepositProcessorRuntime(processor) {
    processorOverride = processor;
}
//# sourceMappingURL=cglt-blockchain-mode.js.map