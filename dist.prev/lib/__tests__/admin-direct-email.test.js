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
 * Tests for admin direct email to merchant feature.
 * Verifies: channel='email' logging, template logic, admin guards,
 * and cross-merchant email isolation.
 */
const MERCHANTS_ROUTE = node_path_1.default.resolve(__dirname, '../../routes/admin/merchants.ts');
const MERCHANTS_SOURCE = node_fs_1.default.readFileSync(MERCHANTS_ROUTE, 'utf-8');
const EMAIL_SERVICE = node_path_1.default.resolve(__dirname, '../../services/email.ts');
const EMAIL_SOURCE = node_fs_1.default.readFileSync(EMAIL_SERVICE, 'utf-8');
const MIGRATION_PATH = node_path_1.default.resolve(__dirname, '../../../supabase/migrations/20260907010000_support_messages_channel.sql');
(0, node_test_1.describe)('admin direct email — migration', () => {
    (0, node_test_1.it)('migration adds channel column with check constraint', () => {
        strict_1.default.ok(node_fs_1.default.existsSync(MIGRATION_PATH), 'migration file exists');
        const migration = node_fs_1.default.readFileSync(MIGRATION_PATH, 'utf-8');
        strict_1.default.ok(migration.includes('channel'), 'adds channel column');
        strict_1.default.ok(migration.includes("CHECK (channel IN ('chat', 'email'))"), 'channel check constraint');
        strict_1.default.ok(migration.includes("DEFAULT 'chat'"), 'defaults to chat');
    });
    (0, node_test_1.it)('migration adds subject column (nullable)', () => {
        const migration = node_fs_1.default.readFileSync(MIGRATION_PATH, 'utf-8');
        strict_1.default.ok(migration.includes('subject'), 'adds subject column');
        strict_1.default.ok(migration.includes('ADD COLUMN IF NOT EXISTS subject text'), 'subject is nullable text');
    });
});
(0, node_test_1.describe)('admin direct email — route guards', () => {
    (0, node_test_1.it)('POST /admin/merchants/:id/email requires admin', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /\/admin\/merchants\/:id\/email[\s\S]*?requireAdmin\(request\.isAdmin\)/, 'email route has admin guard');
    });
    (0, node_test_1.it)('GET /admin/merchants/:id/support-templates requires admin', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /\/admin\/merchants\/:id\/support-templates[\s\S]*?requireAdmin\(request\.isAdmin\)/, 'templates route has admin guard');
    });
    (0, node_test_1.it)('email route validates body schema (subject + body required)', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /required: \['subject', 'body'\]/, 'subject and body are required');
    });
});
(0, node_test_1.describe)('admin direct email — cross-merchant isolation', () => {
    (0, node_test_1.it)('email is sent to merchant.email from DB, never from request body', () => {
        // The route fetches merchant by id, then uses m.email
        strict_1.default.match(MERCHANTS_SOURCE, /\.from\('merchants'\)[\s\S]*?\.eq\('id', id\)[\s\S]*?sendAdminDirectEmail\(m\.email/, 'email address comes from DB merchant record, not from body');
        // Ensure the body never contains a "to" or "email" field for the recipient
        strict_1.default.ok(!MERCHANTS_SOURCE.match(/body\.(to|email|recipient)/), 'request body must not contain recipient email field');
    });
    (0, node_test_1.it)('conversation lookup verifies merchant_id ownership', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /\/admin\/merchants\/:id\/email[\s\S]*?\.eq\('merchant_id', id\)/, 'conversation ownership verified by merchant_id');
    });
    (0, node_test_1.it)('new conversation is created with merchant_id from route params, not body', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /insert\(\{ merchant_id: id[\s\S]*?status: 'open'/, 'new conversation uses route param id as merchant_id');
    });
});
(0, node_test_1.describe)('admin direct email — message logging', () => {
    (0, node_test_1.it)('message is logged with channel=email', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /channel: 'email'/, 'logs message with channel=email');
    });
    (0, node_test_1.it)('message is logged with role=admin', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /\/admin\/merchants\/:id\/email[\s\S]*?role: 'admin'/, 'logs message with role=admin');
    });
    (0, node_test_1.it)('message is logged with subject from body', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /subject,\s*\n\s*content: body/, 'stores subject and content from body');
    });
});
(0, node_test_1.describe)('admin direct email — template logic', () => {
    (0, node_test_1.it)('templates vary by kyc_status=pending', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /kyc_status === 'pending'[\s\S]*?Relance KYC/, 'pending KYC template exists');
    });
    (0, node_test_1.it)('templates vary by kyc_status=submitted', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /kyc_status === 'submitted'[\s\S]*?KYC en cours de revue/, 'submitted KYC template exists');
    });
    (0, node_test_1.it)('templates vary by kyc_status=approved + mode=sandbox', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /kyc_status === 'approved' && m\.mode === 'sandbox'[\s\S]*?Passage en mode live/, 'approved+sandbox template exists');
    });
    (0, node_test_1.it)('generic template always available', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /Réponse à votre demande/, 'generic template exists');
    });
    (0, node_test_1.it)('templates include merchant name variable substitution', () => {
        // The template body uses the merchant's name from DB
        strict_1.default.match(MERCHANTS_SOURCE, /const name = m\.name \?\? m\.email/, 'uses merchant name from DB for template substitution');
    });
    (0, node_test_1.it)('templates route fetches merchant by id to determine kyc_status', () => {
        strict_1.default.match(MERCHANTS_SOURCE, /support-templates[\s\S]*?\.from\('merchants'\)[\s\S]*?\.eq\('id', id\)/, 'templates route fetches merchant by id');
    });
});
(0, node_test_1.describe)('admin direct email — email service', () => {
    (0, node_test_1.it)('sendAdminDirectEmail function exists', () => {
        strict_1.default.ok(EMAIL_SOURCE.includes('export async function sendAdminDirectEmail'), 'function exported');
    });
    (0, node_test_1.it)('sendAdminDirectEmail accepts to, subject, body params', () => {
        strict_1.default.match(EMAIL_SOURCE, /sendAdminDirectEmail\(\s*to: string,\s*subject: string,\s*body: string/, 'accepts to, subject, body');
    });
    (0, node_test_1.it)('sendAdminDirectEmail uses Brevo client (same as other emails)', () => {
        strict_1.default.match(EMAIL_SOURCE, /sendAdminDirectEmail[\s\S]*?getClient\(\)/, 'uses same Brevo client as other email functions');
    });
    (0, node_test_1.it)('sendAdminDirectEmail sends to the provided address', () => {
        strict_1.default.match(EMAIL_SOURCE, /sendAdminDirectEmail[\s\S]*?to: \[\{ email: to \}\]/, 'sends to the provided address');
    });
});
//# sourceMappingURL=admin-direct-email.test.js.map