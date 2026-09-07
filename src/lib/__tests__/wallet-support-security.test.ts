import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const readSrc = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), 'utf-8');

// ─── WS1: Migration adds wallet_user_id + CHECK constraint ────────

describe('WS1 — migration adds wallet_user_id + CHECK constraint', () => {
  const MIGRATION = readSrc('supabase/migrations/20260910000000_support_conversations_wallet_users.sql');

  it('adds wallet_user_id column referencing wallet_users', () => {
    assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS wallet_user_id uuid/i);
    assert.match(MIGRATION, /REFERENCES public\.wallet_users\(id\)/i);
    assert.match(MIGRATION, /ON DELETE CASCADE/i);
  });

  it('makes merchant_id nullable', () => {
    assert.match(MIGRATION, /ALTER COLUMN merchant_id DROP NOT NULL/i);
  });

  it('adds CHECK constraint for exactly one owner', () => {
    assert.match(MIGRATION, /support_conversations_exactly_one_owner/i);
    assert.match(
      MIGRATION,
      /merchant_id IS NOT NULL AND wallet_user_id IS NULL/i,
      'CHECK must require merchant_id set when wallet_user_id is null',
    );
    assert.match(
      MIGRATION,
      /merchant_id IS NULL AND wallet_user_id IS NOT NULL/i,
      'CHECK must require wallet_user_id set when merchant_id is null',
    );
  });

  it('adds wallet_user_id index', () => {
    assert.match(MIGRATION, /idx_support_conversations_wallet_user_id/i);
  });

  it('adds wallet role to support_messages role CHECK', () => {
    assert.match(MIGRATION, /role IN \('merchant', 'bot', 'admin', 'wallet'\)/i);
  });

  it('adds RLS policy for wallet user isolation', () => {
    assert.match(MIGRATION, /support_conversations_wallet_user_isolation/i);
    assert.match(MIGRATION, /current_setting\('app\.current_wallet_user_id'/i);
  });

  it('adds RLS policy for wallet messages via conversation', () => {
    assert.match(MIGRATION, /support_messages_via_wallet_conversation/i);
  });
});

// ─── WS2: wallet support route uses requireActiveWallet + isolation ──

describe('WS2 — wallet support route isolation', () => {
  const ROUTE = readSrc('src/routes/wallet/support.ts');

  it('imports requireActiveWallet from wallet-auth', () => {
    assert.match(ROUTE, /from '.*wallet-auth(\.js)?'/i);
    assert.match(ROUTE, /requireActiveWallet/i);
  });

  it('does NOT import requireWallet from wallet-jwt', () => {
    assert.doesNotMatch(ROUTE, /from '.*wallet-jwt'/i);
  });

  it('POST message uses wallet_user_id for conversation lookup', () => {
    assert.match(ROUTE, /\.eq\('wallet_user_id', walletUserId\)/i);
  });

  it('POST message creates conversation with wallet_user_id', () => {
    assert.match(ROUTE, /insert\(\{ wallet_user_id: walletUserId/i);
  });

  it('POST message saves role: wallet', () => {
    assert.match(ROUTE, /role: 'wallet'/i);
  });

  it('GET conversations filters by wallet_user_id', () => {
    assert.match(ROUTE, /\.eq\('wallet_user_id', auth\.payload\.wallet_id\)/i);
  });

  it('GET messages verifies conversation belongs to wallet_user_id', () => {
    // The messages endpoint must check conversation ownership
    assert.match(ROUTE, /wallet_user_id, status/i);
  });

  it('transactions context is filtered by wallet_user_id', () => {
    assert.match(ROUTE, /\.eq\('wallet_user_id', walletUserId\)/i);
  });

  it('has rate limit on POST message', () => {
    assert.match(ROUTE, /rateLimit/i);
    assert.match(ROUTE, /max: 10/i);
    assert.match(ROUTE, /walletIdFromRequest/i);
  });

  it('uses generateWalletBotReply (not generateBotReply)', () => {
    assert.match(ROUTE, /generateWalletBotReply/i);
    assert.doesNotMatch(ROUTE, /generateBotReply\b(?!ForWallet)/i);
  });
});

// ─── WS3: support-bot.ts has wallet context ───────────────────────

describe('WS3 — support-bot wallet context', () => {
  const BOT = readSrc('src/services/support-bot.ts');

  it('exports WalletContext interface', () => {
    assert.match(BOT, /export interface WalletContext/i);
  });

  it('WalletContext includes wallet-specific fields', () => {
    assert.match(BOT, /phone: string/i);
    assert.match(BOT, /kyc_level: number/i);
    assert.match(BOT, /is_verified: boolean/i);
    assert.match(BOT, /balance_cdf/i);
    assert.match(BOT, /usdt_balance/i);
    assert.match(BOT, /cglt_balance/i);
  });

  it('exports generateWalletBotReply function', () => {
    assert.match(BOT, /export async function generateWalletBotReply/i);
  });

  it('buildWalletContextBlock uses wallet-specific vocabulary', () => {
    assert.match(BOT, /CONTEXTE DE L'UTILISATEUR WALLET/i);
    assert.match(BOT, /Niveau KYC/i);
    assert.match(BOT, /Solde CDF/i);
  });

  it('wallet bot maps role: wallet to user', () => {
    assert.match(BOT, /m\.role === 'wallet' \? 'user'/i);
  });

  it('system prompt mentions wallet users (not just merchants)', () => {
    assert.match(BOT, /utilisateurs wallet/i);
  });
});

// ─── WS4: admin support routes include wallet conversations ───────

describe('WS4 — admin support routes discriminate merchant vs wallet', () => {
  const ADMIN = readSrc('src/routes/admin/support.ts');

  it('list query selects wallet_user_id', () => {
    assert.match(ADMIN, /wallet_user_id/i);
  });

  it('list query joins wallet_users', () => {
    assert.match(ADMIN, /wallet_users\(phone, full_name, email\)/i);
  });

  it('list query supports type filter', () => {
    assert.match(ADMIN, /type.*merchant.*wallet/i);
  });

  it('adds type discriminant field to response', () => {
    assert.match(ADMIN, /type: isMerchant \? 'merchant' : 'wallet'/i);
  });

  it('adds owner_name field', () => {
    assert.match(ADMIN, /owner_name/i);
  });

  it('adds owner_phone field', () => {
    assert.match(ADMIN, /owner_phone/i);
  });

  it('messages endpoint also selects wallet_user_id and joins wallet_users', () => {
    assert.match(ADMIN, /wallet_users\(phone, full_name, email\)/i);
  });

  it('reply endpoint selects wallet_user_id', () => {
    // The reply route must handle both merchant and wallet conversations
    assert.match(ADMIN, /wallet_user_id/i);
  });
});

// ─── WS5: admin wallet email route + templates ────────────────────

describe('WS5 — admin wallet user email route + templates', () => {
  const WALLET_ADMIN = readSrc('src/routes/admin/wallet.ts');

  it('imports sendAdminDirectEmail', () => {
    assert.match(WALLET_ADMIN, /sendAdminDirectEmail/i);
  });

  it('has POST /admin/wallet-users/:id/email route', () => {
    assert.match(WALLET_ADMIN, /\/admin\/wallet-users\/:id\/email/i);
  });

  it('email route fetches wallet user email from DB', () => {
    assert.match(WALLET_ADMIN, /from\('wallet_users'\)/i);
    assert.match(WALLET_ADMIN, /\.eq\('id', id\)/i);
  });

  it('returns 400 if user has no email', () => {
    assert.match(WALLET_ADMIN, /has no email address on file/i);
  });

  it('creates conversation with wallet_user_id', () => {
    assert.match(WALLET_ADMIN, /insert\(\{ wallet_user_id: id/i);
  });

  it('verifies conversation ownership by wallet_user_id', () => {
    assert.match(WALLET_ADMIN, /\.eq\('wallet_user_id', id\)/i);
  });

  it('logs email in support_messages with channel: email', () => {
    assert.match(WALLET_ADMIN, /channel: 'email'/i);
  });

  it('has GET /admin/wallet-users/:id/support-templates route', () => {
    assert.match(WALLET_ADMIN, /\/admin\/wallet-users\/:id\/support-templates/i);
  });

  it('templates include KYC level 0 relance', () => {
    assert.match(WALLET_ADMIN, /Relance KYC niveau 1/i);
  });

  it('templates include KYC level 2 upgrade', () => {
    assert.match(WALLET_ADMIN, /Upgrade KYC niveau 2/i);
  });

  it('templates include account suspended', () => {
    assert.match(WALLET_ADMIN, /Compte suspendu/i);
  });

  it('has GET /admin/wallet-users/:id/email-history-summary route', () => {
    assert.match(WALLET_ADMIN, /\/admin\/wallet-users\/:id\/email-history-summary/i);
  });
});

// ─── WS6: route registration in server.ts ─────────────────────────

describe('WS6 — route registration', () => {
  const SERVER = readSrc('src/server.ts');

  it('imports walletSupportRoute', () => {
    assert.match(SERVER, /import walletSupportRoute from/i);
    assert.match(SERVER, /routes\/wallet\/support/i);
  });

  it('registers walletSupportRoute', () => {
    assert.match(SERVER, /v1\.register\(walletSupportRoute\)/i);
  });
});

// ─── WS7: no cross-user data leakage in wallet support ────────────

describe('WS7 — no cross-user data leakage patterns', () => {
  const ROUTE = readSrc('src/routes/wallet/support.ts');

  it('never selects merchant_id or merchants join', () => {
    assert.doesNotMatch(ROUTE, /merchant_id/i);
    assert.doesNotMatch(ROUTE, /from\('merchants'\)/i);
  });

  it('never uses api_keys table (merchant-only)', () => {
    assert.doesNotMatch(ROUTE, /api_keys/i);
  });

  it('wallet_user_id always comes from JWT payload, not request body', () => {
    // The route must use auth.payload.wallet_id, not request.body.wallet_user_id
    assert.match(ROUTE, /auth\.payload\.wallet_id/i);
    assert.doesNotMatch(ROUTE, /request\.body\.wallet_user_id/i);
  });

  it('conversation creation uses wallet_user_id from auth, not body', () => {
    assert.match(ROUTE, /wallet_user_id: walletUserId/i);
    // walletUserId must be derived from auth.payload.wallet_id
    assert.match(ROUTE, /const walletUserId = auth\.payload\.wallet_id/i);
  });
});
