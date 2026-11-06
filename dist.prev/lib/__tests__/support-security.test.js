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
 * Security tests for merchant support routes.
 * Verifies no cross-merchant data leakage is possible.
 */
const SUPPORT_ROUTE = node_path_1.default.resolve(__dirname, '../../routes/merchant/support.ts');
const SUPPORT_SOURCE = node_fs_1.default.readFileSync(SUPPORT_ROUTE, 'utf-8');
const ADMIN_SUPPORT_ROUTE = node_path_1.default.resolve(__dirname, '../../routes/admin/support.ts');
const ADMIN_SUPPORT_SOURCE = node_fs_1.default.readFileSync(ADMIN_SUPPORT_ROUTE, 'utf-8');
const BOT_SERVICE = node_path_1.default.resolve(__dirname, '../../services/support-bot.ts');
const BOT_SOURCE = node_fs_1.default.readFileSync(BOT_SERVICE, 'utf-8');
(0, node_test_1.describe)('merchant support — cross-merchant isolation', () => {
    (0, node_test_1.it)('conversation lookup always filters by merchant_id from JWT', () => {
        // When conversation_id is provided, the query must include .eq('merchant_id', merchantId)
        strict_1.default.match(SUPPORT_SOURCE, /\.eq\('id', conversationId\)[\s\S]*?\.eq\('merchant_id', merchantId\)/, 'conversation lookup must filter by merchant_id');
    });
    (0, node_test_1.it)('GET conversations filters by merchant_id from JWT', () => {
        strict_1.default.match(SUPPORT_SOURCE, /merchant\/support\/conversations[\s\S]*?\.eq\('merchant_id', auth\.payload\.merchant_id\)/, 'conversations list must filter by merchant_id');
    });
    (0, node_test_1.it)('GET messages verifies conversation belongs to merchant before returning', () => {
        strict_1.default.match(SUPPORT_SOURCE, /conversations\/:id\/messages[\s\S]*?\.eq\('merchant_id', auth\.payload\.merchant_id\)/, 'messages route must verify conversation ownership');
    });
    (0, node_test_1.it)('merchant context fetches only this merchant data', () => {
        // The transactions query must filter by merchant_id
        strict_1.default.match(SUPPORT_SOURCE, /\.from\('transactions'\)[\s\S]*?\.eq\('merchant_id', merchantId\)/, 'transactions context must filter by merchant_id');
        // The merchant query must filter by id
        strict_1.default.match(SUPPORT_SOURCE, /\.from\('merchants'\)[\s\S]*?\.eq\('id', merchantId\)/, 'merchant context must filter by id');
        // The api_keys query must filter by merchant_id
        strict_1.default.match(SUPPORT_SOURCE, /\.from\('api_keys'\)[\s\S]*?\.eq\('merchant_id', merchantId\)/, 'api_keys context must filter by merchant_id');
    });
    (0, node_test_1.it)('no SELECT * or unfiltered queries on merchants/transactions tables', () => {
        // Ensure there's no .from('merchants').select('*') without .eq filter
        const unfilteredMerchant = SUPPORT_SOURCE.match(/\.from\('merchants'\)[\s\S]{0,200}$/gm);
        if (unfilteredMerchant) {
            for (const match of unfilteredMerchant) {
                strict_1.default.ok(match.includes('.eq(') || match.includes('merchantId'), `unfiltered merchant query found: ${match.slice(0, 80)}`);
            }
        }
    });
    (0, node_test_1.it)('requireActiveMerchant extracts merchant_id from JWT, not from body or query', () => {
        strict_1.default.ok(SUPPORT_SOURCE.includes('requireActiveMerchant'), 'uses requireActiveMerchant');
        strict_1.default.ok(SUPPORT_SOURCE.includes('auth.payload.merchant_id'), 'uses auth.payload.merchant_id');
        // Ensure merchant_id is never taken from request.body
        strict_1.default.ok(!SUPPORT_SOURCE.includes('body.merchant_id') && !SUPPORT_SOURCE.includes('request.body.merchant_id'), 'merchant_id must never come from request body');
    });
});
(0, node_test_1.describe)('merchant support — escalation behavior', () => {
    (0, node_test_1.it)('bot service marks [ESCALATE] prefix as escalated', () => {
        strict_1.default.ok(BOT_SOURCE.includes('[ESCALATE]'), 'system prompt uses [ESCALATE] marker');
        strict_1.default.match(BOT_SOURCE, /startsWith\('\[ESCALATE\]'\)/, 'detects [ESCALATE] prefix');
    });
    (0, node_test_1.it)('system prompt instructs to escalate when bot cannot answer', () => {
        strict_1.default.ok(BOT_SOURCE.includes('dépasse ce que les données fournies permettent') ||
            BOT_SOURCE.includes('ne peux pas répondre'), 'system prompt includes escalation instructions');
        strict_1.default.ok(BOT_SOURCE.includes('humain') || BOT_SOURCE.includes('escalade'), 'system prompt mentions human escalation');
    });
    (0, node_test_1.it)('support route updates conversation status to escalated', () => {
        strict_1.default.match(SUPPORT_SOURCE, /status: 'escalated'/, 'sets status to escalated');
    });
    (0, node_test_1.it)('support route sends escalation email', () => {
        strict_1.default.ok(SUPPORT_SOURCE.includes('sendSupportEscalationEmail'), 'calls escalation email');
    });
    (0, node_test_1.it)('bot service returns escalated=true when ANTHROPIC_API_KEY is missing', () => {
        strict_1.default.match(BOT_SOURCE, /if \(!env\.ANTHROPIC_API_KEY\)[\s\S]*?escalated: true/, 'escalates when API key missing');
    });
    (0, node_test_1.it)('bot service returns escalated=true on API error', () => {
        strict_1.default.match(BOT_SOURCE, /catch[\s\S]*?escalated: true/, 'escalates on API error');
    });
});
(0, node_test_1.describe)('admin support — reply and conversation access', () => {
    (0, node_test_1.it)('admin routes require admin session', () => {
        strict_1.default.ok(ADMIN_SUPPORT_SOURCE.includes('requireAdmin(request.isAdmin)'), 'admin guard present');
        // Count occurrences — should be at least 3 (list, messages, reply)
        const count = (ADMIN_SUPPORT_SOURCE.match(/requireAdmin\(request\.isAdmin\)/g) ?? []).length;
        strict_1.default.ok(count >= 3, `expected at least 3 admin guards, got ${count}`);
    });
    (0, node_test_1.it)('admin reply saves message with role=admin', () => {
        strict_1.default.match(ADMIN_SUPPORT_SOURCE, /role: 'admin'/, 'admin reply uses role=admin');
    });
    (0, node_test_1.it)('admin reply can resolve conversation', () => {
        strict_1.default.match(ADMIN_SUPPORT_SOURCE, /resolve.*resolved/, 'admin reply can set status to resolved');
    });
    (0, node_test_1.it)('admin conversations list includes merchant info', () => {
        strict_1.default.match(ADMIN_SUPPORT_SOURCE, /merchants\(name, email\)/, 'admin list includes merchant name and email');
    });
    (0, node_test_1.it)('admin conversations list is filterable by status', () => {
        strict_1.default.match(ADMIN_SUPPORT_SOURCE, /status.*enum.*open.*escalated.*resolved/, 'admin list supports status filter');
    });
});
(0, node_test_1.describe)('support — migration exists', () => {
    (0, node_test_1.it)('migration file exists with both tables', () => {
        const migrationPath = node_path_1.default.resolve(__dirname, '../../../supabase/migrations/20260907000000_support_conversations.sql');
        strict_1.default.ok(node_fs_1.default.existsSync(migrationPath), 'migration file exists');
        const migration = node_fs_1.default.readFileSync(migrationPath, 'utf-8');
        strict_1.default.ok(migration.includes('support_conversations'), 'creates support_conversations table');
        strict_1.default.ok(migration.includes('support_messages'), 'creates support_messages table');
        strict_1.default.ok(migration.includes('merchant_id'), 'conversations have merchant_id');
        strict_1.default.ok(migration.includes("CHECK (role IN ('merchant', 'bot', 'admin'))"), 'messages role check constraint');
        strict_1.default.ok(migration.includes("CHECK (status IN ('open', 'escalated', 'resolved'))"), 'conversation status check constraint');
        strict_1.default.ok(migration.includes('ROW LEVEL SECURITY'), 'enables RLS');
    });
});
//# sourceMappingURL=support-security.test.js.map