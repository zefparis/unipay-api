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
export type CgltBlockchainMode = 'disabled' | 'read_only' | 'enabled';
/**
 * Returns the effective blockchain mode.
 * Runtime override takes precedence over env (set by config validation).
 */
export declare function getCgltBlockchainMode(): CgltBlockchainMode;
/**
 * Returns true if read operations (balanceOf, chainId, eth_getCode) are allowed.
 */
export declare function isCgltBlockchainReadEnabled(): boolean;
/**
 * Throws if blockchain write operations are not allowed.
 * Use at the top of any route that performs mint/burn/bridge.
 */
export declare function assertCgltBlockchainWriteEnabled(): void;
/**
 * Returns true if blockchain write operations are allowed.
 */
export declare function isCgltBlockchainWriteEnabled(): boolean;
/**
 * Forces the runtime mode (used by config validation on startup).
 * Once set to disabled by validation failure, only a restart can reset it.
 */
export declare function setCgltBlockchainRuntimeMode(mode: CgltBlockchainMode): void;
/**
 * WCGLT deposit processor feature flag.
 */
export type WcgltDepositProcessor = 'disabled' | 'bridge' | 'bscscan';
export declare function getWcgltDepositProcessor(): WcgltDepositProcessor;
export declare function setWcgltDepositProcessorRuntime(processor: WcgltDepositProcessor): void;
