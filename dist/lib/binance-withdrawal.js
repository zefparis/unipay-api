"use strict";
/**
 * Binance REST API — USDT withdrawal helper.
 * Pure Node.js, no SDK.  Only the minimum endpoints needed.
 *
 * Docs:
 *   POST /sapi/v1/capital/withdraw/apply  — submit withdrawal
 *   GET  /sapi/v1/capital/withdraw/history — poll status
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withdrawUsdt = withdrawUsdt;
exports.getWithdrawStatus = getWithdrawStatus;
const node_crypto_1 = __importDefault(require("node:crypto"));
const undici_1 = require("undici");
const env_js_1 = require("../config/env.js");
const BINANCE_BASE = 'https://api.binance.com';
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
/** Network names expected by Binance for each chain. */
const NETWORK_MAP = {
    BSC: 'BSC',
    TRC20: 'TRX',
    ERC20: 'ETH',
};
/** HMAC-SHA256 signature required by Binance signed endpoints. */
function signRequest(queryString, secretKey) {
    return node_crypto_1.default
        .createHmac('sha256', secretKey)
        .update(queryString)
        .digest('hex');
}
/** Build a signed query string with timestamp + signature appended. */
function buildSignedQS(params, secretKey) {
    const ts = Date.now();
    const base = Object.entries({ ...params, timestamp: ts })
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    const sig = signRequest(base, secretKey);
    return `${base}&signature=${sig}`;
}
/**
 * POST /sapi/v1/capital/withdraw/apply
 * Submits a USDT withdrawal to the given address on the specified network.
 * The `amount` passed here must already be net of fee.
 */
async function withdrawUsdt(opts) {
    const { amount, network, address, apiKey, secretKey } = opts;
    const binanceNetwork = NETWORK_MAP[network];
    const qs = buildSignedQS({
        coin: 'USDT',
        network: binanceNetwork,
        address,
        amount: amount.toFixed(6),
    }, secretKey);
    const res = await binanceFetch(`${BINANCE_BASE}/sapi/v1/capital/withdraw/apply`, {
        method: 'POST',
        headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: qs,
    });
    const json = (await res.json());
    if (!res.ok || !json.id) {
        throw new Error(`Binance withdrawal failed [${res.status}]: ${json.msg ?? JSON.stringify(json)}`);
    }
    return { id: json.id, success: true };
}
const STATUS_MAP = {
    0: 'email_sent',
    1: 'cancelled',
    2: 'awaiting_approval',
    3: 'rejected',
    4: 'processing',
    5: 'failure',
    6: 'completed',
};
/**
 * GET /sapi/v1/capital/withdraw/history
 * Fetches the latest status for a given Binance withdrawId.
 */
async function getWithdrawStatus(withdrawId, apiKey, secretKey) {
    const qs = buildSignedQS({ withdrawOrderId: withdrawId, limit: 10 }, secretKey);
    const res = await binanceFetch(`${BINANCE_BASE}/sapi/v1/capital/withdraw/history?${qs}`, {
        headers: { 'X-MBX-APIKEY': apiKey },
    });
    const list = (await res.json());
    if (!res.ok || !Array.isArray(list)) {
        return { status: 'unknown' };
    }
    const record = list.find(r => r.id === withdrawId);
    if (!record)
        return { status: 'unknown' };
    return {
        status: STATUS_MAP[record.status] ?? 'unknown',
        txHash: record.txId ?? undefined,
    };
}
//# sourceMappingURL=binance-withdrawal.js.map