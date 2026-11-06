"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiateCollection = initiateCollection;
exports.initiatePayout = initiatePayout;
exports.getTransactionStatus = getTransactionStatus;
exports.getTransactionStatusWithRaw = getTransactionStatusWithRaw;
exports.getBalance = getBalance;
exports.verifyCallbackSignature = verifyCallbackSignature;
exports.normalizeCallback = normalizeCallback;
exports.sandboxCollection = sandboxCollection;
exports.sandboxPayout = sandboxPayout;
const node_crypto_1 = __importDefault(require("node:crypto"));
const undici_1 = require("undici");
const env_1 = require("../config/env");
const phone_normalization_1 = require("../lib/phone-normalization");
const secret_compare_1 = require("../security/secret-compare");
const BASE = 'https://api.unipesa.tech';
// AvadaPay provider IDs (same as congogaming)
const PROVIDER_IDS = {
    orange: 10,
    airtel: 17,
    afrimoney: 19,
};
const CALLBACK_STATUS_MAP = {
    0: 'pending',
    1: 'processing',
    2: 'success',
    3: 'failed',
};
const CALLBACK_PROVIDER_MAP = {
    10: 'orange',
    17: 'airtel',
    19: 'afrimoney',
};
// ── Helpers ──────────────────────────────────────────────────────────────────
function requireUnipesaEnv() {
    const publicId = env_1.env.UNIPESA_PUBLIC_ID;
    const merchantId = env_1.env.UNIPESA_MERCHANT_ID;
    const secretKey = env_1.env.UNIPESA_SECRET_KEY;
    // Merchant flow uses a dedicated callback URL (/v1/payment/callback).
    // Fall back to UNIPESA_CALLBACK_URL for backward compatibility.
    const callbackUrl = env_1.env.UNIPESA_MERCHANT_CALLBACK_URL ?? env_1.env.UNIPESA_CALLBACK_URL;
    if (!publicId || !merchantId || !secretKey || !callbackUrl) {
        throw new Error('Unipesa integration not configured: UNIPESA_PUBLIC_ID, UNIPESA_MERCHANT_ID, UNIPESA_SECRET_KEY, UNIPESA_MERCHANT_CALLBACK_URL (or UNIPESA_CALLBACK_URL) required');
    }
    return { publicId, merchantId, secretKey, callbackUrl };
}
// HMAC-SHA512 signature — same algorithm as congogaming/AvadaPay spec
function calculateSignature(data, secretKey) {
    let str = '';
    for (const [key, value] of Object.entries(data)) {
        if (key === 'signature')
            continue;
        if (value !== null && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                str += `${key}.${k}${v}`;
            }
        }
        else {
            str += `${key}${value}`;
        }
    }
    return node_crypto_1.default.createHmac('sha512', secretKey).update(str).digest('hex').toLowerCase();
}
let _proxyAgent;
let _skipWarned = false;
function isSkipFixieCheck() {
    const v = env_1.env.UNIPESA_SKIP_FIXIE_CHECK;
    return v === '1' || v === 'true';
}
function getProxyAgent() {
    if (!env_1.env.FIXIE_URL) {
        // Hard block: no payment may leave without a Fixie proxy unless an
        // explicit, deliberate bypass flag is set. This check is independent
        // of NODE_ENV — it applies in all environments.
        if (isSkipFixieCheck()) {
            if (!_skipWarned) {
                _skipWarned = true;
                console.warn('[WARN] avada.ts: UNIPESA_SKIP_FIXIE_CHECK is set — Unipesa/Avada call bypassing Fixie proxy (direct connection). IP whitelisting is NOT active.');
            }
            return undefined;
        }
        throw new Error('FIXIE_PROXY_REQUIRED: FIXIE_URL is not set and UNIPESA_SKIP_FIXIE_CHECK is not enabled. Unipesa/Avada calls require the Fixie proxy for IP whitelisting.');
    }
    if (!_proxyAgent)
        _proxyAgent = new undici_1.ProxyAgent(env_1.env.FIXIE_URL);
    return _proxyAgent;
}
async function unipesaPost(publicId, path, body) {
    const dispatcher = getProxyAgent();
    const res = await (0, undici_1.fetch)(`${BASE}/${publicId}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        ...(dispatcher ? { dispatcher } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Unipesa HTTP ${res.status}: ${text}`);
    }
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        throw new Error(`Unipesa non-JSON response: ${text}`);
    }
    // Unipesa returns HTTP 200 even when the provider call fails. The
    // result.code field is 0 on success and non-zero on failure (e.g.
    // 10301 = "REQUEST SENDING ERROR | get token error" when the
    // operator API is unreachable). Without this check, failed
    // provider calls are silently treated as "processing" and the
    // transaction gets stuck forever (no callback will ever arrive).
    //
    // IMPORTANT: this check only applies to payment INITIATION calls
    // (/payment_c2b, /payment_b2c). The /status endpoint also returns
    // a non-zero result.code when the TRANSACTION failed (e.g. 10301
    // for a failed Airtel withdrawal) — but the response still contains
    // the authoritative status (status=3) that the reconciliation job
    // needs. Throwing on /status would prevent status resolution.
    const isStatusEndpoint = path === '/status' || path === '/balance';
    if (!isStatusEndpoint) {
        const resultCode = json['result'];
        if (resultCode && typeof resultCode === 'object') {
            const code = resultCode['code'];
            const message = resultCode['message'];
            if (code !== undefined && code !== 0 && code !== '0') {
                throw new Error(`Unipesa provider error: code=${code} message=${message ?? '(no message)'}`);
            }
        }
    }
    return json;
}
function toNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const normalized = value.replace(/\s/g, '').replace(',', '.');
        const parsed = Number(normalized);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function formatPhoneForOperator(phone, operator) {
    return (0, phone_normalization_1.normalizePhoneForOperator)(phone, operator.toLowerCase());
}
function findBalanceValue(data) {
    if (!data || typeof data !== 'object')
        return null;
    const obj = data;
    const directKeys = ['balance', 'balance_cdf', 'available_balance', 'available', 'amount', 'solde'];
    for (const key of directKeys) {
        const value = toNumber(obj[key]);
        if (value !== null)
            return value;
    }
    for (const value of Object.values(obj)) {
        const nested = findBalanceValue(value);
        if (nested !== null)
            return nested;
    }
    return null;
}
// ── Public API ────────────────────────────────────────────────────────────────
async function initiateCollection(operator, phone, amount, reference, currency = 'CDF') {
    const { publicId, merchantId, secretKey, callbackUrl } = requireUnipesaEnv();
    const provider_id = PROVIDER_IDS[operator.toLowerCase()];
    if (!provider_id)
        throw new Error(`Unknown operator: ${operator}`);
    const payload = {
        merchant_id: merchantId,
        customer_id: formatPhoneForOperator(phone, operator),
        order_id: reference,
        amount,
        currency,
        country: 'CD',
        callback_url: callbackUrl,
        provider_id,
    };
    payload['signature'] = calculateSignature(payload, secretKey);
    const data = await unipesaPost(publicId, '/payment_c2b', payload);
    console.log('[avada:initiateCollection] raw response:', JSON.stringify(data));
    const avadaId = data['transaction_id'] ||
        data['order_id'] ||
        data['payment_id'] ||
        data['trx_id'] ||
        data['id'] ||
        null;
    // If Unipesa returned OK (result.code=0) but no transaction_id was
    // created, the provider rejected the request (e.g. Airtel returning
    // "An unexpected error occurred" with provider_result.code=-8888).
    // Without a transaction_id, no callback will ever arrive — the
    // transaction would be stuck in "processing" forever.
    if (!avadaId) {
        const providerResult = data['provider_result'];
        const providerMsg = providerResult?.['message'] ?? '(no provider message)';
        throw new Error(`Unipesa provider did not create a transaction: ${providerMsg}`);
    }
    return { avada_transaction_id: String(avadaId) };
}
async function initiatePayout(operator, phone, amount, reference, currency = 'CDF') {
    const { publicId, merchantId, secretKey, callbackUrl } = requireUnipesaEnv();
    const provider_id = PROVIDER_IDS[operator.toLowerCase()];
    if (!provider_id)
        throw new Error(`Unknown operator: ${operator}`);
    const payload = {
        merchant_id: merchantId,
        customer_id: formatPhoneForOperator(phone, operator),
        order_id: reference,
        amount,
        currency,
        country: 'CD',
        callback_url: callbackUrl,
        provider_id,
    };
    payload['signature'] = calculateSignature(payload, secretKey);
    const data = await unipesaPost(publicId, '/payment_b2c', payload);
    console.log('[avada:initiatePayout] raw response:', JSON.stringify(data));
    const avadaId = data['transaction_id'] ||
        data['order_id'] ||
        data['payment_id'] ||
        data['trx_id'] ||
        data['id'] ||
        null;
    console.log('[avada:initiatePayout] resolved avada_id:', avadaId);
    // Same guard as initiateCollection: no transaction_id means the
    // provider rejected the request and no callback will ever arrive.
    if (!avadaId) {
        const providerResult = data['provider_result'];
        const providerMsg = providerResult?.['message'] ?? '(no provider message)';
        throw new Error(`Unipesa provider did not create a transaction: ${providerMsg}`);
    }
    return { avada_transaction_id: String(avadaId) };
}
async function getTransactionStatus(avadaTransactionId) {
    const { status } = await getTransactionStatusWithRaw(avadaTransactionId);
    return status;
}
async function getTransactionStatusWithRaw(avadaTransactionId) {
    const { publicId, merchantId, secretKey } = requireUnipesaEnv();
    const payload = {
        merchant_id: merchantId,
        order_id: avadaTransactionId,
    };
    payload['signature'] = calculateSignature(payload, secretKey);
    const data = await unipesaPost(publicId, '/status', payload);
    // Unipesa returns numeric status (0=pending, 1=processing, 2=success,
    // 3=failed, -1=not found). Map to AvadaStatus text so the reconciliation
    // worker and callback route can compare against string values. Treat
    // -1 (PARENT OPERATION NOT FOUND) as 'failed' so stale transactions
    // that Unipesa no longer knows about can be resolved.
    const rawStatus = data['status'];
    let status;
    if (typeof rawStatus === 'number') {
        if (rawStatus === -1)
            status = 'failed';
        else
            status = CALLBACK_STATUS_MAP[rawStatus] ?? 'pending';
    }
    else {
        status = rawStatus ?? 'pending';
    }
    return { status, raw: data };
}
async function getBalance() {
    const { publicId, merchantId, secretKey } = requireUnipesaEnv();
    const payload = {
        merchant_id: merchantId,
        order_id: `BAL-${Date.now()}`,
    };
    payload['signature'] = calculateSignature(payload, secretKey);
    console.log('[avada:getBalance] calling Unipesa balance endpoint');
    const data = await unipesaPost(publicId, '/balance', payload);
    console.log('[avada:getBalance] raw response:', JSON.stringify(data));
    const balance = findBalanceValue(data);
    console.log('[avada:getBalance] parsed balance:', balance);
    if (balance === null) {
        throw new Error(`Unipesa balance response does not contain a recognized balance field: ${JSON.stringify(data)}`);
    }
    return { balance, currency: 'CDF' };
}
// Callback signature verification — HMAC-SHA512, same as congogaming
function verifyCallbackSignature(body) {
    if (!env_1.env.UNIPESA_SECRET_KEY)
        return false;
    const provided = String(body['signature'] ?? '');
    if (!provided)
        return false;
    const expected = calculateSignature(body, env_1.env.UNIPESA_SECRET_KEY);
    return (0, secret_compare_1.safeSecretEqual)(provided.toLowerCase(), expected.toLowerCase());
}
function normalizeCallback(payload) {
    return {
        avada_transaction_id: payload.transaction_id,
        reference: payload.order_id,
        status: CALLBACK_STATUS_MAP[payload.status] ?? 'pending',
        operator: CALLBACK_PROVIDER_MAP[payload.provider_id] ?? String(payload.provider_id),
        amount: payload.amount,
        phone: payload.customer_id,
        raw: payload,
    };
}
// ── Sandbox (test mode) ───────────────────────────────────────────────────────
function sandboxCollection(_amount) {
    return { avada_transaction_id: `sandbox_${node_crypto_1.default.randomUUID()}` };
}
function sandboxPayout(_amount) {
    return { avada_transaction_id: `sandbox_${node_crypto_1.default.randomUUID()}` };
}
//# sourceMappingURL=avada.js.map