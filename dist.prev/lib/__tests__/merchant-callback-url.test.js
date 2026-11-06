"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Test: merchant callback URL is distinct from wallet callback URL.
 *
 * Bug: avada.ts (merchant flow) used env.UNIPESA_CALLBACK_URL, which is the
 * SAME variable used by unipesa.ts (wallet flow). If the env var points to
 * /v1/wallet/unipesa/callback, merchant transaction callbacks are misrouted.
 *
 * Fix: avada.ts now uses UNIPESA_MERCHANT_CALLBACK_URL (with fallback to
 * UNIPESA_CALLBACK_URL for backward compat).
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const AVADA_SRC = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../services/avada.ts'), 'utf-8');
const ENV_SRC = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../config/env.ts'), 'utf-8');
const UNIPESA_SRC = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../lib/unipesa.ts'), 'utf-8');
(0, node_test_1.describe)('merchant callback URL isolation', () => {
    (0, node_test_1.it)('avada.ts uses UNIPESA_MERCHANT_CALLBACK_URL (not UNIPESA_CALLBACK_URL)', () => {
        strict_1.default.match(AVADA_SRC, /UNIPESA_MERCHANT_CALLBACK_URL/, 'avada.ts must use UNIPESA_MERCHANT_CALLBACK_URL');
    });
    (0, node_test_1.it)('avada.ts falls back to UNIPESA_CALLBACK_URL for backward compat', () => {
        strict_1.default.match(AVADA_SRC, /env\.UNIPESA_MERCHANT_CALLBACK_URL\s*\?\?\s*env\.UNIPESA_CALLBACK_URL/, 'avada.ts must fall back to UNIPESA_CALLBACK_URL if merchant URL is not set');
    });
    (0, node_test_1.it)('avada.ts does NOT use UNIPESA_CALLBACK_URL as its primary source', () => {
        // The requireUnipesaEnv function should reference MERCHANT_CALLBACK_URL first
        const requireFnMatch = AVADA_SRC.match(/function requireUnipesaEnv[\s\S]*?return\s*\{[^}]*\};?\s*\}/);
        strict_1.default.ok(requireFnMatch, 'must find requireUnipesaEnv function');
        strict_1.default.match(requireFnMatch[0], /UNIPESA_MERCHANT_CALLBACK_URL/, 'requireUnipesaEnv must use UNIPESA_MERCHANT_CALLBACK_URL');
    });
    (0, node_test_1.it)('unipesa.ts (wallet) still uses UNIPESA_CALLBACK_URL (unchanged)', () => {
        strict_1.default.match(UNIPESA_SRC, /UNIPESA_CALLBACK_URL/, 'unipesa.ts must still use UNIPESA_CALLBACK_URL for wallet flow');
        strict_1.default.doesNotMatch(UNIPESA_SRC, /UNIPESA_MERCHANT_CALLBACK_URL/, 'unipesa.ts must NOT use the merchant callback URL');
    });
    (0, node_test_1.it)('env.ts declares UNIPESA_MERCHANT_CALLBACK_URL', () => {
        strict_1.default.match(ENV_SRC, /UNIPESA_MERCHANT_CALLBACK_URL/, 'env.ts must declare UNIPESA_MERCHANT_CALLBACK_URL');
    });
    (0, node_test_1.it)('env.ts still declares UNIPESA_CALLBACK_URL (for wallet)', () => {
        strict_1.default.match(ENV_SRC, /UNIPESA_CALLBACK_URL/, 'env.ts must still declare UNIPESA_CALLBACK_URL for wallet flow');
    });
    (0, node_test_1.it)('.env.example documents both URLs with distinct paths', () => {
        const envExample = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../../.env.example'), 'utf-8');
        strict_1.default.match(envExample, /UNIPESA_CALLBACK_URL.*wallet\/unipesa\/callback/, '.env.example must show UNIPESA_CALLBACK_URL pointing to wallet callback');
        strict_1.default.match(envExample, /UNIPESA_MERCHANT_CALLBACK_URL.*payment\/callback/, '.env.example must show UNIPESA_MERCHANT_CALLBACK_URL pointing to payment callback');
    });
});
//# sourceMappingURL=merchant-callback-url.test.js.map