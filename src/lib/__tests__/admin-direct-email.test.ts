import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Tests for admin direct email to merchant feature.
 * Verifies: channel='email' logging, template logic, admin guards,
 * and cross-merchant email isolation.
 */

const MERCHANTS_ROUTE = path.resolve(__dirname, '../../routes/admin/merchants.ts');
const MERCHANTS_SOURCE = fs.readFileSync(MERCHANTS_ROUTE, 'utf-8');

const EMAIL_SERVICE = path.resolve(__dirname, '../../services/email.ts');
const EMAIL_SOURCE = fs.readFileSync(EMAIL_SERVICE, 'utf-8');

const MIGRATION_PATH = path.resolve(__dirname, '../../../supabase/migrations/20260907010000_support_messages_channel.sql');

describe('admin direct email — migration', () => {
  it('migration adds channel column with check constraint', () => {
    assert.ok(fs.existsSync(MIGRATION_PATH), 'migration file exists');
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    assert.ok(migration.includes('channel'), 'adds channel column');
    assert.ok(migration.includes("CHECK (channel IN ('chat', 'email'))"), 'channel check constraint');
    assert.ok(migration.includes("DEFAULT 'chat'"), 'defaults to chat');
  });

  it('migration adds subject column (nullable)', () => {
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    assert.ok(migration.includes('subject'), 'adds subject column');
    assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS subject text'), 'subject is nullable text');
  });
});

describe('admin direct email — route guards', () => {
  it('POST /admin/merchants/:id/email requires admin', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /\/admin\/merchants\/:id\/email[\s\S]*?requireAdmin\(request\.isAdmin\)/,
      'email route has admin guard',
    );
  });

  it('GET /admin/merchants/:id/support-templates requires admin', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /\/admin\/merchants\/:id\/support-templates[\s\S]*?requireAdmin\(request\.isAdmin\)/,
      'templates route has admin guard',
    );
  });

  it('email route validates body schema (subject + body required)', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /required: \['subject', 'body'\]/,
      'subject and body are required',
    );
  });
});

describe('admin direct email — cross-merchant isolation', () => {
  it('email is sent to merchant.email from DB, never from request body', () => {
    // The route fetches merchant by id, then uses m.email
    assert.match(
      MERCHANTS_SOURCE,
      /\.from\('merchants'\)[\s\S]*?\.eq\('id', id\)[\s\S]*?sendAdminDirectEmail\(m\.email/,
      'email address comes from DB merchant record, not from body',
    );
    // Ensure the body never contains a "to" or "email" field for the recipient
    assert.ok(
      !MERCHANTS_SOURCE.match(/body\.(to|email|recipient)/),
      'request body must not contain recipient email field',
    );
  });

  it('conversation lookup verifies merchant_id ownership', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /\/admin\/merchants\/:id\/email[\s\S]*?\.eq\('merchant_id', id\)/,
      'conversation ownership verified by merchant_id',
    );
  });

  it('new conversation is created with merchant_id from route params, not body', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /insert\(\{ merchant_id: id[\s\S]*?status: 'open'/,
      'new conversation uses route param id as merchant_id',
    );
  });
});

describe('admin direct email — message logging', () => {
  it('message is logged with channel=email', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /channel: 'email'/,
      'logs message with channel=email',
    );
  });

  it('message is logged with role=admin', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /\/admin\/merchants\/:id\/email[\s\S]*?role: 'admin'/,
      'logs message with role=admin',
    );
  });

  it('message is logged with subject from body', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /subject,\s*\n\s*content: body/,
      'stores subject and content from body',
    );
  });
});

describe('admin direct email — template logic', () => {
  it('templates vary by kyc_status=pending', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /kyc_status === 'pending'[\s\S]*?Relance KYC/,
      'pending KYC template exists',
    );
  });

  it('templates vary by kyc_status=submitted', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /kyc_status === 'submitted'[\s\S]*?KYC en cours de revue/,
      'submitted KYC template exists',
    );
  });

  it('templates vary by kyc_status=approved + mode=sandbox', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /kyc_status === 'approved' && m\.mode === 'sandbox'[\s\S]*?Passage en mode live/,
      'approved+sandbox template exists',
    );
  });

  it('generic template always available', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /Réponse à votre demande/,
      'generic template exists',
    );
  });

  it('templates include merchant name variable substitution', () => {
    // The template body uses the merchant's name from DB
    assert.match(
      MERCHANTS_SOURCE,
      /const name = m\.name \?\? m\.email/,
      'uses merchant name from DB for template substitution',
    );
  });

  it('templates route fetches merchant by id to determine kyc_status', () => {
    assert.match(
      MERCHANTS_SOURCE,
      /support-templates[\s\S]*?\.from\('merchants'\)[\s\S]*?\.eq\('id', id\)/,
      'templates route fetches merchant by id',
    );
  });
});

describe('admin direct email — email service', () => {
  it('sendAdminDirectEmail function exists', () => {
    assert.ok(EMAIL_SOURCE.includes('export async function sendAdminDirectEmail'), 'function exported');
  });

  it('sendAdminDirectEmail accepts to, subject, body params', () => {
    assert.match(
      EMAIL_SOURCE,
      /sendAdminDirectEmail\(\s*to: string,\s*subject: string,\s*body: string/,
      'accepts to, subject, body',
    );
  });

  it('sendAdminDirectEmail uses Brevo client (same as other emails)', () => {
    assert.match(
      EMAIL_SOURCE,
      /sendAdminDirectEmail[\s\S]*?getClient\(\)/,
      'uses same Brevo client as other email functions',
    );
  });

  it('sendAdminDirectEmail sends to the provided address', () => {
    assert.match(
      EMAIL_SOURCE,
      /sendAdminDirectEmail[\s\S]*?to: \[\{ email: to \}\]/,
      'sends to the provided address',
    );
  });
});
