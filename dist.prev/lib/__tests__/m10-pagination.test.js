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
 * M10 remediation tests — pagination on bsc-addresses dump.
 *
 * The original GET /v1/internal/bsc-addresses returned ALL phone
 * numbers + blockchain addresses in a single unbounded response,
 * protected by a single shared key (no scope, no individual rotation).
 *
 * Fix:
 *   - limit (max 500) and offset are mandatory query parameters
 *   - If absent → 400 PAGINATION_REQUIRED
 *   - If limit > 500 → 400 LIMIT_EXCEEDED
 *   - Response: { data, total, has_more } instead of a bare array
 *   - Distinct application log for each call (monitor 400s after deploy)
 *
 * Tests verify the code changes (static analysis, no DB needed).
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const INTERNAL = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/internal.ts'), 'utf-8');
(0, node_test_1.describe)('M10 — pagination on bsc-addresses', () => {
    (0, node_test_1.it)('requires limit and offset query parameters', () => {
        strict_1.default.match(INTERNAL, /limit.*offset|offset.*limit/i);
        strict_1.default.match(INTERNAL, /PAGINATION_REQUIRED/);
    });
    (0, node_test_1.it)('returns 400 when pagination params are missing', () => {
        strict_1.default.match(INTERNAL, /PAGINATION_REQUIRED[\s\S]*?400/);
    });
    (0, node_test_1.it)('enforces limit max 500', () => {
        strict_1.default.match(INTERNAL, /500/);
        strict_1.default.match(INTERNAL, /LIMIT_EXCEEDED/);
    });
    (0, node_test_1.it)('returns 400 when limit > 500', () => {
        strict_1.default.match(INTERNAL, /LIMIT_EXCEEDED[\s\S]*?400/);
    });
    (0, node_test_1.it)('validates limit >= 1 and offset >= 0', () => {
        strict_1.default.match(INTERNAL, /INVALID_PAGINATION/);
        strict_1.default.match(INTERNAL, /limit must be >= 1/);
        strict_1.default.match(INTERNAL, /offset must be >= 0/);
    });
    (0, node_test_1.it)('uses .range() for pagination (Supabase range query)', () => {
        strict_1.default.match(INTERNAL, /\.range\(offset,\s*offset\s*\+\s*limit\s*-\s*1\)/);
    });
    (0, node_test_1.it)('requests count: exact for total', () => {
        strict_1.default.match(INTERNAL, /count:\s*'exact'/);
    });
    (0, node_test_1.it)('returns { data, total, has_more } structure (not bare array)', () => {
        strict_1.default.match(INTERNAL, /data:\s*normalized/);
        strict_1.default.match(INTERNAL, /total/);
        strict_1.default.match(INTERNAL, /has_more/);
    });
    (0, node_test_1.it)('computes has_more correctly (offset + limit < total)', () => {
        strict_1.default.match(INTERNAL, /offset\s*\+\s*limit\s*<\s*total/);
    });
    (0, node_test_1.it)('does NOT return a bare array (old behavior)', () => {
        // The old code did: return reply.send(normalized)
        // The new code should return an object with data/total/has_more
        // Check that the send call includes 'data:' property
        strict_1.default.match(INTERNAL, /reply\.send\(\s*\{\s*data:/);
    });
    (0, node_test_1.it)('logs each call with IP and params (monitor 400s after deploy)', () => {
        strict_1.default.match(INTERNAL, /\[internal\/bsc-addresses\]/);
        strict_1.default.match(INTERNAL, /paginated query/);
        strict_1.default.match(INTERNAL, /request\.ip/);
    });
    (0, node_test_1.it)('logs 400s with IP and user-agent', () => {
        strict_1.default.match(INTERNAL, /400 — missing pagination params/);
        strict_1.default.match(INTERNAL, /userAgent/);
    });
    (0, node_test_1.it)('preserves the blockchain_address lowercase normalization', () => {
        strict_1.default.match(INTERNAL, /blockchain_address\?\.toLowerCase\(\)/);
    });
    (0, node_test_1.it)('preserves the rate limit (30 per minute)', () => {
        strict_1.default.match(INTERNAL, /max:\s*30/);
    });
    (0, node_test_1.it)('preserves the bridge inbound key auth', () => {
        strict_1.default.match(INTERNAL, /requireBridgeInboundKey/);
    });
});
//# sourceMappingURL=m10-pagination.test.js.map