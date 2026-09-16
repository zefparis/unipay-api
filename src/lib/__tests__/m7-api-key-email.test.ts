import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const EMAIL = fs.readFileSync(path.resolve(SRC, 'services/email.ts'), 'utf-8');
const REGISTER = fs.readFileSync(path.resolve(SRC, 'routes/merchant/register.ts'), 'utf-8');

// ── email.ts tests ───────────────────────────────────────────

describe('M7-email — no API key in welcome email', () => {
  it('sendWelcomeEmail does NOT accept apiKey parameter', () => {
    // The old signature was: sendWelcomeEmail(to, name, apiKey)
    // The new signature should be: sendWelcomeEmail(to, name)
    const sigMatch = EMAIL.match(/export async function sendWelcomeEmail\([^)]*\)/);
    assert.ok(sigMatch, 'must find sendWelcomeEmail function');
    assert.doesNotMatch(sigMatch[0], /apiKey/i);
  });

  it('sendWelcomeEmail body does NOT contain apiKey variable interpolation', () => {
    // The old email had: ${apiKey}
    // Find the function body and check it doesn't interpolate apiKey
    const funcMatch = EMAIL.match(/export async function sendWelcomeEmail[\s\S]*?^}/m);
    assert.ok(funcMatch, 'must find sendWelcomeEmail function body');
    assert.doesNotMatch(funcMatch[0], /\$\{apiKey\}/);
  });

  it('email body contains a dashboard link', () => {
    const funcMatch = EMAIL.match(/export async function sendWelcomeEmail[\s\S]*?^}/m);
    assert.ok(funcMatch, 'must find sendWelcomeEmail function body');
    assert.match(funcMatch[0], /dashboard\/api-keys/i);
  });

  it('email body mentions security reason for not including key', () => {
    const funcMatch = EMAIL.match(/export async function sendWelcomeEmail[\s\S]*?^}/m);
    assert.ok(funcMatch, 'must find sendWelcomeEmail function body');
    assert.match(funcMatch[0], /sécurité|security/i);
  });
});

// ── register.ts tests ────────────────────────────────────────

describe('M7-register — still returns key in HTTP response, not email', () => {
  it('calls sendWelcomeEmail without apiKey', () => {
    // The old call was: sendWelcomeEmail(email, name, rawKey)
    // The new call should be: sendWelcomeEmail(email, name)
    assert.doesNotMatch(REGISTER, /sendWelcomeEmail\(email,\s*name,\s*rawKey\)/);
    assert.match(REGISTER, /sendWelcomeEmail\(email,\s*name\)/);
  });

  it('still returns api_key in the HTTP response', () => {
    // The API response must still contain the key — it's the primary channel
    assert.match(REGISTER, /api_key:\s*rawKey/);
  });

  it('still generates the API key (rawKey variable exists)', () => {
    assert.match(REGISTER, /const rawKey\s*=/);
    assert.match(REGISTER, /bcrypt\.hash\(rawKey/);
  });
});
