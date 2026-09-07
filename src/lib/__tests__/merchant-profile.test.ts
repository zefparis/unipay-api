/**
 * Tests for merchant profile routes — static analysis + logic verification.
 *
 * These tests verify the security properties of src/routes/merchant/profile.ts
 * without needing a running database:
 *   - Isolation: merchant_id comes from JWT only, never from request body
 *   - current_password verification is required for change-email and change-password
 *   - Rate limiting is configured on sensitive endpoints
 *   - password_hash is never included in GET/PATCH responses
 *   - company_name is locked when kyc_status === 'approved'
 *   - Email is not editable via PATCH (must use change-email endpoint)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const PROFILE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../routes/merchant/profile.ts'),
  'utf-8',
);

describe('Merchant profile route — security properties', () => {

  // ── Isolation ────────────────────────────────────────────────
  describe('isolation (merchant_id from JWT only)', () => {
    it('uses requireActiveMerchant for all 4 endpoints', () => {
      const matches = PROFILE_SRC.match(/requireActiveMerchant/g);
      assert.ok(matches, 'requireActiveMerchant must be called');
      assert.ok(matches.length >= 4, `expected ≥4 calls, got ${matches?.length}`);
    });

    it('gets merchant_id from auth.payload, not from request body', () => {
      assert.match(
        PROFILE_SRC,
        /auth\.payload\.merchant_id/,
        'merchant_id must come from JWT payload, not request body',
      );
    });

    it('PATCH body schema does not include merchant_id or id', () => {
      // Extract the PATCH schema block
      const patchMatch = PROFILE_SRC.match(
        /fastify\.patch[\s\S]*?schema:\s*\{[\s\S]*?properties:\s*\{([^}]*)\}/,
      );
      assert.ok(patchMatch, 'must find PATCH schema');
      const schemaProps = patchMatch[1];
      assert.doesNotMatch(
        schemaProps,
        /merchant_id|^\s*id\b/m,
        'PATCH body must not accept merchant_id or id',
      );
    });

    it('change-email body schema does not include merchant_id', () => {
      const emailMatch = PROFILE_SRC.match(
        /change-email[\s\S]*?schema:\s*\{[\s\S]*?properties:\s*\{([^}]*)\}/,
      );
      assert.ok(emailMatch, 'must find change-email schema');
      const schemaProps = emailMatch[1];
      assert.doesNotMatch(
        schemaProps,
        /merchant_id/,
        'change-email body must not accept merchant_id',
      );
    });

    it('change-password body schema does not include merchant_id', () => {
      const pwMatch = PROFILE_SRC.match(
        /change-password[\s\S]*?schema:\s*\{[\s\S]*?properties:\s*\{([^}]*)\}/,
      );
      assert.ok(pwMatch, 'must find change-password schema');
      const schemaProps = pwMatch[1];
      assert.doesNotMatch(
        schemaProps,
        /merchant_id/,
        'change-password body must not accept merchant_id',
      );
    });

    it('all DB queries use .eq(\'id\', merchantId) scoping', () => {
      // Every supabase query should filter by merchantId from JWT
      const eqCalls = PROFILE_SRC.match(/\.eq\(['"]id['"],\s*merchantId\)/g);
      assert.ok(eqCalls, 'must have .eq("id", merchantId) calls');
      assert.ok(eqCalls.length >= 4, `expected ≥4 scoped queries, got ${eqCalls?.length}`);
    });
  });

  // ── current_password verification ────────────────────────────
  describe('current_password verification', () => {
    it('change-email requires current_password in body', () => {
      assert.match(
        PROFILE_SRC,
        /change-email[\s\S]*?required:\s*\[[^\]]*current_password/,
        'change-email must require current_password',
      );
    });

    it('change-password requires current_password in body', () => {
      assert.match(
        PROFILE_SRC,
        /change-password[\s\S]*?required:\s*\[[^\]]*current_password/,
        'change-password must require current_password',
      );
    });

    it('change-email verifies current_password with bcrypt.compare', () => {
      // Find the change-email handler section (between change-email and change-password)
      const emailStart = PROFILE_SRC.indexOf("'/merchant/profile/change-email'");
      const pwStart = PROFILE_SRC.indexOf("'/merchant/profile/change-password'");
      assert.ok(emailStart > -1, 'must find change-email route');
      assert.ok(pwStart > -1, 'must find change-password route');
      const emailSection = PROFILE_SRC.slice(emailStart, pwStart);
      assert.match(
        emailSection,
        /bcrypt\.compare\(current_password/,
        'change-email must verify current_password with bcrypt.compare',
      );
    });

    it('change-password verifies current_password with bcrypt.compare', () => {
      // Find the change-password handler section (from change-password to end of route)
      const pwStart = PROFILE_SRC.indexOf("'/merchant/profile/change-password'");
      assert.ok(pwStart > -1, 'must find change-password route');
      const pwSection = PROFILE_SRC.slice(pwStart);
      assert.match(
        pwSection,
        /bcrypt\.compare\(current_password/,
        'change-password must verify current_password with bcrypt.compare',
      );
    });

    it('returns 401 when current_password is incorrect', () => {
      assert.match(
        PROFILE_SRC,
        /Current password is incorrect/,
        'must return 401 with "Current password is incorrect" message',
      );
    });

    it('bcrypt.compare logic is correct (matches against stored hash)', async () => {
      // Verify the bcrypt.compare pattern works as expected
      const hash = await bcrypt.hash('mypassword', 12);
      const correct = await bcrypt.compare('mypassword', hash);
      const wrong = await bcrypt.compare('wrongpassword', hash);
      assert.equal(correct, true, 'correct password must match');
      assert.equal(wrong, false, 'wrong password must not match');
    });
  });

  // ── Rate limiting ────────────────────────────────────────────
  describe('rate limiting on sensitive endpoints', () => {
    it('change-email has rateLimit config', () => {
      const emailSection = PROFILE_SRC.match(
        /change-email[\s\S]*?config:\s*\{[\s\S]*?rateLimit/,
      );
      assert.ok(emailSection, 'change-email must have rateLimit config');
    });

    it('change-password has rateLimit config', () => {
      const pwSection = PROFILE_SRC.match(
        /change-password[\s\S]*?config:\s*\{[\s\S]*?rateLimit/,
      );
      assert.ok(pwSection, 'change-password must have rateLimit config');
    });

    it('rate limit is 5 per hour', () => {
      const rateMatches = PROFILE_SRC.match(/max:\s*5,\s*timeWindow:\s*['"]1 hour['"]/g);
      assert.ok(rateMatches, 'must have rate limit 5/hour');
      assert.ok(rateMatches.length >= 2, `expected ≥2 rate limits, got ${rateMatches?.length}`);
    });

    it('rate limit keyGenerator uses merchantIdFromRequest', () => {
      assert.match(
        PROFILE_SRC,
        /keyGenerator:\s*\(req\)\s*=>\s*merchantIdFromRequest\(req\)/,
        'rate limit must key by merchant_id from JWT',
      );
    });

    it('GET and PATCH do NOT have rateLimit (only sensitive endpoints)', () => {
      const getSection = PROFILE_SRC.match(
        /fastify\.get[\s\S]*?async \(request, reply\)[\s\S]*?(?=fastify\.patch)/,
      );
      assert.ok(getSection, 'must find GET handler');
      assert.doesNotMatch(
        getSection![0],
        /rateLimit/,
        'GET /merchant/profile should not be rate limited',
      );
    });
  });

  // ── password_hash never exposed ──────────────────────────────
  describe('password_hash protection', () => {
    it('GET select does not include password_hash', () => {
      const getSelect = PROFILE_SRC.match(
        /fastify\.get[\s\S]*?\.select\(['"]([^'"]+)['"]\)/,
      );
      assert.ok(getSelect, 'must find GET select');
      assert.doesNotMatch(
        getSelect![1],
        /password_hash/,
        'GET select must not include password_hash',
      );
    });

    it('PATCH response select does not include password_hash', () => {
      const patchSelect = PROFILE_SRC.match(
        /fastify\.patch[\s\S]*?\.update\(updates\)[\s\S]*?\.select\(['"]([^'"]+)['"]\)/,
      );
      assert.ok(patchSelect, 'must find PATCH update select');
      assert.doesNotMatch(
        patchSelect![1],
        /password_hash/,
        'PATCH response select must not include password_hash',
      );
    });

    it('comment explicitly states NEVER expose password_hash', () => {
      assert.match(
        PROFILE_SRC,
        /NEVER expose password_hash/i,
        'must have comment about never exposing password_hash',
      );
    });
  });

  // ── KYC lock on company_name ─────────────────────────────────
  describe('KYC lock on company_name', () => {
    it('PATCH checks kyc_status === approved before allowing company_name change', () => {
      assert.match(
        PROFILE_SRC,
        /kyc_status.*approved.*company_name/,
        'PATCH must check kyc_status before allowing company_name change',
      );
    });

    it('returns 403 when KYC approved and company_name is being changed', () => {
      assert.match(
        PROFILE_SRC,
        /403[\s\S]*Company name cannot be changed after KYC approval/,
        'must return 403 for company_name change after KYC approval',
      );
    });
  });

  // ── Email not editable via PATCH ──────────────────────────────
  describe('email isolation (not in PATCH)', () => {
    it('PATCH body schema does not include email', () => {
      const patchMatch = PROFILE_SRC.match(
        /fastify\.patch[\s\S]*?schema:\s*\{[\s\S]*?properties:\s*\{([^}]*)\}/,
      );
      assert.ok(patchMatch, 'must find PATCH schema');
      assert.doesNotMatch(
        patchMatch[1],
        /email/,
        'PATCH body must not include email field',
      );
    });

    it('company_rccm and company_idnat not in PATCH body', () => {
      const patchMatch = PROFILE_SRC.match(
        /fastify\.patch[\s\S]*?schema:\s*\{[\s\S]*?properties:\s*\{([^}]*)\}/,
      );
      assert.ok(patchMatch, 'must find PATCH schema');
      const props = patchMatch[1];
      assert.doesNotMatch(props, /company_rccm/, 'PATCH must not allow company_rccm');
      assert.doesNotMatch(props, /company_idnat/, 'PATCH must not allow company_idnat');
    });
  });

  // ── Phone validation ─────────────────────────────────────────
  describe('phone validation', () => {
    it('PATCH validates phone with isValidDrcPhone', () => {
      assert.match(
        PROFILE_SRC,
        /isValidDrcPhone\(phone\)/,
        'PATCH must validate phone with isValidDrcPhone',
      );
    });

    it('returns 400 for invalid phone', () => {
      assert.match(
        PROFILE_SRC,
        /400.*Invalid phone number format/,
        'must return 400 for invalid phone',
      );
    });
  });

  // ── Password hashing ─────────────────────────────────────────
  describe('password hashing (change-password)', () => {
    it('uses bcrypt.hash with cost 12 (same as register.ts)', () => {
      assert.match(
        PROFILE_SRC,
        /bcrypt\.hash\(new_password,\s*12\)/,
        'change-password must hash with bcrypt cost 12',
      );
    });

    it('new_password has minLength 8 (same as register.ts)', () => {
      assert.match(
        PROFILE_SRC,
        /new_password.*minLength:\s*8/,
        'new_password must have minLength 8',
      );
    });
  });

  // ── Email uniqueness check ───────────────────────────────────
  describe('email uniqueness (change-email)', () => {
    it('checks new email is not already used by another merchant', () => {
      assert.match(
        PROFILE_SRC,
        /ilike\(['"]email['"],\s*new_email\)/,
        'change-email must check email uniqueness with case-insensitive match',
      );
    });

    it('excludes current merchant from uniqueness check', () => {
      assert.match(
        PROFILE_SRC,
        /\.neq\(['"]id['"],\s*merchantId\)/,
        'uniqueness check must exclude current merchant',
      );
    });

    it('returns 409 for duplicate email', () => {
      assert.match(
        PROFILE_SRC,
        /409.*Email already registered/,
        'must return 409 for duplicate email',
      );
    });
  });

  // ── Security notification emails ─────────────────────────────
  describe('security notification emails', () => {
    it('change-email sends notification to old AND new email', () => {
      const emailStart = PROFILE_SRC.indexOf("'/merchant/profile/change-email'");
      const pwStart = PROFILE_SRC.indexOf("'/merchant/profile/change-password'");
      assert.ok(emailStart > -1, 'must find change-email route');
      assert.ok(pwStart > -1, 'must find change-password route');
      const section = PROFILE_SRC.slice(emailStart, pwStart);
      // Should call sendSecurityNotificationEmail at least twice
      const calls = section.match(/sendSecurityNotificationEmail/g);
      assert.ok(calls, 'must call sendSecurityNotificationEmail');
      assert.ok(calls.length >= 2, `expected ≥2 notification calls, got ${calls?.length}`);
    });

    it('change-password sends notification email', () => {
      const pwStart = PROFILE_SRC.indexOf("'/merchant/profile/change-password'");
      assert.ok(pwStart > -1, 'must find change-password route');
      const pwSection = PROFILE_SRC.slice(pwStart);
      assert.match(
        pwSection,
        /sendSecurityNotificationEmail/,
        'change-password must send security notification email',
      );
    });

    it('uses type "password_changed" for password change notification', () => {
      assert.match(
        PROFILE_SRC,
        /['"]password_changed['"]/,
        'must use "password_changed" type for password notification',
      );
    });

    it('uses type "email_changed" for email change notification', () => {
      assert.match(
        PROFILE_SRC,
        /['"]email_changed['"]/,
        'must use "email_changed" type for email notification',
      );
    });
  });
});
