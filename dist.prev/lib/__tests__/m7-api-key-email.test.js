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
 * M7 remediation tests — API key no longer sent in clear by email.
 *
 * The original register.ts sent the full API key in the welcome email.
 * Email is an unencrypted channel — the key could be intercepted, archived
 * indefinitely, or read by a third party with mailbox access.
 *
 * Fix:
 *   - sendWelcomeEmail no longer accepts or sends the API key
 *   - The email contains a link to the dashboard instead
 *   - The API key is still returned in the HTTP response (register.ts:146)
 *   - The frontend (unipay-congo) now displays the key at registration time
 *     with a "note this key now" warning
 *
 * Tests verify:
 *   - sendWelcomeEmail signature no longer accepts apiKey
 *   - The email body does not contain the key
 *   - The email contains a dashboard link
 *   - register.ts still returns the key in the HTTP response
 *   - register.ts calls sendWelcomeEmail without the key
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const EMAIL = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'services/email.ts'), 'utf-8');
const REGISTER = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/merchant/register.ts'), 'utf-8');
// ── email.ts tests ───────────────────────────────────────────
(0, node_test_1.describe)('M7-email — no API key in welcome email', () => {
    (0, node_test_1.it)('sendWelcomeEmail does NOT accept apiKey parameter', () => {
        // The old signature was: sendWelcomeEmail(to, name, apiKey)
        // The new signature should be: sendWelcomeEmail(to, name)
        const sigMatch = EMAIL.match(/export async function sendWelcomeEmail\([^)]*\)/);
        strict_1.default.ok(sigMatch, 'must find sendWelcomeEmail function');
        strict_1.default.doesNotMatch(sigMatch[0], /apiKey/i);
    });
    (0, node_test_1.it)('sendWelcomeEmail body does NOT contain apiKey variable interpolation', () => {
        // The old email had: ${apiKey}
        // Find the function body and check it doesn't interpolate apiKey
        const funcMatch = EMAIL.match(/export async function sendWelcomeEmail[\s\S]*?^}/m);
        strict_1.default.ok(funcMatch, 'must find sendWelcomeEmail function body');
        strict_1.default.doesNotMatch(funcMatch[0], /\$\{apiKey\}/);
    });
    (0, node_test_1.it)('email body contains a dashboard link', () => {
        const funcMatch = EMAIL.match(/export async function sendWelcomeEmail[\s\S]*?^}/m);
        strict_1.default.ok(funcMatch, 'must find sendWelcomeEmail function body');
        strict_1.default.match(funcMatch[0], /dashboard\/api-keys/i);
    });
    (0, node_test_1.it)('email body mentions security reason for not including key', () => {
        const funcMatch = EMAIL.match(/export async function sendWelcomeEmail[\s\S]*?^}/m);
        strict_1.default.ok(funcMatch, 'must find sendWelcomeEmail function body');
        strict_1.default.match(funcMatch[0], /sécurité|security/i);
    });
});
// ── register.ts tests ────────────────────────────────────────
(0, node_test_1.describe)('M7-register — still returns key in HTTP response, not email', () => {
    (0, node_test_1.it)('calls sendWelcomeEmail without apiKey', () => {
        // The old call was: sendWelcomeEmail(email, name, rawKey)
        // The new call should be: sendWelcomeEmail(email, name)
        strict_1.default.doesNotMatch(REGISTER, /sendWelcomeEmail\(email,\s*name,\s*rawKey\)/);
        strict_1.default.match(REGISTER, /sendWelcomeEmail\(email,\s*name\)/);
    });
    (0, node_test_1.it)('still returns api_key in the HTTP response', () => {
        // The API response must still contain the key — it's the primary channel
        strict_1.default.match(REGISTER, /api_key:\s*rawKey/);
    });
    (0, node_test_1.it)('still generates the API key (rawKey variable exists)', () => {
        strict_1.default.match(REGISTER, /const rawKey\s*=/);
        strict_1.default.match(REGISTER, /bcrypt\.hash\(rawKey/);
    });
});
//# sourceMappingURL=m7-api-key-email.test.js.map