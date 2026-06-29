"use strict";
/**
 * Binance REST API — admin-level helpers.
 * Pure Node.js, no SDK.
 *
 * Docs:
 *   GET  /api/v3/account                    — main account balances
 *   GET  /sapi/v3/sub-account/assets        — sub-account balances
 *   POST /sapi/v1/capital/withdraw/apply    — withdrawal (reused from binance-withdrawal.ts)
 *   GET  /sapi/v1/capital/withdraw/history  — withdrawal history
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withdrawUsdt = void 0;
exports.getAccountBalance = getAccountBalance;
exports.getSubAccountBalance = getSubAccountBalance;
exports.getWithdrawHistory = getWithdrawHistory;
const node_crypto_1 = __importDefault(require("node:crypto"));
const undici_1 = require("undici");
const env_js_1 = require("../config/env.js");
const binance_withdrawal_js_1 = require("./binance-withdrawal.js");
Object.defineProperty(exports, "withdrawUsdt", { enumerable: true, get: function () { return binance_withdrawal_js_1.withdrawUsdt; } });
const BINANCE_BASE = 'https://api.binance.com';
/* ── Fixie proxy ──────────────────────────────────────────────────────── */
let _proxyAgent;
function getProxyAgent() {
    if (!env_js_1.env.FIXIE_URL)
        return undefined;
    if (!_proxyAgent)
        _proxyAgent = new undici_1.ProxyAgent(env_js_1.env.FIXIE_URL);
    return _proxyAgent;
}
async function binanceFetch(url, opts = {}) {
    const dispatcher = getProxyAgent();
    return (0, undici_1.fetch)(url, {
        ...opts,
        ...(dispatcher ? { dispatcher } : {}),
    });
}
/* ── HMAC helpers ─────────────────────────────────────────────────────── */
function signRequest(queryString, secretKey) {
    return node_crypto_1.default.createHmac('sha256', secretKey).update(queryString).digest('hex');
}
function buildSignedQS(params, secretKey) {
    const base = Object.entries({ ...params, timestamp: Date.now() })
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return `${base}&signature=${signRequest(base, secretKey)}`;
}
/* ── 1. Main account balances ─────────────────────────────────────────── */
/**
 * GET /api/v3/account
 * Returns only assets with free > 0.
 */
async function getAccountBalance(apiKey, secretKey) {
    const qs = buildSignedQS({}, secretKey);
    const res = await binanceFetch(`${BINANCE_BASE}/api/v3/account?${qs}`, {
        headers: { 'X-MBX-APIKEY': apiKey },
    });
    if (!res.ok) {
        const err = (await res.json());
        throw new Error(`Binance account [${res.status}]: ${err.msg ?? res.statusText}`);
    }
    const json = (await res.json());
    return (json.balances ?? []).filter(b => parseFloat(b.free) > 0);
}
/* ── 2. Sub-account balances ──────────────────────────────────────────── */
/**
 * GET /sapi/v3/sub-account/assets
 * Returns balances for the given sub-account email.
 */
async function getSubAccountBalance(email, mainApiKey, mainSecretKey) {
    // v3 endpoint with recvWindow for better tolerance
    const qs = buildSignedQS({ email, recvWindow: 60000 }, mainSecretKey);
    const endpointPath = '/sapi/v3/sub-account/assets';
    const res = await binanceFetch(`${BINANCE_BASE}${endpointPath}?${qs}`, {
        headers: { 'X-MBX-APIKEY': mainApiKey },
    });
    if (!res.ok) {
        // Safe logging: do not log secrets or signature. Do not include full query string.
        let bodyText = '';
        let bodyJson = null;
        try {
            bodyJson = await res.json();
        }
        catch {
            try {
                bodyText = await res.text();
            }
            catch {
                bodyText = '';
            }
        }
        // Temporary diagnostic log
        console.error('[binance-admin] sub-account balances error', {
            url: endpointPath, // avoid leaking signature
            status: res.status,
            body: bodyJson ?? bodyText,
        });
        // Build informative error string for upstream propagation
        if (bodyJson && typeof bodyJson === 'object' && bodyJson !== null) {
            const obj = bodyJson;
            const code = obj.code !== undefined ? String(obj.code) : 'unknown';
            const msg = obj.msg ?? res.statusText;
            throw new Error(`Binance sub-account error [${res.status}] code=${code} msg=${msg}`);
        }
        const raw = bodyText ? ` raw=${String(bodyText).slice(0, 500)}` : '';
        throw new Error(`Binance sub-account error [${res.status}]${raw}`);
    }
    const json = (await res.json());
    return (json.balances ?? []).filter(b => parseFloat(b.free) > 0);
}
/* ── 3. Withdrawal history ────────────────────────────────────────────── */
/**
 * GET /sapi/v1/capital/withdraw/history
 * Returns last `limit` USDT withdrawals.
 */
async function getWithdrawHistory(apiKey, secretKey, limit = 50) {
    const qs = buildSignedQS({ coin: 'USDT', limit }, secretKey);
    const res = await binanceFetch(`${BINANCE_BASE}/sapi/v1/capital/withdraw/history?${qs}`, {
        headers: { 'X-MBX-APIKEY': apiKey },
    });
    if (!res.ok) {
        const err = (await res.json());
        throw new Error(`Binance withdraw history [${res.status}]: ${err.msg ?? res.statusText}`);
    }
    return (await res.json());
}
//# sourceMappingURL=binance-admin.js.map