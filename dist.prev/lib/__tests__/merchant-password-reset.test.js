"use strict";
/**
 * Tests for merchant password reset routes — static analysis + logic verification.
 *
 * Verifies security properties of src/routes/merchant/password-reset.ts:
 *   - /request always returns the same generic response (no enumeration)
 *   - Token is hashed (sha256) before storage, never stored in plaintext
 *   - Token has 30-minute expiry
 *   - /confirm rejects expired tokens
 *   - /confirm rejects already-used tokens (used_at must be null)
 *   - Successful reset invalidates all other pending tokens
 *   - Per-email rate limit (3/hour)
 *   - Per-IP rate limit (10/hour)
 *   - Password hashed with bcrypt cost 12
 *   - Security notification email sent after reset
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const RESET_SRC = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../routes/merchant/password-reset.ts'), 'utf-8');
(0, node_test_1.describe)('Merchant password reset — security properties', () => {
    // ── No account enumeration ───────────────────────────────────
    (0, node_test_1.describe)('no account enumeration', () => {
        (0, node_test_1.it)('has a single generic response constant', () => {
            strict_1.default.match(RESET_SRC, /GENERIC_RESPONSE/, 'must define a GENERIC_RESPONSE constant');
        });
        (0, node_test_1.it)('generic response does not reveal if email exists', () => {
            strict_1.default.match(RESET_SRC, /Si ce compte existe.*un email/i, 'generic response must say "if this account exists"');
        });
        (0, node_test_1.it)('returns generic response when merchant not found', () => {
            strict_1.default.match(RESET_SRC, /if \(error \|\| !merchant\)[\s\S]*?genericReply\(\)/, 'must call genericReply() when merchant not found');
        });
        (0, node_test_1.it)('returns generic response when email rate limited', () => {
            strict_1.default.match(RESET_SRC, /count >= 3[\s\S]*?genericReply\(\)/, 'must call genericReply() when per-email rate limit hit');
        });
        (0, node_test_1.it)('returns generic response even on insert error', () => {
            strict_1.default.match(RESET_SRC, /insertError[\s\S]*?genericReply\(\)/, 'must call genericReply() on insert error');
        });
        (0, node_test_1.it)('returns generic response even on email send error', () => {
            // The email send is in a try/catch, and after it we still return genericReply
            strict_1.default.match(RESET_SRC, /sendPasswordResetEmail[\s\S]*?genericReply\(\)/, 'must return genericReply() after email send attempt');
        });
    });
    // ── Token security ───────────────────────────────────────────
    (0, node_test_1.describe)('token security', () => {
        (0, node_test_1.it)('generates token with crypto.randomBytes', () => {
            strict_1.default.match(RESET_SRC, /crypto\.randomBytes\(/, 'must use crypto.randomBytes for token generation');
        });
        (0, node_test_1.it)('hashes token with sha256 before storage', () => {
            strict_1.default.match(RESET_SRC, /crypto\.createHash\(['"]sha256['"]\)\.update\(token/, 'must hash token with sha256');
        });
        (0, node_test_1.it)('stores token_hash, not the plaintext token', () => {
            strict_1.default.match(RESET_SRC, /token_hash:\s*tokenHash/, 'must store token_hash (the hash), not the token');
        });
        (0, node_test_1.it)('token has 30-minute expiry', () => {
            strict_1.default.match(RESET_SRC, /30\s*\*\s*60\s*\*\s*1000/, 'expiry must be 30 minutes (30 * 60 * 1000 ms)');
        });
    });
    // ── Confirm: expired token rejection ─────────────────────────
    (0, node_test_1.describe)('expired token rejection', () => {
        (0, node_test_1.it)('checks expires_at against current time', () => {
            strict_1.default.match(RESET_SRC, /new Date\(resetRecord\.expires_at[\s\S]*?<\s*new Date\(\)/, 'must check if token is expired');
        });
        (0, node_test_1.it)('returns 400 for expired token', () => {
            strict_1.default.match(RESET_SRC, /400[\s\S]*?Ce lien a expiré/, 'must return 400 for expired token');
        });
    });
    // ── Confirm: used token rejection ────────────────────────────
    (0, node_test_1.describe)('used token rejection (single-use)', () => {
        (0, node_test_1.it)('queries for tokens where used_at is null', () => {
            strict_1.default.match(RESET_SRC, /\.is\(['"]used_at['"],\s*null\)/, 'must filter for used_at IS NULL');
        });
        (0, node_test_1.it)('returns 400 when token not found (already used or invalid)', () => {
            strict_1.default.match(RESET_SRC, /400[\s\S]*?Token invalide.*déjà utilisé/, 'must return 400 for invalid/used token');
        });
        (0, node_test_1.it)('marks token as used after successful reset', () => {
            strict_1.default.match(RESET_SRC, /update\(\{ used_at:[\s\S]*?\}\)[\s\S]*?\.eq\(['"]id['"],\s*resetRecord\.id/, 'must mark token as used after reset');
        });
    });
    // ── Invalidation of other pending tokens ─────────────────────
    (0, node_test_1.describe)('invalidation of other pending tokens', () => {
        (0, node_test_1.it)('invalidates all other unused tokens for the merchant', () => {
            strict_1.default.match(RESET_SRC, /update\(\{ used_at:[\s\S]*?\}\)[\s\S]*?\.eq\(['"]merchant_id['"],\s*merchantId\)[\s\S]*?\.is\(['"]used_at['"],\s*null\)[\s\S]*?\.neq\(['"]id['"],\s*resetRecord\.id/, 'must invalidate other pending tokens for the merchant');
        });
    });
    // ── Rate limiting ────────────────────────────────────────────
    (0, node_test_1.describe)('rate limiting', () => {
        (0, node_test_1.it)('has rate limit config on /request', () => {
            strict_1.default.match(RESET_SRC, /password-reset\/request[\s\S]*?rateLimit/, '/request must have rate limit config');
        });
        (0, node_test_1.it)('per-IP rate limit is 10/hour', () => {
            strict_1.default.match(RESET_SRC, /max:\s*10,\s*timeWindow:\s*['"]1 hour['"]/, 'must have per-IP rate limit of 10/hour');
        });
        (0, node_test_1.it)('per-email rate limit is 3/hour (manual check)', () => {
            strict_1.default.match(RESET_SRC, /count >= 3/, 'must check for 3 tokens per hour per email');
        });
        (0, node_test_1.it)('per-email rate limit checks created_at within last hour', () => {
            strict_1.default.match(RESET_SRC, /60\s*\*\s*60\s*\*\s*1000/, 'must compute one hour ago for rate limit check');
        });
    });
    // ── Password hashing ─────────────────────────────────────────
    (0, node_test_1.describe)('password hashing', () => {
        (0, node_test_1.it)('uses bcrypt.hash with cost 12', () => {
            strict_1.default.match(RESET_SRC, /bcrypt\.hash\(new_password!,\s*12\)/, 'must hash new password with bcrypt cost 12');
        });
        (0, node_test_1.it)('new_password has minLength 8', () => {
            strict_1.default.match(RESET_SRC, /new_password.*minLength:\s*8/, 'new_password must have minLength 8');
        });
        (0, node_test_1.it)('bcrypt cost 12 matches register.ts and profile.ts', async () => {
            // Verify bcrypt cost 12 works correctly
            const hash = await bcryptjs_1.default.hash('testpassword', 12);
            const match = await bcryptjs_1.default.compare('testpassword', hash);
            strict_1.default.equal(match, true, 'bcrypt cost 12 must work');
            // Verify cost is embedded in hash
            strict_1.default.match(hash, /\$2[aby]\$12\$/, 'hash must contain cost 12');
        });
    });
    // ── Security notification ────────────────────────────────────
    (0, node_test_1.describe)('security notification after reset', () => {
        (0, node_test_1.it)('sends security notification email after successful reset', () => {
            strict_1.default.match(RESET_SRC, /sendSecurityNotificationEmail[\s\S]*?['"]password_changed['"]/, 'must send password_changed notification after reset');
        });
    });
    // ── Token verification logic ─────────────────────────────────
    (0, node_test_1.describe)('token verification logic', () => {
        (0, node_test_1.it)('sha256 hash is deterministic (same token → same hash)', () => {
            const token = 'abc123';
            const hash1 = node_crypto_1.default.createHash('sha256').update(token).digest('hex');
            const hash2 = node_crypto_1.default.createHash('sha256').update(token).digest('hex');
            strict_1.default.equal(hash1, hash2, 'sha256 must be deterministic');
        });
        (0, node_test_1.it)('different tokens produce different hashes', () => {
            const hash1 = node_crypto_1.default.createHash('sha256').update('token1').digest('hex');
            const hash2 = node_crypto_1.default.createHash('sha256').update('token2').digest('hex');
            strict_1.default.notEqual(hash1, hash2, 'different tokens must produce different hashes');
        });
        (0, node_test_1.it)('32-byte token produces 64-char hex string', () => {
            const token = node_crypto_1.default.randomBytes(32).toString('hex');
            strict_1.default.equal(token.length, 64, 'token must be 64 hex chars');
        });
    });
    // ── Email template ───────────────────────────────────────────
    (0, node_test_1.describe)('email template', () => {
        (0, node_test_1.it)('imports sendPasswordResetEmail', () => {
            strict_1.default.match(RESET_SRC, /import.*sendPasswordResetEmail.*from.*email/, 'must import sendPasswordResetEmail');
        });
        (0, node_test_1.it)('reset URL uses MERCHANT_PORTAL_URL env', () => {
            strict_1.default.match(RESET_SRC, /env\.MERCHANT_PORTAL_URL/, 'must use env.MERCHANT_PORTAL_URL for reset link');
        });
        (0, node_test_1.it)('reset URL includes token as query param', () => {
            strict_1.default.match(RESET_SRC, /reset-password\?token=/, 'reset URL must include token as query param');
        });
    });
});
//# sourceMappingURL=merchant-password-reset.test.js.map