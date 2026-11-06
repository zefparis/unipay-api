"use strict";
/**
 * Shared BSC destination address guard.
 *
 * Single source of truth for FORBIDDEN_ADDRESSES and the contract-detection
 * check used by every route that sends tokens to a user-supplied BSC address
 * (crypto-withdraw, cglt-gaming, wcglt-swap).
 *
 * Re-exported `isContractAddress` comes from bsc-withdrawal to avoid a second
 * ethers provider instantiation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVM_ADDR = exports.FORBIDDEN_ADDRESSES = void 0;
exports.checkDestinationAddress = checkDestinationAddress;
const env_1 = require("../config/env");
const bsc_withdrawal_1 = require("./bsc-withdrawal");
/* ── Forbidden destination addresses (lowercase) ──────────────────────── */
exports.FORBIDDEN_ADDRESSES = new Set([
    '0x55d398326f99059ff775485246999027b3197955', // USDT BEP-20 contract
    '0x0000000000000000000000000000000000000000', // zero address
    env_1.env.USDT_BSC_CONTRACT?.toLowerCase(), // safety: always block configured USDT contract
].filter(Boolean));
/* ── EVM address format regex ─────────────────────────────────────────── */
exports.EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
/**
 * Validates a BSC destination address end-to-end:
 *  1. format (0x + 40 hex)
 *  2. FORBIDDEN_ADDRESSES (token contracts, zero address)
 *  3. on-chain contract detection (skipped if address is whitelisted)
 *
 * @param address      Raw destination address as submitted by the client.
 * @param supabase     Supabase client (or fastify.supabase) for the whitelist
 *                     lookup. Pass `null` to skip the whitelist (contract
 *                     detection runs unconditionally).
 */
async function checkDestinationAddress(address, supabase) {
    /* ── 1. Format ─────────────────────────────────────────────────────── */
    if (!exports.EVM_ADDR.test(address)) {
        return {
            ok: false,
            status: 400,
            body: {
                error: 'INVALID_ADDRESS',
                message: 'EVM address must be a valid 0x hex address (42 chars)',
            },
        };
    }
    const normalized = address.toLowerCase();
    /* ── 2. Forbidden list ─────────────────────────────────────────────── */
    if (exports.FORBIDDEN_ADDRESSES.has(normalized)) {
        return {
            ok: false,
            status: 400,
            body: {
                error: 'FORBIDDEN_DESTINATION',
                message: 'This address cannot receive withdrawals (token contract or null address)',
            },
        };
    }
    /* ── 3. On-chain contract detection (with whitelist bypass) ────────── */
    let whitelisted = false;
    if (supabase) {
        const { data } = await supabase
            .from('whitelisted_contract_destinations')
            .select('address')
            .eq('address', normalized)
            .maybeSingle();
        whitelisted = !!data;
    }
    if (!whitelisted) {
        try {
            const isContract = await (0, bsc_withdrawal_1.isContractAddress)(address);
            if (isContract) {
                return {
                    ok: false,
                    status: 400,
                    body: {
                        error: 'CONTRACT_DESTINATION_BLOCKED',
                        message: 'Withdrawals to smart contract addresses are not supported. Please provide a wallet (EOA) address.',
                    },
                };
            }
        }
        catch {
            return {
                ok: false,
                status: 503,
                body: { error: 'Could not verify destination address on-chain' },
            };
        }
    }
    return { ok: true };
}
//# sourceMappingURL=address-guard.js.map