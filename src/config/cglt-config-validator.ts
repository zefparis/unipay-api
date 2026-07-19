/**
 * CGLT configuration validator — runs at startup.
 *
 * Checks blockchain configuration without revealing secrets.
 * If validation fails, forces CGLT_BLOCKCHAIN_MODE=disabled at runtime.
 * Does NOT stop the server — fiat/mobile money functions remain available.
 */

import { env } from './env';
import {
  getCgltBlockchainMode,
  setCgltBlockchainRuntimeMode,
  setWcgltDepositProcessorRuntime,
  type CgltBlockchainMode,
} from './cglt-blockchain-mode';

export interface CgltConfigValidation {
  mode: CgltBlockchainMode;
  chain_id_expected: number;
  chain_id_actual: number | null;
  rpc_reachable: boolean;
  cglt_contract_configured: boolean;
  cglt_contract_has_code: boolean;
  wcglt_contract_configured: boolean;
  wcglt_contract_has_code: boolean;
  bridge_reachable: boolean;
  bridge_endpoint_compatible: boolean;
  configuration_valid: boolean;
  errors: string[];
}

let lastValidation: CgltConfigValidation | null = null;

export function getLastCgltConfigValidation(): CgltConfigValidation | null {
  return lastValidation;
}

/**
 * Validates CGLT blockchain configuration at startup.
 * Does NOT throw — logs errors and forces disabled mode on failure.
 */
export async function validateCgltConfig(log?: { info: (msg: object, fmt?: string) => void; error: (msg: object, fmt?: string) => void; warn: (msg: object, fmt?: string) => void }): Promise<CgltConfigValidation> {
  const errors: string[] = [];
  const expectedChainId = parseInt(env.CGLT_CHAIN_ID, 10);

  let chainIdActual: number | null = null;
  let rpcReachable = false;
  let cgltContractConfigured = !!env.CGLT_CONTRACT_ADDRESS;
  let cgltContractHasCode = false;
  let wcgltContractConfigured = !!env.BSC_WCGLT_ADDRESS;
  let wcgltContractHasCode = false;
  let bridgeReachable = false;
  let bridgeEndpointCompatible = false;

  // Only attempt RPC checks if mode is not disabled
  const currentMode = getCgltBlockchainMode();
  if (currentMode === 'disabled') {
    // Skip RPC checks when disabled — nothing to validate on-chain
    lastValidation = {
      mode: 'disabled',
      chain_id_expected: expectedChainId,
      chain_id_actual: null,
      rpc_reachable: false,
      cglt_contract_configured: cgltContractConfigured,
      cglt_contract_has_code: false,
      wcglt_contract_configured: wcgltContractConfigured,
      wcglt_contract_has_code: false,
      bridge_reachable: false,
      bridge_endpoint_compatible: false,
      configuration_valid: true, // disabled mode is always "valid" (no expectations)
      errors: [],
    };
    return lastValidation;
  }

  // ── Check 1: CGLT_NODE_URL present ──
  if (!env.CGLT_NODE_URL) {
    errors.push('CGLT_NODE_URL not configured');
  } else {
    // ── Check 2: chainId matches expected ──
    try {
      const response = await fetch(env.CGLT_NODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json() as { result?: string };
        if (data.result) {
          chainIdActual = parseInt(data.result, 16);
          rpcReachable = true;
          if (chainIdActual !== expectedChainId) {
            errors.push(`chainId mismatch: expected ${expectedChainId}, got ${chainIdActual}`);
          }
        }
      }
    } catch {
      errors.push('CGLT_NODE_URL unreachable');
    }
  }

  // ── Check 3: CGLT_CONTRACT_ADDRESS present ──
  if (!cgltContractConfigured) {
    errors.push('CGLT_CONTRACT_ADDRESS not configured');
  } else if (rpcReachable && env.CGLT_NODE_URL) {
    // ── Check 4: eth_getCode != 0x ──
    try {
      const response = await fetch(env.CGLT_NODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [env.CGLT_CONTRACT_ADDRESS, 'latest'], id: 2 }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json() as { result?: string };
      if (data.result && data.result !== '0x') {
        cgltContractHasCode = true;
      } else {
        errors.push('CGLT_CONTRACT_ADDRESS has no bytecode on-chain');
      }
    } catch {
      errors.push('Failed to check CGLT_CONTRACT_ADDRESS bytecode');
    }
  }

  // ── Check 5: BSC_WCGLT_ADDRESS present ──
  if (!wcgltContractConfigured) {
    errors.push('BSC_WCGLT_ADDRESS not configured');
  } else {
    // ── Check 6: BSC bytecode present ──
    try {
      const response = await fetch(env.BSC_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [env.BSC_WCGLT_ADDRESS, 'latest'], id: 3 }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json() as { result?: string };
      if (data.result && data.result !== '0x') {
        wcgltContractHasCode = true;
      } else {
        errors.push('BSC_WCGLT_ADDRESS has no bytecode on BSC');
      }
    } catch {
      errors.push('Failed to check BSC_WCGLT_ADDRESS bytecode');
    }
  }

  // ── Check 7: BRIDGE_API_URL present if bridge operations needed ──
  if (env.BRIDGE_API_URL) {
    try {
      const response = await fetch(`${env.BRIDGE_API_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      bridgeReachable = response.ok;
      if (!bridgeReachable) {
        errors.push(`Bridge at ${env.BRIDGE_API_URL} not healthy (HTTP ${response.status})`);
      }
    } catch {
      errors.push(`Bridge at ${env.BRIDGE_API_URL} unreachable`);
    }

    // ── Check 8: Bridge endpoint compatibility ──
    // unipay-api calls /bridge/mint-wcglt, bridge exposes /bridge/mint
    // We check if /bridge/mint-wcglt returns 404 (incompatible)
    const bridgeAuthKey = env.UNIPAY_BRIDGE_API_KEY ?? env.BRIDGE_API_KEY;
    if (bridgeReachable && bridgeAuthKey) {
      try {
        const response = await fetch(`${env.BRIDGE_API_URL}/bridge/mint-wcglt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bridgeAuthKey}`,
          },
          body: JSON.stringify({ to: '0x0000000000000000000000000000000000000000', amount: '0' }),
          signal: AbortSignal.timeout(5000),
        });
        // If 404, endpoint is incompatible
        if (response.status === 404) {
          errors.push('Bridge endpoint mismatch: /bridge/mint-wcglt not found (bridge exposes /bridge/mint)');
          bridgeEndpointCompatible = false;
        } else {
          // Endpoint exists (even if it returns 400/503, the path is valid)
          bridgeEndpointCompatible = true;
        }
      } catch {
        // Can't determine — mark as unknown
        bridgeEndpointCompatible = false;
        errors.push('Cannot verify bridge endpoint compatibility');
      }
    }
  }

  // ── Check 9: No hardcoded conflicting addresses ──
  // If USDT_BSC_CONTRACT is set, it should not be the old hardcoded default
  // (already removed from schema default, but check runtime value)
  if (env.USDT_BSC_CONTRACT && env.USDT_BSC_CONTRACT === '0x55d398326f99059fF775485246999027B3197955') {
    // This is the real BSC USDT — acceptable for production but flag as hardcoded
    // No error, just a note
  }

  const configurationValid = errors.length === 0;

  // Force disabled mode if validation fails
  if (!configurationValid) {
    log?.warn({ errors }, '[CGLT_CONFIG_INVALID] Forcing CGLT_BLOCKCHAIN_MODE=disabled');
    setCgltBlockchainRuntimeMode('disabled');

    // Also disable deposit processor if config is invalid
    log?.warn({}, '[WCGLT_PROCESSOR_CONFLICT] Forcing WCGLT_DEPOSIT_PROCESSOR=disabled due to invalid config');
    setWcgltDepositProcessorRuntime('disabled');
  }

  const result: CgltConfigValidation = {
    mode: getCgltBlockchainMode(),
    chain_id_expected: expectedChainId,
    chain_id_actual: chainIdActual,
    rpc_reachable: rpcReachable,
    cglt_contract_configured: cgltContractConfigured,
    cglt_contract_has_code: cgltContractHasCode,
    wcglt_contract_configured: wcgltContractConfigured,
    wcglt_contract_has_code: wcgltContractHasCode,
    bridge_reachable: bridgeReachable,
    bridge_endpoint_compatible: bridgeEndpointCompatible,
    configuration_valid: configurationValid,
    errors,
  };

  lastValidation = result;
  return result;
}
