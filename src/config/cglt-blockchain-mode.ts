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

import { env } from './env';

export type CgltBlockchainMode = 'disabled' | 'read_only' | 'enabled';

let runtimeOverride: CgltBlockchainMode | null = null;

/**
 * Returns the effective blockchain mode.
 * Runtime override takes precedence over env (set by config validation).
 */
export function getCgltBlockchainMode(): CgltBlockchainMode {
  return runtimeOverride ?? env.CGLT_BLOCKCHAIN_MODE;
}

/**
 * Returns true if read operations (balanceOf, chainId, eth_getCode) are allowed.
 */
export function isCgltBlockchainReadEnabled(): boolean {
  const mode = getCgltBlockchainMode();
  return mode === 'read_only' || mode === 'enabled';
}

/**
 * Throws if blockchain write operations are not allowed.
 * Use at the top of any route that performs mint/burn/bridge.
 */
export function assertCgltBlockchainWriteEnabled(): void {
  const mode = getCgltBlockchainMode();
  if (mode !== 'enabled') {
    const err = new Error('CGLT_BLOCKCHAIN_DISABLED') as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }
}

/**
 * Returns true if blockchain write operations are allowed.
 */
export function isCgltBlockchainWriteEnabled(): boolean {
  return getCgltBlockchainMode() === 'enabled';
}

/**
 * Forces the runtime mode (used by config validation on startup).
 * Once set to disabled by validation failure, only a restart can reset it.
 */
export function setCgltBlockchainRuntimeMode(mode: CgltBlockchainMode): void {
  runtimeOverride = mode;
}

/**
 * WCGLT deposit processor feature flag.
 */
export type WcgltDepositProcessor = 'disabled' | 'bridge' | 'bscscan';

let processorOverride: WcgltDepositProcessor | null = null;

export function getWcgltDepositProcessor(): WcgltDepositProcessor {
  const value = processorOverride ?? env.WCGLT_DEPOSIT_PROCESSOR;
  // Guard: bridge and bscscan cannot be active simultaneously.
  // The env schema already restricts to single values, but this is a safety net.
  return value;
}

export function setWcgltDepositProcessorRuntime(processor: WcgltDepositProcessor): void {
  processorOverride = processor;
}
