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
 * M1 remediation tests — constant-time signature comparison.
 *
 * Verifies that webhook signature comparisons use safeSecretEqual
 * instead of === (which is vulnerable to timing attacks).
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const AVADA = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'services/avada.ts'), 'utf-8');
const UNIPESA = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'lib/unipesa.ts'), 'utf-8');
(0, node_test_1.describe)('M1 — avada.ts uses safeSecretEqual for signature comparison', () => {
    (0, node_test_1.it)('imports safeSecretEqual from security/secret-compare', () => {
        strict_1.default.match(AVADA, /import.*safeSecretEqual.*from.*secret-compare/);
    });
    (0, node_test_1.it)('verifyCallbackSignature uses safeSecretEqual (not ===)', () => {
        const section = AVADA.match(/export function verifyCallbackSignature[\s\S]*?^}/m);
        strict_1.default.ok(section, 'must find verifyCallbackSignature function');
        strict_1.default.match(section[0], /safeSecretEqual/);
        strict_1.default.doesNotMatch(section[0], /===\s*expected/);
    });
    (0, node_test_1.it)('does NOT use === for signature comparison anywhere in the file', () => {
        // The only === involving "signature" should be the `key === 'signature'` skip
        // in calculateSignature, not a comparison of signature values
        const lines = AVADA.split('\n');
        for (const line of lines) {
            // Skip the `if (key === 'signature') continue` line
            if (/key\s*===\s*['"]signature['"]/.test(line))
                continue;
            // Flag any === comparison involving signature or toLowerCase
            if (/signature.*===|===.*signature/.test(line) && !/safeSecretEqual/.test(line)) {
                strict_1.default.fail(`Unsafe signature comparison found: ${line.trim()}`);
            }
            if (/\.toLowerCase\(\)\s*===.*\.toLowerCase\(\)/.test(line)) {
                strict_1.default.fail(`Unsafe toLowerCase comparison found: ${line.trim()}`);
            }
        }
    });
});
(0, node_test_1.describe)('M1 — unipesa.ts uses safeSecretEqual for signature comparison', () => {
    (0, node_test_1.it)('imports safeSecretEqual from security/secret-compare', () => {
        strict_1.default.match(UNIPESA, /import.*safeSecretEqual.*from.*secret-compare/);
    });
    (0, node_test_1.it)('verifyCallbackSignature uses safeSecretEqual (not ===)', () => {
        const section = UNIPESA.match(/export function verifyCallbackSignature[\s\S]*?^}/m);
        strict_1.default.ok(section, 'must find verifyCallbackSignature function');
        strict_1.default.match(section[0], /safeSecretEqual/);
        strict_1.default.doesNotMatch(section[0], /===\s*expected/);
    });
    (0, node_test_1.it)('does NOT use === for signature comparison anywhere in the file', () => {
        const lines = UNIPESA.split('\n');
        for (const line of lines) {
            if (/key\s*===\s*['"]signature['"]/.test(line))
                continue;
            if (/signature.*===|===.*signature/.test(line) && !/safeSecretEqual/.test(line)) {
                strict_1.default.fail(`Unsafe signature comparison found: ${line.trim()}`);
            }
            if (/\.toLowerCase\(\)\s*===.*\.toLowerCase\(\)/.test(line)) {
                strict_1.default.fail(`Unsafe toLowerCase comparison found: ${line.trim()}`);
            }
        }
    });
});
//# sourceMappingURL=m1-constant-time-signature.test.js.map