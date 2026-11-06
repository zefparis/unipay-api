"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Security remediation tests — 6 fixes from the audit.
 *
 * C2: merchant.status === 'active' check on all /v1/merchant/* routes
 * C5: HTML-escape email subject
 * C4: Rate limit on support message (10/hour per merchant_id)
 * C6: Rate limit on webhook test (5/hour per merchant_id)
 * L1: maxLength on admin search param
 * L2: schema.querystring on export transactions route
 */
const ROUTES_DIR = node_path_1.default.resolve(__dirname, '../../routes');
const LIB_DIR = node_path_1.default.resolve(__dirname, '../');
const EMAIL_SERVICE = node_path_1.default.resolve(__dirname, '../../services/email.ts');
function readSrc(rel) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(ROUTES_DIR, rel), 'utf-8');
}
// ─── C2: merchant.status === 'active' check ───────────────────
(0, node_test_1.describe)('C2 — merchant.status check on all /v1/merchant/* routes', () => {
    const MERCHANT_AUTH_LIB = node_fs_1.default.readFileSync(node_path_1.default.resolve(LIB_DIR, 'merchant-auth.ts'), 'utf-8');
    (0, node_test_1.it)('merchant-auth.ts exports requireActiveMerchant that checks status === active', () => {
        strict_1.default.match(MERCHANT_AUTH_LIB, /data\.status !== 'active'/, 'requireActiveMerchant must check status !== active');
        strict_1.default.match(MERCHANT_AUTH_LIB, /Compte suspendu/, 'must return "Compte suspendu" error message');
    });
    (0, node_test_1.it)('balance.ts uses requireActiveMerchant (not inline verifyToken)', () => {
        const src = readSrc('merchant/balance.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
    });
    (0, node_test_1.it)('transactions.ts uses requireActiveMerchant (not inline verifyToken)', () => {
        const src = readSrc('merchant/transactions.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
    });
    (0, node_test_1.it)('apikey.ts uses requireActiveMerchant (not inline verifyToken)', () => {
        const src = readSrc('merchant/apikey.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
    });
    (0, node_test_1.it)('kyc.ts uses requireActiveMerchant (not inline verifyToken)', () => {
        const src = readSrc('merchant/kyc.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
    });
    (0, node_test_1.it)('mode.ts uses requireActiveMerchant for all 3 routes', () => {
        const src = readSrc('merchant/mode.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
        // Count occurrences — should be at least 3 (one per route)
        const matches = src.match(/requireActiveMerchant/g);
        strict_1.default.ok(matches && matches.length >= 4, `expected ≥4 references (1 import + 3 routes), got ${matches?.length}`);
    });
    (0, node_test_1.it)('webhook.ts uses requireActiveMerchant for all 4 routes', () => {
        const src = readSrc('merchant/webhook.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
        const matches = src.match(/requireActiveMerchant/g);
        strict_1.default.ok(matches && matches.length >= 5, `expected ≥5 references (1 import + 4 routes), got ${matches?.length}`);
    });
    (0, node_test_1.it)('settlement.ts uses requireActiveMerchant for all 4 routes', () => {
        const src = readSrc('merchant/settlement.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /requireMerchantAuth\b/, 'must not use old local requireMerchantAuth');
        const matches = src.match(/requireActiveMerchant/g);
        strict_1.default.ok(matches && matches.length >= 5, `expected ≥5 references (1 import + 4 routes), got ${matches?.length}`);
    });
    (0, node_test_1.it)('support.ts uses requireActiveMerchant for all 3 routes', () => {
        const src = readSrc('merchant/support.ts');
        strict_1.default.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
        strict_1.default.doesNotMatch(src, /function requireMerchantAuth/, 'must not define local requireMerchantAuth');
        const matches = src.match(/requireActiveMerchant/g);
        strict_1.default.ok(matches && matches.length >= 4, `expected ≥4 references (1 import + 3 routes), got ${matches?.length}`);
    });
});
// ─── C5: HTML-escape email subject ────────────────────────────
(0, node_test_1.describe)('C5 — email subject HTML-escaped', () => {
    const EMAIL_SRC = node_fs_1.default.readFileSync(EMAIL_SERVICE, 'utf-8');
    (0, node_test_1.it)('subject is HTML-escaped in the layout template', () => {
        // The subject must go through .replace(/&/g, ...).replace(/</g, ...).replace(/>/g, ...)
        // in the <h2> block, not be inserted raw.
        strict_1.default.match(EMAIL_SRC, /\$\{subject\.replace\(\/&\/g.*?\.replace\(\/<\/g.*?\.replace\(\/>\/g/, 'subject must be HTML-escaped in the template');
    });
    (0, node_test_1.it)('subject is NOT inserted raw (no bare ${subject} in h2)', () => {
        // Check that there's no bare ${subject} without .replace in the h2 block
        const h2Block = EMAIL_SRC.match(/<h2[^>]*>[\s\S]*?<\/h2>/);
        if (h2Block) {
            strict_1.default.doesNotMatch(h2Block[0], /\$\{subject\}/, 'subject must not be inserted raw in the h2 block');
        }
    });
});
// ─── C4: Rate limit on support message ────────────────────────
(0, node_test_1.describe)('C4 — rate limit on POST /merchant/support/message', () => {
    const SRC = readSrc('merchant/support.ts');
    (0, node_test_1.it)('has a route-level rateLimit config', () => {
        strict_1.default.match(SRC, /rateLimit:\s*\{/, 'must have rateLimit config on the route');
    });
    (0, node_test_1.it)('limits to 10 per hour', () => {
        strict_1.default.match(SRC, /max:\s*10/, 'must limit to 10 requests');
        strict_1.default.match(SRC, /timeWindow:\s*['"]1 hour['"]/, 'must use 1 hour time window');
    });
    (0, node_test_1.it)('keyGenerator uses merchant_id from JWT, not just IP', () => {
        strict_1.default.match(SRC, /merchantIdFromRequest/, 'must use merchantIdFromRequest for key generation');
    });
});
// ─── C6: Rate limit on webhook test ───────────────────────────
(0, node_test_1.describe)('C6 — rate limit on POST /merchant/webhook/test', () => {
    const SRC = readSrc('merchant/webhook.ts');
    (0, node_test_1.it)('has a route-level rateLimit config on the test route', () => {
        // Find the test route section and verify it has rateLimit
        const testRouteSection = SRC.match(/\/merchant\/webhook\/test[\s\S]*?async/);
        strict_1.default.ok(testRouteSection, 'must find webhook/test route');
        strict_1.default.match(testRouteSection[0], /rateLimit:\s*\{/, 'test route must have rateLimit config');
    });
    (0, node_test_1.it)('limits to 5 per hour', () => {
        const testRouteSection = SRC.match(/\/merchant\/webhook\/test[\s\S]*?async/);
        strict_1.default.ok(testRouteSection);
        strict_1.default.match(testRouteSection[0], /max:\s*5/, 'must limit to 5 requests');
        strict_1.default.match(testRouteSection[0], /timeWindow:\s*['"]1 hour['"]/, 'must use 1 hour time window');
    });
    (0, node_test_1.it)('keyGenerator uses merchant_id from JWT, not just IP', () => {
        strict_1.default.match(SRC, /merchantIdFromRequest/, 'must use merchantIdFromRequest for key generation');
    });
});
// ─── L1: maxLength on search param ────────────────────────────
(0, node_test_1.describe)('L1 — maxLength on admin search param', () => {
    const SRC = readSrc('admin/merchants.ts');
    (0, node_test_1.it)('search param has maxLength constraint', () => {
        strict_1.default.match(SRC, /search:\s*\{\s*type:\s*['"]string['"]\s*,\s*maxLength:\s*\d+\s*\}/, 'search must have a maxLength constraint');
    });
    (0, node_test_1.it)('maxLength is reasonable (≤ 256)', () => {
        const match = SRC.match(/search:\s*\{\s*type:\s*['"]string['"]\s*,\s*maxLength:\s*(\d+)\s*\}/);
        strict_1.default.ok(match, 'must find maxLength value');
        const maxLen = parseInt(match[1], 10);
        strict_1.default.ok(maxLen <= 256, `maxLength ${maxLen} should be ≤ 256`);
        strict_1.default.ok(maxLen >= 32, `maxLength ${maxLen} should be ≥ 32`);
    });
});
// ─── L2: schema.querystring on export transactions ────────────
(0, node_test_1.describe)('L2 — schema.querystring on export transactions route', () => {
    const SRC = readSrc('admin/merchants.ts');
    (0, node_test_1.it)('export route has a schema.querystring definition', () => {
        // Find the export route section
        const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
        strict_1.default.ok(exportSection, 'must find export route');
        strict_1.default.match(exportSection[0], /schema:\s*\{[\s\S]*?querystring:/, 'export route must have schema.querystring');
    });
    (0, node_test_1.it)('export querystring validates merchant_id as uuid', () => {
        const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
        strict_1.default.ok(exportSection);
        strict_1.default.match(exportSection[0], /merchant_id:\s*\{\s*type:\s*['"]string['"]\s*,\s*format:\s*['"]uuid['"]/, 'merchant_id must be validated as uuid');
    });
    (0, node_test_1.it)('export querystring validates status as enum', () => {
        const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
        strict_1.default.ok(exportSection);
        strict_1.default.match(exportSection[0], /status:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:/, 'status must be validated as enum');
    });
    (0, node_test_1.it)('export querystring validates operator as enum', () => {
        const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
        strict_1.default.ok(exportSection);
        strict_1.default.match(exportSection[0], /operator:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:/, 'operator must be validated as enum');
    });
});
//# sourceMappingURL=security-remediation.test.js.map