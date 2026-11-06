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
 * C3 remediation tests — rate-limit bypass fix + PIN lockout.
 *
 * Verifies:
 *   1. The global rate-limit keyGenerator no longer trusts x-api-key.
 *   2. trustProxy is enabled so req.ip is the real client IP.
 *   3. All 5 auth routes have explicit IP-based rateLimit configs.
 *   4. The pin-lockout helper implements escalating lockout durations.
 *   5. The wallet login route checks lockout before PIN verification.
 */
const ROOT = node_path_1.default.resolve(__dirname, '../..');
const SERVER = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'server.ts'), 'utf-8');
const AUTH = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'routes/wallet/auth.ts'), 'utf-8');
const MERCHANT_LOGIN = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'routes/merchant/login.ts'), 'utf-8');
const MERCHANT_REGISTER = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'routes/merchant/register.ts'), 'utf-8');
const PIN_LOCKOUT = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'lib/pin-lockout.ts'), 'utf-8');
function readSrc(rel) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, rel), 'utf-8');
}
// ─── C3.1: Global keyGenerator no longer trusts x-api-key ───────
(0, node_test_1.describe)('C3.1 — Global keyGenerator uses req.ip only', () => {
    (0, node_test_1.it)('does not use x-api-key in the global keyGenerator function', () => {
        // Extract just the keyGenerator line (not comments)
        const keyGenMatch = SERVER.match(/keyGenerator:\s*\(req\)\s*=>\s*([^,;\n]+)/);
        strict_1.default.ok(keyGenMatch, 'must find global keyGenerator');
        const keyGenBody = keyGenMatch[1];
        strict_1.default.doesNotMatch(keyGenBody, /x-api-key/, 'global keyGenerator must NOT use x-api-key header');
        strict_1.default.match(keyGenBody, /req\.ip/, 'global keyGenerator must use req.ip');
    });
});
// ─── C3.2: trustProxy enabled ──────────────────────────────────
(0, node_test_1.describe)('C3.2 — trustProxy is enabled', () => {
    (0, node_test_1.it)('Fastify is instantiated with trustProxy: true', () => {
        strict_1.default.match(SERVER, /trustProxy:\s*true/, 'must enable trustProxy so req.ip reflects the real client IP behind the proxy');
    });
});
// ─── C3.3: Auth routes have explicit IP-based rateLimit ────────
(0, node_test_1.describe)('C3.3 — Auth routes have explicit IP-based rateLimit', () => {
    (0, node_test_1.it)('POST /wallet/login has rateLimit with IP keyGenerator', () => {
        const section = AUTH.match(/\/wallet\/login[\s\S]*?async\s*\(request/);
        strict_1.default.ok(section, 'must find wallet/login route');
        strict_1.default.match(section[0], /rateLimit/);
        strict_1.default.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
    });
    (0, node_test_1.it)('POST /wallet/register has rateLimit with IP keyGenerator', () => {
        const section = AUTH.match(/\/wallet\/register[\s\S]*?async\s*\(request/);
        strict_1.default.ok(section, 'must find wallet/register route');
        strict_1.default.match(section[0], /rateLimit/);
        strict_1.default.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
    });
    (0, node_test_1.it)('POST /wallet/auth/refresh has rateLimit with IP keyGenerator', () => {
        const section = AUTH.match(/\/wallet\/auth\/refresh[\s\S]*?async\s*\(request/);
        strict_1.default.ok(section, 'must find wallet/auth/refresh route');
        strict_1.default.match(section[0], /rateLimit/);
        strict_1.default.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
    });
    (0, node_test_1.it)('POST /wallet/auth/change-pin has rateLimit with IP keyGenerator', () => {
        const section = AUTH.match(/\/wallet\/auth\/change-pin[\s\S]*?async\s*\(request/);
        strict_1.default.ok(section, 'must find wallet/auth/change-pin route');
        strict_1.default.match(section[0], /rateLimit/);
        strict_1.default.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
    });
    (0, node_test_1.it)('POST /merchant/login has rateLimit with IP keyGenerator', () => {
        strict_1.default.match(MERCHANT_LOGIN, /rateLimit/);
        strict_1.default.match(MERCHANT_LOGIN, /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
    });
    (0, node_test_1.it)('POST /merchant/register has rateLimit with IP keyGenerator', () => {
        strict_1.default.match(MERCHANT_REGISTER, /rateLimit/);
        strict_1.default.match(MERCHANT_REGISTER, /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
    });
});
// ─── C3.4: PIN lockout helper ──────────────────────────────────
(0, node_test_1.describe)('C3.4 — pin-lockout helper', () => {
    (0, node_test_1.it)('exports MAX_FAILED_PIN_ATTEMPTS = 5', () => {
        strict_1.default.match(PIN_LOCKOUT, /MAX_FAILED_PIN_ATTEMPTS\s*=\s*5/);
    });
    (0, node_test_1.it)('implements escalating lockout durations', () => {
        strict_1.default.match(PIN_LOCKOUT, /15\s*\*\s*60\s*\*\s*1000/); // 15 min
        strict_1.default.match(PIN_LOCKOUT, /60\s*\*\s*60\s*\*\s*1000/); // 1 h
        strict_1.default.match(PIN_LOCKOUT, /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/); // 24 h
        strict_1.default.match(PIN_LOCKOUT, /MAX_SAFE_INTEGER/); // permanent
    });
    (0, node_test_1.it)('exports recordFailedPinAttempt and resetPinLockout', () => {
        strict_1.default.match(PIN_LOCKOUT, /export async function recordFailedPinAttempt/);
        strict_1.default.match(PIN_LOCKOUT, /export async function resetPinLockout/);
    });
    (0, node_test_1.it)('resets all three counters on success (including pin_lockout_count)', () => {
        const resetBlock = PIN_LOCKOUT.match(/resetPinLockout[\s\S]*?\}\s*\)/);
        strict_1.default.ok(resetBlock);
        strict_1.default.match(resetBlock[0], /failed_pin_attempts:\s*0/);
        strict_1.default.match(resetBlock[0], /locked_until:\s*null/);
        strict_1.default.match(resetBlock[0], /pin_lockout_count:\s*0/);
    });
});
// ─── C3.5: Wallet login checks lockout before PIN ─────────────
(0, node_test_1.describe)('C3.5 — wallet/login checks lockout', () => {
    (0, node_test_1.it)('selects lockout columns from wallet_users in login route', () => {
        // Find the login route handler body (up to the next route or end of plugin)
        const loginSection = AUTH.match(/\/wallet\/login[\s\S]*?\/wallet\/auth\/refresh/);
        strict_1.default.ok(loginSection, 'must find wallet/login route section');
        const selectMatch = loginSection[0].match(/from\('wallet_users'\)[\s\S]*?\.maybeSingle\(\)/);
        strict_1.default.ok(selectMatch, 'must find wallet_users select in login route');
        strict_1.default.match(selectMatch[0], /failed_pin_attempts/);
        strict_1.default.match(selectMatch[0], /locked_until/);
        strict_1.default.match(selectMatch[0], /pin_lockout_count/);
    });
    (0, node_test_1.it)('returns 423 when account is locked', () => {
        strict_1.default.match(AUTH, /status\(423\)/);
        strict_1.default.match(AUTH, /Account temporarily locked|Account locked/);
    });
    (0, node_test_1.it)('calls recordFailedPinAttempt on PIN failure', () => {
        strict_1.default.match(AUTH, /recordFailedPinAttempt/);
    });
    (0, node_test_1.it)('calls resetPinLockout on PIN success', () => {
        strict_1.default.match(AUTH, /resetPinLockout/);
    });
});
// ─── C3.6: change-pin also has lockout ─────────────────────────
(0, node_test_1.describe)('C3.6 — change-pin has lockout', () => {
    (0, node_test_1.it)('selects lockout columns', () => {
        const changePinSection = AUTH.match(/\/wallet\/auth\/change-pin[\s\S]*?(async|return)/);
        strict_1.default.ok(changePinSection);
        // The select in change-pin should include lockout columns
        strict_1.default.match(AUTH, /failed_pin_attempts, locked_until, pin_lockout_count/);
    });
    (0, node_test_1.it)('returns 423 when locked', () => {
        // Count 423 occurrences — login + change-pin both use it
        const matches = AUTH.match(/status\(423\)/g);
        strict_1.default.ok(matches && matches.length >= 2, `expected ≥2 status(423) in auth.ts, got ${matches?.length}`);
    });
});
// ─── C3.7: sensitive-session/reactivate has lockout ────────────
(0, node_test_1.describe)('C3.7 — sensitive-session/reactivate has lockout', () => {
    const SRC = readSrc('routes/wallet/sensitive-session.ts');
    (0, node_test_1.it)('imports pin-lockout helpers', () => {
        strict_1.default.match(SRC, /from '.*pin-lockout/);
        strict_1.default.match(SRC, /getLockoutDeadline/);
        strict_1.default.match(SRC, /recordFailedPinAttempt/);
        strict_1.default.match(SRC, /resetPinLockout/);
    });
    (0, node_test_1.it)('returns 423 when locked', () => {
        strict_1.default.match(SRC, /status\(423\)/);
    });
});
// ─── C3.8: Migration exists ─────────────────────────────────────
(0, node_test_1.describe)('C3.8 — lockout migration', () => {
    const MIGRATIONS = node_path_1.default.resolve(ROOT, '../supabase/migrations');
    const files = node_fs_1.default.readdirSync(MIGRATIONS);
    const lockoutMigration = files.find(f => f.includes('wallet_pin_lockout'));
    (0, node_test_1.it)('a migration file adds lockout columns to wallet_users', () => {
        strict_1.default.ok(lockoutMigration, 'must have a migration file for wallet PIN lockout');
    });
    if (lockoutMigration) {
        const migrationSrc = node_fs_1.default.readFileSync(node_path_1.default.resolve(MIGRATIONS, lockoutMigration), 'utf-8');
        (0, node_test_1.it)('adds failed_pin_attempts column', () => {
            strict_1.default.match(migrationSrc, /ADD COLUMN IF NOT EXISTS failed_pin_attempts/);
        });
        (0, node_test_1.it)('adds locked_until column', () => {
            strict_1.default.match(migrationSrc, /ADD COLUMN IF NOT EXISTS locked_until/);
        });
        (0, node_test_1.it)('adds pin_lockout_count column', () => {
            strict_1.default.match(migrationSrc, /ADD COLUMN IF NOT EXISTS pin_lockout_count/);
        });
    }
});
//# sourceMappingURL=c3-rate-limit-bypass.test.js.map