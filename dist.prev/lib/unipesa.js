"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNIPESA_USD_PROVIDER_IDS = exports.UNIPESA_PROVIDER_IDS = void 0;
exports.calculateSignature = calculateSignature;
exports.newOrderId = newOrderId;
exports.depositUSD = depositUSD;
exports.withdrawUSD = withdrawUSD;
exports.verifyCallbackSignature = verifyCallbackSignature;
/**
 * UniPay ↔ Unipesa aggregator bridge.
 *
 * Adapted from Congo Gaming's server/lib/unipesa.ts.
 * Uses the same HMAC-SHA-512 signature scheme and the Fixie static-IP
 * proxy so requests leave Render from a whitelisted IP.
 *
 * Supported currencies: USD (via depositUSD / withdrawUSD).
 * CDF flows are handled by the existing Avada/operator services.
 */
const node_crypto_1 = require("node:crypto");
const undici_1 = require("undici");
const env_1 = require("../config/env");
const secret_compare_1 = require("../security/secret-compare");
const BASE = 'https://api.unipesa.tech';
const PROXY_URL = env_1.env.FIXIE_URL;
const proxyAgent = PROXY_URL ? new undici_1.ProxyAgent(PROXY_URL) : null;
let _skipWarned = false;
function isSkipFixieCheck() {
    const v = env_1.env.UNIPESA_SKIP_FIXIE_CHECK;
    return v === '1' || v === 'true';
}
const fetchWithProxy = proxyAgent
    ? ((url, opts) => (0, undici_1.fetch)(url, { ...(opts ?? {}), dispatcher: proxyAgent }))
    : ((url, opts) => {
        // Hard block: no payment may leave without a Fixie proxy unless an
        // explicit, deliberate bypass flag is set. This check is independent
        // of NODE_ENV — it applies in all environments.
        if (isSkipFixieCheck()) {
            if (!_skipWarned) {
                _skipWarned = true;
                console.warn('[WARN] unipesa.ts: UNIPESA_SKIP_FIXIE_CHECK is set — Unipesa call bypassing Fixie proxy (direct connection). IP whitelisting is NOT active.');
            }
            return fetch(url, opts);
        }
        throw new Error('FIXIE_PROXY_REQUIRED: FIXIE_URL is not set and UNIPESA_SKIP_FIXIE_CHECK is not enabled. Unipesa calls require the Fixie proxy for IP whitelisting.');
    });
/** Maps mobile-money operator slug to the Unipesa numeric provider_id (CDF flows). */
exports.UNIPESA_PROVIDER_IDS = {
    orange: 1,
    airtel: 2,
    afrimoney: 3,
    mpesa: 4,
};
/**
 * Maps mobile-money operator slug to the Unipesa numeric provider_id for USD flows.
 * USD providers have different IDs from their CDF equivalents.
 *   Orange USD  → 10
 *   Airtel USD  → 17
 *   Africell USD → 19
 */
exports.UNIPESA_USD_PROVIDER_IDS = {
    orange: 10,
    airtel: 17,
    africell: 19,
};
/**
 * Build the Unipesa request signature (HMAC-SHA-512 over sorted key=value pairs).
 * The `signature` key itself is excluded from the digest.
 */
function calculateSignature(data, secretKey) {
    let s = '';
    for (const [key, value] of Object.entries(data)) {
        if (key === 'signature')
            continue;
        if (value !== null && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                s += `${key}.${k}${v}`;
            }
        }
        else {
            s += `${key}${value}`;
        }
    }
    return (0, node_crypto_1.createHmac)('sha512', secretKey).update(s).digest('hex').toLowerCase();
}
async function call(path, payload, signal) {
    const publicId = env_1.env.UNIPESA_PUBLIC_ID;
    if (!publicId)
        throw new Error('UNIPESA_PUBLIC_ID not configured');
    const url = `${BASE}/${publicId}${path}`;
    const effectiveSignal = signal ?? AbortSignal.timeout(30_000);
    const res = await fetchWithProxy(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: effectiveSignal,
    });
    const text = await res.text();
    let json = {};
    try {
        json = JSON.parse(text);
    }
    catch {
        json = { raw: text };
    }
    if (!res.ok) {
        const err = new Error(`Unipesa ${res.status}: ${json?.message ?? text}`);
        err.response = json;
        throw err;
    }
    return json;
}
function newOrderId() {
    return (0, node_crypto_1.randomUUID)();
}
/**
 * C2B — collect USD from a subscriber's mobile money into UniPay.
 * `customer_id` is the subscriber's full phone number (e.g. +243XXXXXXXXX).
 */
async function depositUSD(opts, signal) {
    const { UNIPESA_MERCHANT_ID: merchant_id, UNIPESA_CALLBACK_URL: callback_url, UNIPESA_SECRET_KEY: secret } = env_1.env;
    if (!merchant_id || !callback_url || !secret)
        throw new Error('Unipesa not fully configured');
    const payload = {
        merchant_id,
        customer_id: opts.customer_id,
        order_id: opts.order_id,
        amount: opts.amount,
        currency: 'USD',
        country: 'CD',
        callback_url,
        provider_id: opts.provider_id,
    };
    payload.signature = calculateSignature(payload, secret);
    return call('/payment_c2b', payload, signal);
}
/**
 * B2C — pay out USD from UniPay to a subscriber's mobile money.
 */
async function withdrawUSD(opts, signal) {
    const { UNIPESA_MERCHANT_ID: merchant_id, UNIPESA_CALLBACK_URL: callback_url, UNIPESA_SECRET_KEY: secret } = env_1.env;
    if (!merchant_id || !callback_url || !secret)
        throw new Error('Unipesa not fully configured');
    const payload = {
        merchant_id,
        customer_id: opts.customer_id,
        order_id: opts.order_id,
        amount: opts.amount,
        currency: 'USD',
        country: 'CD',
        callback_url,
        provider_id: opts.provider_id,
    };
    payload.signature = calculateSignature(payload, secret);
    return call('/payment_b2c', payload, signal);
}
/**
 * Verify that a callback body has a valid Unipesa signature.
 * Always returns false when UNIPESA_SECRET_KEY is not set.
 */
function verifyCallbackSignature(body) {
    const secret = env_1.env.UNIPESA_SECRET_KEY;
    if (!secret)
        return false;
    const provided = String(body?.signature ?? '');
    if (!provided)
        return false;
    const expected = calculateSignature(body, secret);
    return (0, secret_compare_1.safeSecretEqual)(provided.toLowerCase(), expected.toLowerCase());
}
//# sourceMappingURL=unipesa.js.map