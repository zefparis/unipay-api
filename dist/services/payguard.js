"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrollPayGuard = enrollPayGuard;
exports.verifyPayGuard = verifyPayGuard;
const PAYGUARD_API = 'https://hybrid-vector-api-m5xt.onrender.com';
const PAYGUARD_API_KEY = process.env.PAYGUARD_API_KEY ?? 'unipay-congo-key-2026';
const PAYGUARD_TENANT = 'unipay-congo';
async function enrollPayGuard(params) {
    const res = await fetch(`${PAYGUARD_API}/payguard/enroll`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': PAYGUARD_API_KEY,
            Origin: 'https://unipay-api.onrender.com',
        },
        body: JSON.stringify({
            ...params,
            tenant_id: PAYGUARD_TENANT,
            cognitive_baseline: {
                vocal_embedding: [],
                vocal_quality: 1,
                digit_span_score: 0.8,
                stroop_accuracy: 0.8,
                reflex_ms: 300,
            },
        }),
    });
    if (!res.ok)
        throw new Error(`PayGuard enroll failed: ${res.status}`);
    return res.json();
}
async function verifyPayGuard(params) {
    const res = await fetch(`${PAYGUARD_API}/payguard/verify`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': PAYGUARD_API_KEY,
            Origin: 'https://unipay-api.onrender.com',
        },
        body: JSON.stringify({
            ...params,
            tenant_id: PAYGUARD_TENANT,
        }),
    });
    if (!res.ok)
        throw new Error(`PayGuard verify failed: ${res.status}`);
    return res.json();
}
//# sourceMappingURL=payguard.js.map