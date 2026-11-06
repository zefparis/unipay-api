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
 * H2 remediation tests — JWT session revocation via token_version.
 *
 * Verifies:
 *   - Migration adds token_version to merchants + wallet_users
 *   - Migration creates increment RPCs
 *   - JWT payloads include token_version (merchant + wallet + refresh)
 *   - Pre-migration tokens (without token_version) treated as version 0
 *   - Auth middleware rejects stale token_version with 401 TOKEN_REVOKED
 *   - Login includes token_version in JWT but does NOT increment DB version
 *   - Password reset increments token_version
 *   - Change-pin increments token_version
 *   - Admin suspend/block increments token_version
 *   - Refresh route checks token_version before issuing new access token
 *   - Admin manual revocation routes exist
 *   - Multi-session: two logins produce tokens with the same token_version
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const JWT = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'utils/jwt.ts'), 'utf-8');
const WALLET_JWT = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'utils/wallet-jwt.ts'), 'utf-8');
const MERCHANT_AUTH = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'lib/merchant-auth.ts'), 'utf-8');
const WALLET_AUTH = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'lib/wallet-auth.ts'), 'utf-8');
const LOGIN = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/merchant/login.ts'), 'utf-8');
const WALLET_AUTH_ROUTE = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/auth.ts'), 'utf-8');
const PASSWORD_RESET = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/merchant/password-reset.ts'), 'utf-8');
const ADMIN_MERCHANTS = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/admin/merchants.ts'), 'utf-8');
const ADMIN_WALLET = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/admin/wallet.ts'), 'utf-8');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260923000000_token_revocation.sql'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('H2-migration — token_version columns', () => {
    (0, node_test_1.it)('adds token_version integer NOT NULL DEFAULT 0 to merchants', () => {
        strict_1.default.match(MIGRATION, /ALTER TABLE public\.merchants\s+ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0/i);
    });
    (0, node_test_1.it)('adds token_version integer NOT NULL DEFAULT 0 to wallet_users', () => {
        strict_1.default.match(MIGRATION, /ALTER TABLE public\.wallet_users\s+ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0/i);
    });
    (0, node_test_1.it)('comments on merchants.token_version explaining the policy', () => {
        strict_1.default.match(MIGRATION, /COMMENT ON COLUMN public\.merchants\.token_version/i);
        strict_1.default.match(MIGRATION, /JWT revocation version/i);
        strict_1.default.match(MIGRATION, /multi-session allowed/i);
    });
    (0, node_test_1.it)('comments on wallet_users.token_version explaining the policy', () => {
        strict_1.default.match(MIGRATION, /COMMENT ON COLUMN public\.wallet_users\.token_version/i);
        strict_1.default.match(MIGRATION, /JWT revocation version/i);
        strict_1.default.match(MIGRATION, /multi-session allowed/i);
    });
});
(0, node_test_1.describe)('H2-migration — increment RPCs', () => {
    (0, node_test_1.it)('creates increment_merchant_token_version RPC', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.increment_merchant_token_version/i);
        strict_1.default.match(MIGRATION, /increment_merchant_token_version[\s\S]*?SECURITY DEFINER/);
        strict_1.default.match(MIGRATION, /increment_merchant_token_version[\s\S]*?token_version \+ 1/);
    });
    (0, node_test_1.it)('creates increment_wallet_token_version RPC', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.increment_wallet_token_version/i);
        strict_1.default.match(MIGRATION, /increment_wallet_token_version[\s\S]*?SECURITY DEFINER/);
        strict_1.default.match(MIGRATION, /increment_wallet_token_version[\s\S]*?token_version \+ 1/);
    });
    (0, node_test_1.it)('grants EXECUTE on both RPCs to service_role', () => {
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.increment_merchant_token_version TO service_role/);
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.increment_wallet_token_version TO service_role/);
    });
});
// ── JWT payload tests ─────────────────────────────────────────
(0, node_test_1.describe)('H2-jwt — merchant JWT payload includes token_version', () => {
    (0, node_test_1.it)('JwtPayload interface has token_version: number', () => {
        strict_1.default.match(JWT, /interface JwtPayload[\s\S]*?token_version:\s*number/);
    });
    (0, node_test_1.it)('signToken accepts token_version in payload (via Omit)', () => {
        strict_1.default.match(JWT, /signToken\(\s*payload:\s*Omit<JwtPayload,\s*'iat'\s*\|\s*'exp'>/);
    });
    (0, node_test_1.it)('verifyToken backfills missing token_version as 0 (pre-migration compat)', () => {
        strict_1.default.match(JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
    });
});
(0, node_test_1.describe)('H2-jwt — wallet JWT payload includes token_version', () => {
    (0, node_test_1.it)('WalletJwtPayload interface has token_version: number', () => {
        strict_1.default.match(WALLET_JWT, /interface WalletJwtPayload[\s\S]*?token_version:\s*number/);
    });
    (0, node_test_1.it)('verifyWalletToken backfills missing token_version as 0', () => {
        strict_1.default.match(WALLET_JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
    });
});
(0, node_test_1.describe)('H2-jwt — refresh token payload includes token_version', () => {
    (0, node_test_1.it)('RefreshTokenPayload interface has token_version: number', () => {
        strict_1.default.match(WALLET_JWT, /interface RefreshTokenPayload[\s\S]*?token_version:\s*number/);
    });
    (0, node_test_1.it)('signRefreshToken accepts token_version in payload', () => {
        strict_1.default.match(WALLET_JWT, /signRefreshToken\(\s*payload:\s*\{\s*wallet_id:\s*string;\s*token_version:\s*number/);
    });
    (0, node_test_1.it)('verifyRefreshToken backfills missing token_version as 0', () => {
        strict_1.default.match(WALLET_JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
    });
});
// ── Auth middleware tests ─────────────────────────────────────
(0, node_test_1.describe)('H2-middleware — merchant-auth checks token_version', () => {
    (0, node_test_1.it)('selects token_version from merchants', () => {
        strict_1.default.match(MERCHANT_AUTH, /select\('status,\s*token_version'\)/i);
    });
    (0, node_test_1.it)('rejects stale token_version with 401 TOKEN_REVOKED', () => {
        strict_1.default.match(MERCHANT_AUTH, /TOKEN_REVOKED/);
        strict_1.default.match(MERCHANT_AUTH, /status:\s*401/);
        strict_1.default.match(MERCHANT_AUTH, /payload\.token_version !== dbTokenVersion/);
    });
    (0, node_test_1.it)('uses default 0 when DB token_version is null (defensive)', () => {
        strict_1.default.match(MERCHANT_AUTH, /\?\? 0/);
    });
});
(0, node_test_1.describe)('H2-middleware — wallet-auth checks token_version', () => {
    (0, node_test_1.it)('includes token_version in the default select', () => {
        strict_1.default.match(WALLET_AUTH, /token_version/);
    });
    (0, node_test_1.it)('rejects stale token_version with 401 TOKEN_REVOKED', () => {
        strict_1.default.match(WALLET_AUTH, /TOKEN_REVOKED/);
        strict_1.default.match(WALLET_AUTH, /status:\s*401/);
        strict_1.default.match(WALLET_AUTH, /payload\.token_version !== dbTokenVersion/);
    });
});
// ── Login tests (multi-session) ───────────────────────────────
(0, node_test_1.describe)('H2-login — merchant login includes token_version but does NOT increment', () => {
    (0, node_test_1.it)('selects token_version from merchants at login', () => {
        strict_1.default.match(LOGIN, /select\('id,\s*name,\s*email,\s*password_hash,\s*status,\s*token_version'\)/i);
    });
    (0, node_test_1.it)('passes token_version to signToken', () => {
        strict_1.default.match(LOGIN, /token_version:/);
        strict_1.default.match(LOGIN, /signToken\(/);
    });
    (0, node_test_1.it)('does NOT call increment_merchant_token_version at login', () => {
        // Login should not increment — multi-session allowed
        strict_1.default.doesNotMatch(LOGIN, /increment_merchant_token_version/);
    });
});
(0, node_test_1.describe)('H2-login — wallet login includes token_version but does NOT increment', () => {
    (0, node_test_1.it)('selects token_version from wallet_users at login', () => {
        strict_1.default.match(WALLET_AUTH_ROUTE, /select\('id,\s*phone,\s*full_name,\s*pin_hash,\s*is_active,\s*failed_pin_attempts,\s*locked_until,\s*pin_lockout_count,\s*token_version'\)/i);
    });
    (0, node_test_1.it)('passes token_version to signWalletToken', () => {
        strict_1.default.match(WALLET_AUTH_ROUTE, /token_version:\s*tokenVersion/);
        strict_1.default.match(WALLET_AUTH_ROUTE, /signWalletToken\(/);
    });
    (0, node_test_1.it)('passes token_version to signRefreshToken', () => {
        strict_1.default.match(WALLET_AUTH_ROUTE, /signRefreshToken\(/);
        strict_1.default.match(WALLET_AUTH_ROUTE, /token_version:\s*tokenVersion/);
    });
    (0, node_test_1.it)('does NOT call increment_wallet_token_version at login', () => {
        // The login handler should not increment — multi-session allowed.
        // The increment only happens in change-pin.
        const loginSection = WALLET_AUTH_ROUTE.match(/POST \/v1\/wallet\/login[\s\S]*?return \{[\s\S]*?\}\s*\}/);
        strict_1.default.ok(loginSection, 'must find login route body');
        strict_1.default.doesNotMatch(loginSection[0], /increment_wallet_token_version/);
    });
});
// ── Password reset tests ──────────────────────────────────────
(0, node_test_1.describe)('H2-password-reset — increments token_version on success', () => {
    (0, node_test_1.it)('calls increment_merchant_token_version RPC after password update', () => {
        strict_1.default.match(PASSWORD_RESET, /increment_merchant_token_version/);
        strict_1.default.match(PASSWORD_RESET, /p_merchant_id:\s*merchantId/);
    });
    (0, node_test_1.it)('increments AFTER the password update succeeds (not before)', () => {
        const incrementPos = PASSWORD_RESET.indexOf('increment_merchant_token_version');
        const updatePos = PASSWORD_RESET.indexOf('password_hash: newPasswordHash');
        strict_1.default.ok(incrementPos > -1, 'must find increment call');
        strict_1.default.ok(updatePos > -1, 'must find password update');
        strict_1.default.ok(updatePos < incrementPos, 'password update must run BEFORE token_version increment');
    });
});
// ── Change-pin tests ──────────────────────────────────────────
(0, node_test_1.describe)('H2-change-pin — increments token_version on success', () => {
    (0, node_test_1.it)('calls increment_wallet_token_version RPC after PIN update', () => {
        strict_1.default.match(WALLET_AUTH_ROUTE, /increment_wallet_token_version/);
        strict_1.default.match(WALLET_AUTH_ROUTE, /p_wallet_id:\s*wp\.wallet_id/);
    });
    (0, node_test_1.it)('increments AFTER the PIN update succeeds (not before)', () => {
        const changePinSection = WALLET_AUTH_ROUTE.match(/POST \/v1\/wallet\/auth\/change-pin[\s\S]*?return reply\.send\(\{ ok: true \}\)/);
        strict_1.default.ok(changePinSection, 'must find change-pin route body');
        const incrementPos = changePinSection[0].indexOf('increment_wallet_token_version');
        const updatePos = changePinSection[0].indexOf('pin_hash: newHash');
        strict_1.default.ok(incrementPos > -1, 'must find increment call');
        strict_1.default.ok(updatePos > -1, 'must find PIN update');
        strict_1.default.ok(updatePos < incrementPos, 'PIN update must run BEFORE token_version increment');
    });
});
// ── Admin block/suspend tests ──────────────────────────────────
(0, node_test_1.describe)('H2-admin-suspend — increments token_version on merchant suspend', () => {
    (0, node_test_1.it)('calls increment_merchant_token_version on suspend', () => {
        const suspendSection = ADMIN_MERCHANTS.match(/\/admin\/merchants\/:id\/suspend[\s\S]*?return reply\.send\(\{ ok: true, merchant: data \}\)/);
        strict_1.default.ok(suspendSection, 'must find suspend route body');
        strict_1.default.match(suspendSection[0], /increment_merchant_token_version/);
    });
});
(0, node_test_1.describe)('H2-admin-block — increments token_version on wallet block', () => {
    (0, node_test_1.it)('calls increment_wallet_token_version on block', () => {
        const blockSection = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/block[\s\S]*?return reply\.send\(\{ ok: true, is_active: false \}\)/);
        strict_1.default.ok(blockSection, 'must find block route body');
        strict_1.default.match(blockSection[0], /increment_wallet_token_version/);
    });
});
// ── Refresh token tests ───────────────────────────────────────
(0, node_test_1.describe)('H2-refresh — checks token_version before issuing new access token', () => {
    (0, node_test_1.it)('selects token_version in the refresh DB lookup', () => {
        const refreshSection = WALLET_AUTH_ROUTE.match(/POST \/v1\/wallet\/auth\/refresh[\s\S]*?return \{ access_token: accessToken, expires_in: 3_600 \}/);
        strict_1.default.ok(refreshSection, 'must find refresh route body');
        strict_1.default.match(refreshSection[0], /token_version/);
    });
    (0, node_test_1.it)('rejects stale token_version with TOKEN_REVOKED before issuing new token', () => {
        const refreshSection = WALLET_AUTH_ROUTE.match(/POST \/v1\/wallet\/auth\/refresh[\s\S]*?return \{ access_token: accessToken, expires_in: 3_600 \}/);
        strict_1.default.ok(refreshSection);
        strict_1.default.match(refreshSection[0], /TOKEN_REVOKED/);
        // The check must happen BEFORE the signWalletToken call
        const checkPos = refreshSection[0].indexOf('TOKEN_REVOKED');
        const signPos = refreshSection[0].indexOf('signWalletToken');
        strict_1.default.ok(checkPos > -1 && signPos > -1);
        strict_1.default.ok(checkPos < signPos, 'token_version check must run BEFORE signWalletToken');
    });
    (0, node_test_1.it)('includes token_version in the new access token', () => {
        const refreshSection = WALLET_AUTH_ROUTE.match(/POST \/v1\/wallet\/auth\/refresh[\s\S]*?return \{ access_token: accessToken, expires_in: 3_600 \}/);
        strict_1.default.ok(refreshSection);
        strict_1.default.match(refreshSection[0], /token_version:\s*dbTokenVersion/);
    });
});
// ── Admin manual revocation routes ────────────────────────────
(0, node_test_1.describe)('H2-admin-revoke — manual revocation routes', () => {
    (0, node_test_1.it)('registers POST /admin/merchants/:id/revoke-sessions', () => {
        strict_1.default.match(ADMIN_MERCHANTS, /\/admin\/merchants\/:id\/revoke-sessions/);
    });
    (0, node_test_1.it)('merchant revoke-sessions is admin-protected', () => {
        const section = ADMIN_MERCHANTS.match(/\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /requireAdmin\(request\.isAdmin\)/);
        strict_1.default.match(section[0], /403/);
    });
    (0, node_test_1.it)('merchant revoke-sessions calls increment_merchant_token_version', () => {
        const section = ADMIN_MERCHANTS.match(/\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /increment_merchant_token_version/);
    });
    (0, node_test_1.it)('merchant revoke-sessions logs via logAdminAction', () => {
        const section = ADMIN_MERCHANTS.match(/\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /logAdminAction/);
        strict_1.default.match(section[0], /merchant\.revoke_sessions/);
    });
    (0, node_test_1.it)('merchant revoke-sessions returns 404 for non-existent merchant', () => {
        const section = ADMIN_MERCHANTS.match(/\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /404/);
        strict_1.default.match(section[0], /Merchant not found/);
    });
    (0, node_test_1.it)('registers POST /admin/wallet/users/:id/revoke-sessions', () => {
        strict_1.default.match(ADMIN_WALLET, /\/admin\/wallet\/users\/:id\/revoke-sessions/);
    });
    (0, node_test_1.it)('wallet revoke-sessions is admin-protected', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /requireAdmin\(request\.isAdmin\)/);
        strict_1.default.match(section[0], /403/);
    });
    (0, node_test_1.it)('wallet revoke-sessions calls increment_wallet_token_version', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /increment_wallet_token_version/);
    });
    (0, node_test_1.it)('wallet revoke-sessions logs via logAdminAction', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /logAdminAction/);
        strict_1.default.match(section[0], /wallet_user\.revoke_sessions/);
    });
});
// ── Pre-migration backward compatibility ──────────────────────
(0, node_test_1.describe)('H2-backward-compat — pre-migration tokens treated as version 0', () => {
    (0, node_test_1.it)('verifyToken backfills undefined token_version to 0', () => {
        strict_1.default.match(JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
    });
    (0, node_test_1.it)('verifyWalletToken backfills undefined token_version to 0', () => {
        strict_1.default.match(WALLET_JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
    });
    (0, node_test_1.it)('verifyRefreshToken backfills undefined token_version to 0', () => {
        // verifyRefreshToken also backfills — check it has the same pattern
        const refreshSection = WALLET_JWT.match(/verifyRefreshToken[\s\S]*?\n\}/);
        strict_1.default.ok(refreshSection);
        strict_1.default.match(refreshSection[0], /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
    });
    (0, node_test_1.it)('merchant-auth uses default 0 for DB token_version (null-safe)', () => {
        strict_1.default.match(MERCHANT_AUTH, /token_version.*\?\?\s*0/);
    });
    (0, node_test_1.it)('wallet-auth uses default 0 for DB token_version (null-safe)', () => {
        strict_1.default.match(WALLET_AUTH, /token_version.*\?\?\s*0/);
    });
});
//# sourceMappingURL=h2-token-revocation.test.js.map