import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const JWT = fs.readFileSync(path.resolve(SRC, 'utils/jwt.ts'), 'utf-8');
const WALLET_JWT = fs.readFileSync(path.resolve(SRC, 'utils/wallet-jwt.ts'), 'utf-8');
const MERCHANT_AUTH = fs.readFileSync(path.resolve(SRC, 'lib/merchant-auth.ts'), 'utf-8');
const WALLET_AUTH = fs.readFileSync(path.resolve(SRC, 'lib/wallet-auth.ts'), 'utf-8');
const LOGIN = fs.readFileSync(path.resolve(SRC, 'routes/merchant/login.ts'), 'utf-8');
const WALLET_AUTH_ROUTE = fs.readFileSync(path.resolve(SRC, 'routes/wallet/auth.ts'), 'utf-8');
const PASSWORD_RESET = fs.readFileSync(path.resolve(SRC, 'routes/merchant/password-reset.ts'), 'utf-8');
const ADMIN_MERCHANTS = fs.readFileSync(path.resolve(SRC, 'routes/admin/merchants.ts'), 'utf-8');
const ADMIN_WALLET = fs.readFileSync(path.resolve(SRC, 'routes/admin/wallet.ts'), 'utf-8');
const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260923000000_token_revocation.sql'),
  'utf-8',
);

// ── Migration tests ──────────────────────────────────────────

describe('H2-migration — token_version columns', () => {
  it('adds token_version integer NOT NULL DEFAULT 0 to merchants', () => {
    assert.match(
      MIGRATION,
      /ALTER TABLE public\.merchants\s+ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0/i,
    );
  });

  it('adds token_version integer NOT NULL DEFAULT 0 to wallet_users', () => {
    assert.match(
      MIGRATION,
      /ALTER TABLE public\.wallet_users\s+ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0/i,
    );
  });

  it('comments on merchants.token_version explaining the policy', () => {
    assert.match(MIGRATION, /COMMENT ON COLUMN public\.merchants\.token_version/i);
    assert.match(MIGRATION, /JWT revocation version/i);
    assert.match(MIGRATION, /multi-session allowed/i);
  });

  it('comments on wallet_users.token_version explaining the policy', () => {
    assert.match(MIGRATION, /COMMENT ON COLUMN public\.wallet_users\.token_version/i);
    assert.match(MIGRATION, /JWT revocation version/i);
    assert.match(MIGRATION, /multi-session allowed/i);
  });
});

describe('H2-migration — increment RPCs', () => {
  it('creates increment_merchant_token_version RPC', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.increment_merchant_token_version/i);
    assert.match(MIGRATION, /increment_merchant_token_version[\s\S]*?SECURITY DEFINER/);
    assert.match(MIGRATION, /increment_merchant_token_version[\s\S]*?token_version \+ 1/);
  });

  it('creates increment_wallet_token_version RPC', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.increment_wallet_token_version/i);
    assert.match(MIGRATION, /increment_wallet_token_version[\s\S]*?SECURITY DEFINER/);
    assert.match(MIGRATION, /increment_wallet_token_version[\s\S]*?token_version \+ 1/);
  });

  it('grants EXECUTE on both RPCs to service_role', () => {
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.increment_merchant_token_version TO service_role/);
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.increment_wallet_token_version TO service_role/);
  });
});

// ── JWT payload tests ─────────────────────────────────────────

describe('H2-jwt — merchant JWT payload includes token_version', () => {
  it('JwtPayload interface has token_version: number', () => {
    assert.match(JWT, /interface JwtPayload[\s\S]*?token_version:\s*number/);
  });

  it('signToken accepts token_version in payload (via Omit)', () => {
    assert.match(JWT, /signToken\(\s*payload:\s*Omit<JwtPayload,\s*'iat'\s*\|\s*'exp'>/);
  });

  it('verifyToken backfills missing token_version as 0 (pre-migration compat)', () => {
    assert.match(
      JWT,
      /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/,
    );
  });
});

describe('H2-jwt — wallet JWT payload includes token_version', () => {
  it('WalletJwtPayload interface has token_version: number', () => {
    assert.match(WALLET_JWT, /interface WalletJwtPayload[\s\S]*?token_version:\s*number/);
  });

  it('verifyWalletToken backfills missing token_version as 0', () => {
    assert.match(
      WALLET_JWT,
      /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/,
    );
  });
});

describe('H2-jwt — refresh token payload includes token_version', () => {
  it('RefreshTokenPayload interface has token_version: number', () => {
    assert.match(WALLET_JWT, /interface RefreshTokenPayload[\s\S]*?token_version:\s*number/);
  });

  it('signRefreshToken accepts token_version in payload', () => {
    assert.match(WALLET_JWT, /signRefreshToken\(\s*payload:\s*\{\s*wallet_id:\s*string;\s*token_version:\s*number/);
  });

  it('verifyRefreshToken backfills missing token_version as 0', () => {
    assert.match(
      WALLET_JWT,
      /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/,
    );
  });
});

// ── Auth middleware tests ─────────────────────────────────────

describe('H2-middleware — merchant-auth checks token_version', () => {
  it('selects token_version from merchants', () => {
    assert.match(MERCHANT_AUTH, /select\('status,\s*token_version'\)/i);
  });

  it('rejects stale token_version with 401 TOKEN_REVOKED', () => {
    assert.match(MERCHANT_AUTH, /TOKEN_REVOKED/);
    assert.match(MERCHANT_AUTH, /status:\s*401/);
    assert.match(MERCHANT_AUTH, /payload\.token_version !== dbTokenVersion/);
  });

  it('uses default 0 when DB token_version is null (defensive)', () => {
    assert.match(MERCHANT_AUTH, /\?\? 0/);
  });
});

describe('H2-middleware — wallet-auth checks token_version', () => {
  it('includes token_version in the default select', () => {
    assert.match(WALLET_AUTH, /token_version/);
  });

  it('rejects stale token_version with 401 TOKEN_REVOKED', () => {
    assert.match(WALLET_AUTH, /TOKEN_REVOKED/);
    assert.match(WALLET_AUTH, /status:\s*401/);
    assert.match(WALLET_AUTH, /payload\.token_version !== dbTokenVersion/);
  });
});

// ── Login tests (multi-session) ───────────────────────────────

describe('H2-login — merchant login includes token_version but does NOT increment', () => {
  it('selects token_version from merchants at login', () => {
    assert.match(LOGIN, /select\('id,\s*name,\s*email,\s*password_hash,\s*status,\s*token_version'\)/i);
  });

  it('passes token_version to signToken', () => {
    assert.match(LOGIN, /token_version:/);
    assert.match(LOGIN, /signToken\(/);
  });

  it('does NOT call increment_merchant_token_version at login', () => {
    // Login should not increment — multi-session allowed
    assert.doesNotMatch(LOGIN, /increment_merchant_token_version/);
  });
});

describe('H2-login — wallet login includes token_version but does NOT increment', () => {
  it('selects token_version from wallet_users at login', () => {
    assert.match(WALLET_AUTH_ROUTE, /select\('id,\s*phone,\s*full_name,\s*pin_hash,\s*is_active,\s*failed_pin_attempts,\s*locked_until,\s*pin_lockout_count,\s*token_version'\)/i);
  });

  it('passes token_version to signWalletToken', () => {
    assert.match(WALLET_AUTH_ROUTE, /token_version:\s*tokenVersion/);
    assert.match(WALLET_AUTH_ROUTE, /signWalletToken\(/);
  });

  it('passes token_version to signRefreshToken', () => {
    assert.match(WALLET_AUTH_ROUTE, /signRefreshToken\(/);
    assert.match(WALLET_AUTH_ROUTE, /token_version:\s*tokenVersion/);
  });

  it('does NOT call increment_wallet_token_version at login', () => {
    // The login handler should not increment — multi-session allowed.
    // The increment only happens in change-pin.
    const loginSection = WALLET_AUTH_ROUTE.match(
      /POST \/v1\/wallet\/login[\s\S]*?return \{[\s\S]*?\}\s*\}/,
    );
    assert.ok(loginSection, 'must find login route body');
    assert.doesNotMatch(loginSection[0], /increment_wallet_token_version/);
  });
});

// ── Password reset tests ──────────────────────────────────────

describe('H2-password-reset — increments token_version on success', () => {
  it('calls increment_merchant_token_version RPC after password update', () => {
    assert.match(PASSWORD_RESET, /increment_merchant_token_version/);
    assert.match(PASSWORD_RESET, /p_merchant_id:\s*merchantId/);
  });

  it('increments AFTER the password update succeeds (not before)', () => {
    const incrementPos = PASSWORD_RESET.indexOf('increment_merchant_token_version');
    const updatePos = PASSWORD_RESET.indexOf('password_hash: newPasswordHash');
    assert.ok(incrementPos > -1, 'must find increment call');
    assert.ok(updatePos > -1, 'must find password update');
    assert.ok(
      updatePos < incrementPos,
      'password update must run BEFORE token_version increment',
    );
  });
});

// ── Change-pin tests ──────────────────────────────────────────

describe('H2-change-pin — increments token_version on success', () => {
  it('calls increment_wallet_token_version RPC after PIN update', () => {
    assert.match(WALLET_AUTH_ROUTE, /increment_wallet_token_version/);
    assert.match(WALLET_AUTH_ROUTE, /p_wallet_id:\s*wp\.wallet_id/);
  });

  it('increments AFTER the PIN update succeeds (not before)', () => {
    const changePinSection = WALLET_AUTH_ROUTE.match(
      /POST \/v1\/wallet\/auth\/change-pin[\s\S]*?return reply\.send\(\{ ok: true \}\)/,
    );
    assert.ok(changePinSection, 'must find change-pin route body');
    const incrementPos = changePinSection[0].indexOf('increment_wallet_token_version');
    const updatePos = changePinSection[0].indexOf('pin_hash: newHash');
    assert.ok(incrementPos > -1, 'must find increment call');
    assert.ok(updatePos > -1, 'must find PIN update');
    assert.ok(
      updatePos < incrementPos,
      'PIN update must run BEFORE token_version increment',
    );
  });
});

// ── Admin block/suspend tests ──────────────────────────────────

describe('H2-admin-suspend — increments token_version on merchant suspend', () => {
  it('calls increment_merchant_token_version on suspend', () => {
    const suspendSection = ADMIN_MERCHANTS.match(
      /\/admin\/merchants\/:id\/suspend[\s\S]*?return reply\.send\(\{ ok: true, merchant: data \}\)/,
    );
    assert.ok(suspendSection, 'must find suspend route body');
    assert.match(suspendSection[0], /increment_merchant_token_version/);
  });
});

describe('H2-admin-block — increments token_version on wallet block', () => {
  it('calls increment_wallet_token_version on block', () => {
    const blockSection = ADMIN_WALLET.match(
      /\/admin\/wallet\/users\/:id\/block[\s\S]*?return reply\.send\(\{ ok: true, is_active: false \}\)/,
    );
    assert.ok(blockSection, 'must find block route body');
    assert.match(blockSection[0], /increment_wallet_token_version/);
  });
});

// ── Refresh token tests ───────────────────────────────────────

describe('H2-refresh — checks token_version before issuing new access token', () => {
  it('selects token_version in the refresh DB lookup', () => {
    const refreshSection = WALLET_AUTH_ROUTE.match(
      /POST \/v1\/wallet\/auth\/refresh[\s\S]*?return \{ access_token: accessToken, expires_in: 3_600 \}/,
    );
    assert.ok(refreshSection, 'must find refresh route body');
    assert.match(refreshSection[0], /token_version/);
  });

  it('rejects stale token_version with TOKEN_REVOKED before issuing new token', () => {
    const refreshSection = WALLET_AUTH_ROUTE.match(
      /POST \/v1\/wallet\/auth\/refresh[\s\S]*?return \{ access_token: accessToken, expires_in: 3_600 \}/,
    );
    assert.ok(refreshSection);
    assert.match(refreshSection[0], /TOKEN_REVOKED/);
    // The check must happen BEFORE the signWalletToken call
    const checkPos = refreshSection[0].indexOf('TOKEN_REVOKED');
    const signPos = refreshSection[0].indexOf('signWalletToken');
    assert.ok(checkPos > -1 && signPos > -1);
    assert.ok(checkPos < signPos, 'token_version check must run BEFORE signWalletToken');
  });

  it('includes token_version in the new access token', () => {
    const refreshSection = WALLET_AUTH_ROUTE.match(
      /POST \/v1\/wallet\/auth\/refresh[\s\S]*?return \{ access_token: accessToken, expires_in: 3_600 \}/,
    );
    assert.ok(refreshSection);
    assert.match(refreshSection[0], /token_version:\s*dbTokenVersion/);
  });
});

// ── Admin manual revocation routes ────────────────────────────

describe('H2-admin-revoke — manual revocation routes', () => {
  it('registers POST /admin/merchants/:id/revoke-sessions', () => {
    assert.match(ADMIN_MERCHANTS, /\/admin\/merchants\/:id\/revoke-sessions/);
  });

  it('merchant revoke-sessions is admin-protected', () => {
    const section = ADMIN_MERCHANTS.match(
      /\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /requireAdmin\(request\.isAdmin\)/);
    assert.match(section[0], /403/);
  });

  it('merchant revoke-sessions calls increment_merchant_token_version', () => {
    const section = ADMIN_MERCHANTS.match(
      /\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /increment_merchant_token_version/);
  });

  it('merchant revoke-sessions logs via logAdminAction', () => {
    const section = ADMIN_MERCHANTS.match(
      /\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /logAdminAction/);
    assert.match(section[0], /merchant\.revoke_sessions/);
  });

  it('merchant revoke-sessions returns 404 for non-existent merchant', () => {
    const section = ADMIN_MERCHANTS.match(
      /\/admin\/merchants\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /404/);
    assert.match(section[0], /Merchant not found/);
  });

  it('registers POST /admin/wallet/users/:id/revoke-sessions', () => {
    assert.match(ADMIN_WALLET, /\/admin\/wallet\/users\/:id\/revoke-sessions/);
  });

  it('wallet revoke-sessions is admin-protected', () => {
    const section = ADMIN_WALLET.match(
      /\/admin\/wallet\/users\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /requireAdmin\(request\.isAdmin\)/);
    assert.match(section[0], /403/);
  });

  it('wallet revoke-sessions calls increment_wallet_token_version', () => {
    const section = ADMIN_WALLET.match(
      /\/admin\/wallet\/users\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /increment_wallet_token_version/);
  });

  it('wallet revoke-sessions logs via logAdminAction', () => {
    const section = ADMIN_WALLET.match(
      /\/admin\/wallet\/users\/:id\/revoke-sessions[\s\S]*?return reply\.send\(\{ ok: true, new_token_version: result \}\)/,
    );
    assert.ok(section);
    assert.match(section[0], /logAdminAction/);
    assert.match(section[0], /wallet_user\.revoke_sessions/);
  });
});

// ── Pre-migration backward compatibility ──────────────────────

describe('H2-backward-compat — pre-migration tokens treated as version 0', () => {
  it('verifyToken backfills undefined token_version to 0', () => {
    assert.match(JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
  });

  it('verifyWalletToken backfills undefined token_version to 0', () => {
    assert.match(WALLET_JWT, /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
  });

  it('verifyRefreshToken backfills undefined token_version to 0', () => {
    // verifyRefreshToken also backfills — check it has the same pattern
    const refreshSection = WALLET_JWT.match(/verifyRefreshToken[\s\S]*?\n\}/);
    assert.ok(refreshSection);
    assert.match(refreshSection[0], /payload\.token_version === undefined\s*\)\s*payload\.token_version = 0/);
  });

  it('merchant-auth uses default 0 for DB token_version (null-safe)', () => {
    assert.match(MERCHANT_AUTH, /token_version.*\?\?\s*0/);
  });

  it('wallet-auth uses default 0 for DB token_version (null-safe)', () => {
    assert.match(WALLET_AUTH, /token_version.*\?\?\s*0/);
  });
});
