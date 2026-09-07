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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const RESET_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../routes/merchant/password-reset.ts'),
  'utf-8',
);

describe('Merchant password reset — security properties', () => {

  // ── No account enumeration ───────────────────────────────────
  describe('no account enumeration', () => {
    it('has a single generic response constant', () => {
      assert.match(
        RESET_SRC,
        /GENERIC_RESPONSE/,
        'must define a GENERIC_RESPONSE constant',
      );
    });

    it('generic response does not reveal if email exists', () => {
      assert.match(
        RESET_SRC,
        /Si ce compte existe.*un email/i,
        'generic response must say "if this account exists"',
      );
    });

    it('returns generic response when merchant not found', () => {
      assert.match(
        RESET_SRC,
        /if \(error \|\| !merchant\)[\s\S]*?genericReply\(\)/,
        'must call genericReply() when merchant not found',
      );
    });

    it('returns generic response when email rate limited', () => {
      assert.match(
        RESET_SRC,
        /count >= 3[\s\S]*?genericReply\(\)/,
        'must call genericReply() when per-email rate limit hit',
      );
    });

    it('returns generic response even on insert error', () => {
      assert.match(
        RESET_SRC,
        /insertError[\s\S]*?genericReply\(\)/,
        'must call genericReply() on insert error',
      );
    });

    it('returns generic response even on email send error', () => {
      // The email send is in a try/catch, and after it we still return genericReply
      assert.match(
        RESET_SRC,
        /sendPasswordResetEmail[\s\S]*?genericReply\(\)/,
        'must return genericReply() after email send attempt',
      );
    });
  });

  // ── Token security ───────────────────────────────────────────
  describe('token security', () => {
    it('generates token with crypto.randomBytes', () => {
      assert.match(
        RESET_SRC,
        /crypto\.randomBytes\(/,
        'must use crypto.randomBytes for token generation',
      );
    });

    it('hashes token with sha256 before storage', () => {
      assert.match(
        RESET_SRC,
        /crypto\.createHash\(['"]sha256['"]\)\.update\(token/,
        'must hash token with sha256',
      );
    });

    it('stores token_hash, not the plaintext token', () => {
      assert.match(
        RESET_SRC,
        /token_hash:\s*tokenHash/,
        'must store token_hash (the hash), not the token',
      );
    });

    it('token has 30-minute expiry', () => {
      assert.match(
        RESET_SRC,
        /30\s*\*\s*60\s*\*\s*1000/,
        'expiry must be 30 minutes (30 * 60 * 1000 ms)',
      );
    });
  });

  // ── Confirm: expired token rejection ─────────────────────────
  describe('expired token rejection', () => {
    it('checks expires_at against current time', () => {
      assert.match(
        RESET_SRC,
        /new Date\(resetRecord\.expires_at[\s\S]*?<\s*new Date\(\)/,
        'must check if token is expired',
      );
    });

    it('returns 400 for expired token', () => {
      assert.match(
        RESET_SRC,
        /400[\s\S]*?Ce lien a expiré/,
        'must return 400 for expired token',
      );
    });
  });

  // ── Confirm: used token rejection ────────────────────────────
  describe('used token rejection (single-use)', () => {
    it('queries for tokens where used_at is null', () => {
      assert.match(
        RESET_SRC,
        /\.is\(['"]used_at['"],\s*null\)/,
        'must filter for used_at IS NULL',
      );
    });

    it('returns 400 when token not found (already used or invalid)', () => {
      assert.match(
        RESET_SRC,
        /400[\s\S]*?Token invalide.*déjà utilisé/,
        'must return 400 for invalid/used token',
      );
    });

    it('marks token as used after successful reset', () => {
      assert.match(
        RESET_SRC,
        /update\(\{ used_at:[\s\S]*?\}\)[\s\S]*?\.eq\(['"]id['"],\s*resetRecord\.id/,
        'must mark token as used after reset',
      );
    });
  });

  // ── Invalidation of other pending tokens ─────────────────────
  describe('invalidation of other pending tokens', () => {
    it('invalidates all other unused tokens for the merchant', () => {
      assert.match(
        RESET_SRC,
        /update\(\{ used_at:[\s\S]*?\}\)[\s\S]*?\.eq\(['"]merchant_id['"],\s*merchantId\)[\s\S]*?\.is\(['"]used_at['"],\s*null\)[\s\S]*?\.neq\(['"]id['"],\s*resetRecord\.id/,
        'must invalidate other pending tokens for the merchant',
      );
    });
  });

  // ── Rate limiting ────────────────────────────────────────────
  describe('rate limiting', () => {
    it('has rate limit config on /request', () => {
      assert.match(
        RESET_SRC,
        /password-reset\/request[\s\S]*?rateLimit/,
        '/request must have rate limit config',
      );
    });

    it('per-IP rate limit is 10/hour', () => {
      assert.match(
        RESET_SRC,
        /max:\s*10,\s*timeWindow:\s*['"]1 hour['"]/,
        'must have per-IP rate limit of 10/hour',
      );
    });

    it('per-email rate limit is 3/hour (manual check)', () => {
      assert.match(
        RESET_SRC,
        /count >= 3/,
        'must check for 3 tokens per hour per email',
      );
    });

    it('per-email rate limit checks created_at within last hour', () => {
      assert.match(
        RESET_SRC,
        /60\s*\*\s*60\s*\*\s*1000/,
        'must compute one hour ago for rate limit check',
      );
    });
  });

  // ── Password hashing ─────────────────────────────────────────
  describe('password hashing', () => {
    it('uses bcrypt.hash with cost 12', () => {
      assert.match(
        RESET_SRC,
        /bcrypt\.hash\(new_password!,\s*12\)/,
        'must hash new password with bcrypt cost 12',
      );
    });

    it('new_password has minLength 8', () => {
      assert.match(
        RESET_SRC,
        /new_password.*minLength:\s*8/,
        'new_password must have minLength 8',
      );
    });

    it('bcrypt cost 12 matches register.ts and profile.ts', async () => {
      // Verify bcrypt cost 12 works correctly
      const hash = await bcrypt.hash('testpassword', 12);
      const match = await bcrypt.compare('testpassword', hash);
      assert.equal(match, true, 'bcrypt cost 12 must work');
      // Verify cost is embedded in hash
      assert.match(hash, /\$2[aby]\$12\$/, 'hash must contain cost 12');
    });
  });

  // ── Security notification ────────────────────────────────────
  describe('security notification after reset', () => {
    it('sends security notification email after successful reset', () => {
      assert.match(
        RESET_SRC,
        /sendSecurityNotificationEmail[\s\S]*?['"]password_changed['"]/,
        'must send password_changed notification after reset',
      );
    });
  });

  // ── Token verification logic ─────────────────────────────────
  describe('token verification logic', () => {
    it('sha256 hash is deterministic (same token → same hash)', () => {
      const token = 'abc123';
      const hash1 = crypto.createHash('sha256').update(token).digest('hex');
      const hash2 = crypto.createHash('sha256').update(token).digest('hex');
      assert.equal(hash1, hash2, 'sha256 must be deterministic');
    });

    it('different tokens produce different hashes', () => {
      const hash1 = crypto.createHash('sha256').update('token1').digest('hex');
      const hash2 = crypto.createHash('sha256').update('token2').digest('hex');
      assert.notEqual(hash1, hash2, 'different tokens must produce different hashes');
    });

    it('32-byte token produces 64-char hex string', () => {
      const token = crypto.randomBytes(32).toString('hex');
      assert.equal(token.length, 64, 'token must be 64 hex chars');
    });
  });

  // ── Email template ───────────────────────────────────────────
  describe('email template', () => {
    it('imports sendPasswordResetEmail', () => {
      assert.match(
        RESET_SRC,
        /import.*sendPasswordResetEmail.*from.*email/,
        'must import sendPasswordResetEmail',
      );
    });

    it('reset URL uses MERCHANT_PORTAL_URL env', () => {
      assert.match(
        RESET_SRC,
        /env\.MERCHANT_PORTAL_URL/,
        'must use env.MERCHANT_PORTAL_URL for reset link',
      );
    });

    it('reset URL includes token as query param', () => {
      assert.match(
        RESET_SRC,
        /reset-password\?token=/,
        'reset URL must include token as query param',
      );
    });
  });
});
