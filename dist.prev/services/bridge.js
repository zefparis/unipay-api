"use strict";
/**
 * CGLT Bridge API client.
 *
 * Handles minting wCGLT on BSC via the bridge server.
 * All BSC signing is done server-side by the bridge — this service
 * only sends authenticated HTTP requests.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeOutcomeUnknownError = void 0;
exports.mintWCGLT = mintWCGLT;
const cglt_blockchain_mode_1 = require("../config/cglt-blockchain-mode");
const env_1 = require("../config/env");
const CGLT_PER_WCGLT = 500;
const BRIDGE_TIMEOUT_MS = 8_000; // must be < upstreamFetch timeout (10s) + Vercel function timeout (10s)
class BridgeOutcomeUnknownError extends Error {
    operationId;
    constructor(operationId, cause) {
        super('PENDING_ONCHAIN_CHECK', { cause });
        this.operationId = operationId;
        this.name = 'BridgeOutcomeUnknownError';
    }
}
exports.BridgeOutcomeUnknownError = BridgeOutcomeUnknownError;
/**
 * Mints wCGLT on BSC to the given address.
 *
 * @param bscAddress  Recipient BSC address (0x...)
 * @param amountCGLT  Amount in CGLT (converted to wCGLT internally: amountCGLT / 500)
 * @returns           BSC transaction hash
 */
async function mintWCGLT(bscAddress, amountCGLT, operationId) {
    (0, cglt_blockchain_mode_1.assertCgltBlockchainWriteEnabled)();
    const bridgeUrl = env_1.env.BRIDGE_API_URL ?? 'http://104.248.166.144:3099';
    // Trust boundary 3: UniPay API → Bridge — use UNIPAY_BRIDGE_API_KEY (new)
    // with legacy BRIDGE_API_KEY fallback during dual-key rotation.
    const key = env_1.env.UNIPAY_BRIDGE_API_KEY ?? env_1.env.BRIDGE_API_KEY;
    if (!key)
        throw new Error('UNIPAY_BRIDGE_API_KEY or BRIDGE_API_KEY not set');
    const wcgltAmount = amountCGLT / CGLT_PER_WCGLT;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(`${bridgeUrl}/bridge/mint-wcglt`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
                'X-Idempotency-Key': operationId,
            },
            body: JSON.stringify({ to: bscAddress, amount: wcgltAmount, operation_id: operationId }),
            signal: ctrl.signal,
        });
    }
    catch (err) {
        throw new BridgeOutcomeUnknownError(operationId, err);
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Bridge error ${res.status}: ${text}`);
    }
    const data = await res.json();
    if (!data.success)
        throw new Error(data.error ?? 'bridge_failed');
    if (!data.hash)
        throw new BridgeOutcomeUnknownError(operationId);
    return data.hash;
}
//# sourceMappingURL=bridge.js.map