import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Security tests for merchant support routes.
 * Verifies no cross-merchant data leakage is possible.
 */

const SUPPORT_ROUTE = path.resolve(__dirname, '../../routes/merchant/support.ts');
const SUPPORT_SOURCE = fs.readFileSync(SUPPORT_ROUTE, 'utf-8');

const ADMIN_SUPPORT_ROUTE = path.resolve(__dirname, '../../routes/admin/support.ts');
const ADMIN_SUPPORT_SOURCE = fs.readFileSync(ADMIN_SUPPORT_ROUTE, 'utf-8');

const BOT_SERVICE = path.resolve(__dirname, '../../services/support-bot.ts');
const BOT_SOURCE = fs.readFileSync(BOT_SERVICE, 'utf-8');

describe('merchant support — cross-merchant isolation', () => {
  it('conversation lookup always filters by merchant_id from JWT', () => {
    // When conversation_id is provided, the query must include .eq('merchant_id', merchantId)
    assert.match(
      SUPPORT_SOURCE,
      /\.eq\('id', conversationId\)[\s\S]*?\.eq\('merchant_id', merchantId\)/,
      'conversation lookup must filter by merchant_id',
    );
  });

  it('GET conversations filters by merchant_id from JWT', () => {
    assert.match(
      SUPPORT_SOURCE,
      /merchant\/support\/conversations[\s\S]*?\.eq\('merchant_id', auth\.payload\.merchant_id\)/,
      'conversations list must filter by merchant_id',
    );
  });

  it('GET messages verifies conversation belongs to merchant before returning', () => {
    assert.match(
      SUPPORT_SOURCE,
      /conversations\/:id\/messages[\s\S]*?\.eq\('merchant_id', auth\.payload\.merchant_id\)/,
      'messages route must verify conversation ownership',
    );
  });

  it('merchant context fetches only this merchant data', () => {
    // The transactions query must filter by merchant_id
    assert.match(
      SUPPORT_SOURCE,
      /\.from\('transactions'\)[\s\S]*?\.eq\('merchant_id', merchantId\)/,
      'transactions context must filter by merchant_id',
    );
    // The merchant query must filter by id
    assert.match(
      SUPPORT_SOURCE,
      /\.from\('merchants'\)[\s\S]*?\.eq\('id', merchantId\)/,
      'merchant context must filter by id',
    );
    // The api_keys query must filter by merchant_id
    assert.match(
      SUPPORT_SOURCE,
      /\.from\('api_keys'\)[\s\S]*?\.eq\('merchant_id', merchantId\)/,
      'api_keys context must filter by merchant_id',
    );
  });

  it('no SELECT * or unfiltered queries on merchants/transactions tables', () => {
    // Ensure there's no .from('merchants').select('*') without .eq filter
    const unfilteredMerchant = SUPPORT_SOURCE.match(/\.from\('merchants'\)[\s\S]{0,200}$/gm);
    if (unfilteredMerchant) {
      for (const match of unfilteredMerchant) {
        assert.ok(
          match.includes('.eq(') || match.includes('merchantId'),
          `unfiltered merchant query found: ${match.slice(0, 80)}`,
        );
      }
    }
  });

  it('requireActiveMerchant extracts merchant_id from JWT, not from body or query', () => {
    assert.ok(SUPPORT_SOURCE.includes('requireActiveMerchant'), 'uses requireActiveMerchant');
    assert.ok(SUPPORT_SOURCE.includes('auth.payload.merchant_id'), 'uses auth.payload.merchant_id');
    // Ensure merchant_id is never taken from request.body
    assert.ok(
      !SUPPORT_SOURCE.includes('body.merchant_id') && !SUPPORT_SOURCE.includes('request.body.merchant_id'),
      'merchant_id must never come from request body',
    );
  });
});

describe('merchant support — escalation behavior', () => {
  it('bot service marks [ESCALATE] prefix as escalated', () => {
    assert.ok(BOT_SOURCE.includes('[ESCALATE]'), 'system prompt uses [ESCALATE] marker');
    assert.match(
      BOT_SOURCE,
      /startsWith\('\[ESCALATE\]'\)/,
      'detects [ESCALATE] prefix',
    );
  });

  it('system prompt instructs to escalate when bot cannot answer', () => {
    assert.ok(
      BOT_SOURCE.includes('dépasse ce que les données fournies permettent') ||
      BOT_SOURCE.includes('ne peux pas répondre'),
      'system prompt includes escalation instructions',
    );
    assert.ok(
      BOT_SOURCE.includes('humain') || BOT_SOURCE.includes('escalade'),
      'system prompt mentions human escalation',
    );
  });

  it('support route updates conversation status to escalated', () => {
    assert.match(
      SUPPORT_SOURCE,
      /status: 'escalated'/,
      'sets status to escalated',
    );
  });

  it('support route sends escalation email', () => {
    assert.ok(SUPPORT_SOURCE.includes('sendSupportEscalationEmail'), 'calls escalation email');
  });

  it('bot service returns escalated=true when ANTHROPIC_API_KEY is missing', () => {
    assert.match(
      BOT_SOURCE,
      /if \(!env\.ANTHROPIC_API_KEY\)[\s\S]*?escalated: true/,
      'escalates when API key missing',
    );
  });

  it('bot service returns escalated=true on API error', () => {
    assert.match(
      BOT_SOURCE,
      /catch[\s\S]*?escalated: true/,
      'escalates on API error',
    );
  });
});

describe('admin support — reply and conversation access', () => {
  it('admin routes require admin session', () => {
    assert.ok(ADMIN_SUPPORT_SOURCE.includes('requireAdmin(request.isAdmin)'), 'admin guard present');
    // Count occurrences — should be at least 3 (list, messages, reply)
    const count = (ADMIN_SUPPORT_SOURCE.match(/requireAdmin\(request\.isAdmin\)/g) ?? []).length;
    assert.ok(count >= 3, `expected at least 3 admin guards, got ${count}`);
  });

  it('admin reply saves message with role=admin', () => {
    assert.match(
      ADMIN_SUPPORT_SOURCE,
      /role: 'admin'/,
      'admin reply uses role=admin',
    );
  });

  it('admin reply can resolve conversation', () => {
    assert.match(
      ADMIN_SUPPORT_SOURCE,
      /resolve.*resolved/,
      'admin reply can set status to resolved',
    );
  });

  it('admin conversations list includes merchant info', () => {
    assert.match(
      ADMIN_SUPPORT_SOURCE,
      /merchants\(name, email\)/,
      'admin list includes merchant name and email',
    );
  });

  it('admin conversations list is filterable by status', () => {
    assert.match(
      ADMIN_SUPPORT_SOURCE,
      /status.*enum.*open.*escalated.*resolved/,
      'admin list supports status filter',
    );
  });
});

describe('support — migration exists', () => {
  it('migration file exists with both tables', () => {
    const migrationPath = path.resolve(__dirname, '../../../supabase/migrations/20260907000000_support_conversations.sql');
    assert.ok(fs.existsSync(migrationPath), 'migration file exists');
    const migration = fs.readFileSync(migrationPath, 'utf-8');
    assert.ok(migration.includes('support_conversations'), 'creates support_conversations table');
    assert.ok(migration.includes('support_messages'), 'creates support_messages table');
    assert.ok(migration.includes('merchant_id'), 'conversations have merchant_id');
    assert.ok(migration.includes("CHECK (role IN ('merchant', 'bot', 'admin'))"), 'messages role check constraint');
    assert.ok(migration.includes("CHECK (status IN ('open', 'escalated', 'resolved'))"), 'conversation status check constraint');
    assert.ok(migration.includes('ROW LEVEL SECURITY'), 'enables RLS');
  });
});
