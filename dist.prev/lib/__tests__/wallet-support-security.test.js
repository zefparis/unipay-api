"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const readSrc = (rel) => node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, rel), 'utf-8');
// ─── WS1: Migration adds wallet_user_id + CHECK constraint ────────
(0, node_test_1.describe)('WS1 — migration adds wallet_user_id + CHECK constraint', () => {
    const MIGRATION = readSrc('supabase/migrations/20260910000000_support_conversations_wallet_users.sql');
    (0, node_test_1.it)('adds wallet_user_id column referencing wallet_users', () => {
        strict_1.default.match(MIGRATION, /ADD COLUMN IF NOT EXISTS wallet_user_id uuid/i);
        strict_1.default.match(MIGRATION, /REFERENCES public\.wallet_users\(id\)/i);
        strict_1.default.match(MIGRATION, /ON DELETE CASCADE/i);
    });
    (0, node_test_1.it)('makes merchant_id nullable', () => {
        strict_1.default.match(MIGRATION, /ALTER COLUMN merchant_id DROP NOT NULL/i);
    });
    (0, node_test_1.it)('adds CHECK constraint for exactly one owner', () => {
        strict_1.default.match(MIGRATION, /support_conversations_exactly_one_owner/i);
        strict_1.default.match(MIGRATION, /merchant_id IS NOT NULL AND wallet_user_id IS NULL/i, 'CHECK must require merchant_id set when wallet_user_id is null');
        strict_1.default.match(MIGRATION, /merchant_id IS NULL AND wallet_user_id IS NOT NULL/i, 'CHECK must require wallet_user_id set when merchant_id is null');
    });
    (0, node_test_1.it)('adds wallet_user_id index', () => {
        strict_1.default.match(MIGRATION, /idx_support_conversations_wallet_user_id/i);
    });
    (0, node_test_1.it)('adds wallet role to support_messages role CHECK', () => {
        strict_1.default.match(MIGRATION, /role IN \('merchant', 'bot', 'admin', 'wallet'\)/i);
    });
    (0, node_test_1.it)('adds RLS policy for wallet user isolation', () => {
        strict_1.default.match(MIGRATION, /support_conversations_wallet_user_isolation/i);
        strict_1.default.match(MIGRATION, /current_setting\('app\.current_wallet_user_id'/i);
    });
    (0, node_test_1.it)('adds RLS policy for wallet messages via conversation', () => {
        strict_1.default.match(MIGRATION, /support_messages_via_wallet_conversation/i);
    });
});
// ─── WS2: wallet support route uses requireActiveWallet + isolation ──
(0, node_test_1.describe)('WS2 — wallet support route isolation', () => {
    const ROUTE = readSrc('src/routes/wallet/support.ts');
    (0, node_test_1.it)('imports requireActiveWallet from wallet-auth', () => {
        strict_1.default.match(ROUTE, /from '.*wallet-auth(\.js)?'/i);
        strict_1.default.match(ROUTE, /requireActiveWallet/i);
    });
    (0, node_test_1.it)('does NOT import requireWallet from wallet-jwt', () => {
        strict_1.default.doesNotMatch(ROUTE, /from '.*wallet-jwt'/i);
    });
    (0, node_test_1.it)('POST message uses wallet_user_id for conversation lookup', () => {
        strict_1.default.match(ROUTE, /\.eq\('wallet_user_id', walletUserId\)/i);
    });
    (0, node_test_1.it)('POST message creates conversation with wallet_user_id', () => {
        strict_1.default.match(ROUTE, /insert\(\{ wallet_user_id: walletUserId/i);
    });
    (0, node_test_1.it)('POST message saves role: wallet', () => {
        strict_1.default.match(ROUTE, /role: 'wallet'/i);
    });
    (0, node_test_1.it)('GET conversations filters by wallet_user_id', () => {
        strict_1.default.match(ROUTE, /\.eq\('wallet_user_id', auth\.payload\.wallet_id\)/i);
    });
    (0, node_test_1.it)('GET messages verifies conversation belongs to wallet_user_id', () => {
        // The messages endpoint must check conversation ownership
        strict_1.default.match(ROUTE, /wallet_user_id, status/i);
    });
    (0, node_test_1.it)('transactions context is filtered by wallet_user_id', () => {
        strict_1.default.match(ROUTE, /\.eq\('wallet_user_id', walletUserId\)/i);
    });
    (0, node_test_1.it)('has rate limit on POST message', () => {
        strict_1.default.match(ROUTE, /rateLimit/i);
        strict_1.default.match(ROUTE, /max: 10/i);
        strict_1.default.match(ROUTE, /walletIdFromRequest/i);
    });
    (0, node_test_1.it)('uses generateWalletBotReply (not generateBotReply)', () => {
        strict_1.default.match(ROUTE, /generateWalletBotReply/i);
        strict_1.default.doesNotMatch(ROUTE, /generateBotReply\b(?!ForWallet)/i);
    });
});
// ─── WS3: support-bot.ts has wallet context ───────────────────────
(0, node_test_1.describe)('WS3 — support-bot wallet context', () => {
    const BOT = readSrc('src/services/support-bot.ts');
    (0, node_test_1.it)('exports WalletContext interface', () => {
        strict_1.default.match(BOT, /export interface WalletContext/i);
    });
    (0, node_test_1.it)('WalletContext includes wallet-specific fields', () => {
        strict_1.default.match(BOT, /phone: string/i);
        strict_1.default.match(BOT, /kyc_level: number/i);
        strict_1.default.match(BOT, /is_verified: boolean/i);
        strict_1.default.match(BOT, /balance_cdf/i);
        strict_1.default.match(BOT, /usdt_balance/i);
        strict_1.default.match(BOT, /cglt_balance/i);
    });
    (0, node_test_1.it)('exports generateWalletBotReply function', () => {
        strict_1.default.match(BOT, /export async function generateWalletBotReply/i);
    });
    (0, node_test_1.it)('buildWalletContextBlock uses wallet-specific vocabulary', () => {
        strict_1.default.match(BOT, /CONTEXTE DE L'UTILISATEUR WALLET/i);
        strict_1.default.match(BOT, /Niveau KYC/i);
        strict_1.default.match(BOT, /Solde CDF/i);
    });
    (0, node_test_1.it)('wallet bot maps role: wallet to user', () => {
        strict_1.default.match(BOT, /m\.role === 'wallet' \? 'user'/i);
    });
    (0, node_test_1.it)('system prompt mentions wallet users (not just merchants)', () => {
        strict_1.default.match(BOT, /utilisateurs wallet/i);
    });
});
// ─── WS4: admin support routes include wallet conversations ───────
(0, node_test_1.describe)('WS4 — admin support routes discriminate merchant vs wallet', () => {
    const ADMIN = readSrc('src/routes/admin/support.ts');
    (0, node_test_1.it)('list query selects wallet_user_id', () => {
        strict_1.default.match(ADMIN, /wallet_user_id/i);
    });
    (0, node_test_1.it)('list query joins wallet_users', () => {
        strict_1.default.match(ADMIN, /wallet_users\(phone, full_name, email\)/i);
    });
    (0, node_test_1.it)('list query supports type filter', () => {
        strict_1.default.match(ADMIN, /type.*merchant.*wallet/i);
    });
    (0, node_test_1.it)('adds type discriminant field to response', () => {
        strict_1.default.match(ADMIN, /type: isMerchant \? 'merchant' : 'wallet'/i);
    });
    (0, node_test_1.it)('adds owner_name field', () => {
        strict_1.default.match(ADMIN, /owner_name/i);
    });
    (0, node_test_1.it)('adds owner_phone field', () => {
        strict_1.default.match(ADMIN, /owner_phone/i);
    });
    (0, node_test_1.it)('messages endpoint also selects wallet_user_id and joins wallet_users', () => {
        strict_1.default.match(ADMIN, /wallet_users\(phone, full_name, email\)/i);
    });
    (0, node_test_1.it)('reply endpoint selects wallet_user_id', () => {
        // The reply route must handle both merchant and wallet conversations
        strict_1.default.match(ADMIN, /wallet_user_id/i);
    });
});
// ─── WS5: admin wallet email route + templates ────────────────────
(0, node_test_1.describe)('WS5 — admin wallet user email route + templates', () => {
    const WALLET_ADMIN = readSrc('src/routes/admin/wallet.ts');
    (0, node_test_1.it)('imports sendAdminDirectEmail', () => {
        strict_1.default.match(WALLET_ADMIN, /sendAdminDirectEmail/i);
    });
    (0, node_test_1.it)('has POST /admin/wallet-users/:id/email route', () => {
        strict_1.default.match(WALLET_ADMIN, /\/admin\/wallet-users\/:id\/email/i);
    });
    (0, node_test_1.it)('email route fetches wallet user email from DB', () => {
        strict_1.default.match(WALLET_ADMIN, /from\('wallet_users'\)/i);
        strict_1.default.match(WALLET_ADMIN, /\.eq\('id', id\)/i);
    });
    (0, node_test_1.it)('returns 400 if user has no email', () => {
        strict_1.default.match(WALLET_ADMIN, /has no email address on file/i);
    });
    (0, node_test_1.it)('creates conversation with wallet_user_id', () => {
        strict_1.default.match(WALLET_ADMIN, /insert\(\{ wallet_user_id: id/i);
    });
    (0, node_test_1.it)('verifies conversation ownership by wallet_user_id', () => {
        strict_1.default.match(WALLET_ADMIN, /\.eq\('wallet_user_id', id\)/i);
    });
    (0, node_test_1.it)('logs email in support_messages with channel: email', () => {
        strict_1.default.match(WALLET_ADMIN, /channel: 'email'/i);
    });
    (0, node_test_1.it)('has GET /admin/wallet-users/:id/support-templates route', () => {
        strict_1.default.match(WALLET_ADMIN, /\/admin\/wallet-users\/:id\/support-templates/i);
    });
    (0, node_test_1.it)('templates include KYC level 0 relance', () => {
        strict_1.default.match(WALLET_ADMIN, /Relance KYC niveau 1/i);
    });
    (0, node_test_1.it)('templates include KYC level 2 upgrade', () => {
        strict_1.default.match(WALLET_ADMIN, /Upgrade KYC niveau 2/i);
    });
    (0, node_test_1.it)('templates include account suspended', () => {
        strict_1.default.match(WALLET_ADMIN, /Compte suspendu/i);
    });
    (0, node_test_1.it)('has GET /admin/wallet-users/:id/email-history-summary route', () => {
        strict_1.default.match(WALLET_ADMIN, /\/admin\/wallet-users\/:id\/email-history-summary/i);
    });
});
// ─── WS6: route registration in server.ts ─────────────────────────
(0, node_test_1.describe)('WS6 — route registration', () => {
    const SERVER = readSrc('src/server.ts');
    (0, node_test_1.it)('imports walletSupportRoute', () => {
        strict_1.default.match(SERVER, /import walletSupportRoute from/i);
        strict_1.default.match(SERVER, /routes\/wallet\/support/i);
    });
    (0, node_test_1.it)('registers walletSupportRoute', () => {
        strict_1.default.match(SERVER, /v1\.register\(walletSupportRoute\)/i);
    });
});
// ─── WS7: no cross-user data leakage in wallet support ────────────
(0, node_test_1.describe)('WS7 — no cross-user data leakage patterns', () => {
    const ROUTE = readSrc('src/routes/wallet/support.ts');
    (0, node_test_1.it)('never selects merchant_id or merchants join', () => {
        strict_1.default.doesNotMatch(ROUTE, /merchant_id/i);
        strict_1.default.doesNotMatch(ROUTE, /from\('merchants'\)/i);
    });
    (0, node_test_1.it)('never uses api_keys table (merchant-only)', () => {
        strict_1.default.doesNotMatch(ROUTE, /api_keys/i);
    });
    (0, node_test_1.it)('wallet_user_id always comes from JWT payload, not request body', () => {
        // The route must use auth.payload.wallet_id, not request.body.wallet_user_id
        strict_1.default.match(ROUTE, /auth\.payload\.wallet_id/i);
        strict_1.default.doesNotMatch(ROUTE, /request\.body\.wallet_user_id/i);
    });
    (0, node_test_1.it)('conversation creation uses wallet_user_id from auth, not body', () => {
        strict_1.default.match(ROUTE, /wallet_user_id: walletUserId/i);
        // walletUserId must be derived from auth.payload.wallet_id
        strict_1.default.match(ROUTE, /const walletUserId = auth\.payload\.wallet_id/i);
    });
});
//# sourceMappingURL=wallet-support-security.test.js.map