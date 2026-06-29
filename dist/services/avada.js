"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiateCollection = initiateCollection;
exports.initiatePayout = initiatePayout;
exports.getTransactionStatus = getTransactionStatus;
exports.getBalance = getBalance;
exports.verifyCallbackSignature = verifyCallbackSignature;
exports.normalizeCallback = normalizeCallback;
exports.sandboxCollection = sandboxCollection;
exports.sandboxPayout = sandboxPayout;
const node_crypto_1 = __importDefault(require("node:crypto"));
const undici_1 = require("undici");
const env_1 = require("../config/env");
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
    const callbackUrl = env_1.env.UNIPESA_CALLBACK_URL;
    if (!publicId || !merchantId || !secretKey || !callbackUrl) {
        throw new Error('Unipesa integration not configured: UNIPESA_PUBLIC_ID, UNIPESA_MERCHANT_ID, UNIPESA_SECRET_KEY, UNIPESA_CALLBACK_URL required');
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
function getProxyAgent() {
    if (!env_1.env.FIXIE_URL)
        return undefined;
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
    // Nettoie : retire espaces, +, préfixe 243
    let p = phone.replace(/\s+/g, '').replace(/^\+/, '');
    if (p.startsWith('243'))
        p = p.slice(3);
    if (p.startsWith('0'))
        p = p.slice(1);
    // p est maintenant le numéro nu sans 0 ni préfixe (ex: 997174834)
    const op = operator.toLowerCase();
    if (op === 'airtel') {
        return p; // Airtel : numéro nu, ex 997174834
    }
    // Orange et Africell : avec le 0 initial, ex 0997174834
    return '0' + p;
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
    return { avada_transaction_id: avadaId ? String(avadaId) : reference };
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
    return { avada_transaction_id: avadaId ? String(avadaId) : reference };
}
async function getTransactionStatus(avadaTransactionId) {
    const { publicId, merchantId, secretKey } = requireUnipesaEnv();
    const payload = {
        merchant_id: merchantId,
        order_id: avadaTransactionId,
    };
    payload['signature'] = calculateSignature(payload, secretKey);
    const data = await unipesaPost(publicId, '/status', payload);
    return data['status'] ?? 'pending';
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
    return provided.toLowerCase() === expected.toLowerCase();
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