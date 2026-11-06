"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const email_templates_js_1 = require("../email-templates.js");
/* ── Test fixtures ─────────────────────────────────────────── */
const MERCHANT_PENDING_MISSING = {
    name: 'Lotika Forex',
    email: 'lotika@example.com',
    phone: '+243880000100',
    kyc_status: 'pending',
    mode: 'sandbox',
    status: 'active',
    company_name: 'Lotika Forex SARL',
    company_rccm: null, // ← missing
    company_idnat: null, // ← missing
    kyc_notes: null,
    kyc_submitted_at: null,
    kyc_reviewed_at: null,
};
const MERCHANT_PENDING_COMPLETE = {
    name: 'Completo SARL',
    email: 'completo@example.com',
    phone: '+243880000101',
    kyc_status: 'pending',
    mode: 'sandbox',
    status: 'active',
    company_name: 'Completo SARL',
    company_rccm: 'CD/KIN/2024/123',
    company_idnat: 'ID-998877',
    kyc_notes: null,
    kyc_submitted_at: null,
    kyc_reviewed_at: null,
};
const MERCHANT_PENDING_RCCM_ONLY = {
    name: 'Partial SARL',
    email: 'partial@example.com',
    phone: '+243880000102',
    kyc_status: 'pending',
    mode: 'sandbox',
    status: 'active',
    company_name: 'Partial SARL',
    company_rccm: 'CD/KIN/2024/456',
    company_idnat: null, // ← only ID Nat missing
    kyc_notes: null,
    kyc_submitted_at: null,
    kyc_reviewed_at: null,
};
// Only phone missing (all KYC doc fields present but no contact phone)
const MERCHANT_PENDING_PHONE_MISSING = {
    name: 'NoPhone SARL',
    email: 'nophone@example.com',
    phone: null, // ← only phone missing
    kyc_status: 'pending',
    mode: 'sandbox',
    status: 'active',
    company_name: 'NoPhone SARL',
    company_rccm: 'CD/KIN/2024/999',
    company_idnat: 'ID-555666',
    kyc_notes: null,
    kyc_submitted_at: null,
    kyc_reviewed_at: null,
};
// Only company_name missing (rare but possible — registered before KYC fill)
const MERCHANT_PENDING_NAME_MISSING = {
    name: 'NoCoName',
    email: 'noconame@example.com',
    phone: '+243880000103',
    kyc_status: 'pending',
    mode: 'sandbox',
    status: 'active',
    company_name: null, // ← only company_name missing
    company_rccm: 'CD/KIN/2024/888',
    company_idnat: 'ID-777888',
    kyc_notes: null,
    kyc_submitted_at: null,
    kyc_reviewed_at: null,
};
// Everything missing (fresh registration, never submitted KYC)
const MERCHANT_PENDING_ALL_MISSING = {
    name: 'Fresh Merchant',
    email: 'fresh@example.com',
    phone: null,
    kyc_status: 'pending',
    mode: 'sandbox',
    status: 'active',
    company_name: null,
    company_rccm: null,
    company_idnat: null,
    kyc_notes: null,
    kyc_submitted_at: null,
    kyc_reviewed_at: null,
};
const MERCHANT_REJECTED = {
    name: 'Rejected Corp',
    email: 'rejected@example.com',
    phone: '+243880000104',
    kyc_status: 'rejected',
    mode: 'sandbox',
    status: 'active',
    company_name: 'Rejected Corp',
    company_rccm: 'CD/KIN/2024/789',
    company_idnat: 'ID-111222',
    kyc_notes: 'Document illisible, veuillez soumettre une copie plus nette',
    kyc_submitted_at: '2026-09-01T10:00:00Z',
    kyc_reviewed_at: '2026-09-02T14:00:00Z',
};
const MERCHANT_APPROVED_LIVE = {
    name: 'Approved Live',
    email: 'approved@example.com',
    phone: '+243880000105',
    kyc_status: 'approved',
    mode: 'live',
    status: 'active',
    company_name: 'Approved Live SARL',
    company_rccm: 'CD/KIN/2024/000',
    company_idnat: 'ID-333444',
    kyc_notes: null,
    kyc_submitted_at: '2026-08-01T10:00:00Z',
    kyc_reviewed_at: '2026-08-02T14:00:00Z',
};
const MERCHANT_APPROVED_SANDBOX = {
    ...MERCHANT_APPROVED_LIVE,
    mode: 'sandbox',
};
const MERCHANT_SUSPENDED = {
    ...MERCHANT_APPROVED_LIVE,
    status: 'suspended',
};
const WALLET_USER_LEVEL0 = {
    phone: '+243880000001',
    full_name: 'Jean Dupont',
    email: 'jean@example.com',
    kyc_level: 0,
    is_verified: false,
    is_active: true,
    kyc_submitted_at: null,
};
const WALLET_USER_LEVEL1 = {
    phone: '+243880000002',
    full_name: 'Marie Curie',
    email: 'marie@example.com',
    kyc_level: 1,
    is_verified: true,
    is_active: true,
    kyc_submitted_at: '2026-09-01T10:00:00Z',
};
const WALLET_USER_BLOCKED = {
    ...WALLET_USER_LEVEL1,
    is_active: false,
};
/* ── Tests: merchant template generation ────────────────────── */
(0, node_test_1.describe)('buildEmailTemplates — merchant', () => {
    (0, node_test_1.describe)('A — Complément KYC ciblé', () => {
        (0, node_test_1.it)('lists RCCM and ID National when both missing (phone + company_name present)', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_PENDING_MISSING);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Complément KYC ciblé');
            strict_1.default.ok(tpl, 'targeted template should exist');
            strict_1.default.ok(tpl.body.includes('RCCM'), 'mentions RCCM');
            strict_1.default.ok(tpl.body.includes('ID National'), 'mentions ID National');
            strict_1.default.ok(!tpl.body.includes('Raison sociale'), 'does not mention company_name (present)');
            strict_1.default.ok(!tpl.body.includes('téléphone'), 'does not mention phone (present)');
            strict_1.default.ok(tpl.body.includes('Lotika Forex'), 'uses merchant name');
        });
        (0, node_test_1.it)('lists only ID National when RCCM is present but ID Nat is missing', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_PENDING_RCCM_ONLY);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Complément KYC ciblé');
            strict_1.default.ok(tpl, 'targeted template should exist');
            strict_1.default.ok(tpl.body.includes('ID National'), 'mentions ID National');
            strict_1.default.ok(!tpl.body.includes('RCCM (Registre de Commerce)'), 'does not mention RCCM as missing');
        });
        (0, node_test_1.it)('lists only phone when all doc fields are present but phone is missing', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_PENDING_PHONE_MISSING);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Complément KYC ciblé');
            strict_1.default.ok(tpl, 'targeted template should exist');
            strict_1.default.ok(tpl.body.includes('téléphone'), 'mentions phone');
            strict_1.default.ok(!tpl.body.includes('RCCM (Registre de Commerce)'), 'does not mention RCCM (present)');
            strict_1.default.ok(!tpl.body.includes('ID National'), 'does not mention ID National (present)');
        });
        (0, node_test_1.it)('lists only raison sociale when company_name is missing', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_PENDING_NAME_MISSING);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Complément KYC ciblé');
            strict_1.default.ok(tpl, 'targeted template should exist');
            strict_1.default.ok(tpl.body.includes('Raison sociale'), 'mentions company_name');
            strict_1.default.ok(!tpl.body.includes('RCCM (Registre de Commerce)'), 'does not mention RCCM (present)');
        });
        (0, node_test_1.it)('lists ALL four fields when everything is missing (fresh registration)', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_PENDING_ALL_MISSING);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Complément KYC ciblé');
            strict_1.default.ok(tpl, 'targeted template should exist');
            strict_1.default.ok(tpl.body.includes('Raison sociale'), 'mentions company_name');
            strict_1.default.ok(tpl.body.includes('RCCM'), 'mentions RCCM');
            strict_1.default.ok(tpl.body.includes('ID National'), 'mentions ID National');
            strict_1.default.ok(tpl.body.includes('téléphone'), 'mentions phone');
        });
        (0, node_test_1.it)('falls back to generic "Relance KYC" when pending but no fields are missing', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_PENDING_COMPLETE);
            const targeted = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Complément KYC ciblé');
            const generic = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Relance KYC');
            strict_1.default.ok(!targeted, 'targeted template should NOT exist when all fields are complete');
            strict_1.default.ok(generic, 'generic relance should exist as fallback');
        });
    });
    (0, node_test_1.describe)('B — KYC rejeté', () => {
        (0, node_test_1.it)('includes kyc_notes in the body when available', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_REJECTED);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'KYC rejeté');
            strict_1.default.ok(tpl, 'rejected template should exist');
            strict_1.default.ok(tpl.body.includes('Document illisible'), 'includes kyc_notes content');
        });
        (0, node_test_1.it)('works without kyc_notes (graceful)', () => {
            const noNotes = { ...MERCHANT_REJECTED, kyc_notes: null };
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', noNotes);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'KYC rejeté');
            strict_1.default.ok(tpl, 'rejected template should exist');
            strict_1.default.ok(!tpl.body.includes('Motif :'), 'does not show empty motif section');
        });
    });
    (0, node_test_1.describe)('C — KYC approuvé', () => {
        (0, node_test_1.it)('exists when kyc_status is approved', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'KYC approuvé');
            strict_1.default.ok(tpl, 'approved template should exist');
            strict_1.default.ok(tpl.body.includes('Approved Live'), 'uses merchant name');
        });
    });
    (0, node_test_1.describe)('Passage en mode live (existing)', () => {
        (0, node_test_1.it)('exists when approved + sandbox', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_SANDBOX);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Passage en mode live');
            strict_1.default.ok(tpl, 'passage en mode live template should exist');
        });
        (0, node_test_1.it)('does NOT exist when approved + live', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Passage en mode live');
            strict_1.default.ok(!tpl, 'should not exist when already live');
        });
    });
    (0, node_test_1.describe)('D — Compte suspendu', () => {
        (0, node_test_1.it)('exists when status is suspended', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_SUSPENDED);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Compte suspendu');
            strict_1.default.ok(tpl, 'suspended template should exist');
        });
        (0, node_test_1.it)('does NOT exist when status is active', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Compte suspendu');
            strict_1.default.ok(!tpl, 'should not exist when active');
        });
    });
    (0, node_test_1.describe)('E — Compte réactivé', () => {
        (0, node_test_1.it)('exists when status is active', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Compte réactivé');
            strict_1.default.ok(tpl, 'reactivated template should exist when active');
        });
    });
    (0, node_test_1.describe)('F — Régénération de clé API', () => {
        (0, node_test_1.it)('always exists (not conditional)', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Régénération de clé API');
            strict_1.default.ok(tpl, 'regeneration template should always exist');
        });
        (0, node_test_1.it)('uses api_key_label from extraVars when provided', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE, { api_key_label: 'production-key' });
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Régénération de clé API');
            strict_1.default.ok(tpl, 'template exists');
            strict_1.default.ok(tpl.body.includes('production-key'), 'uses custom api_key_label');
        });
        (0, node_test_1.it)('falls back to generic "votre clé API" when no label provided', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Régénération de clé API');
            strict_1.default.ok(tpl, 'template exists');
            strict_1.default.ok(tpl.body.includes('votre clé API'), 'uses generic label');
        });
    });
    (0, node_test_1.describe)('G — Révocation de clé API', () => {
        (0, node_test_1.it)('always exists (not conditional)', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Révocation de clé API');
            strict_1.default.ok(tpl, 'revocation template should always exist');
        });
    });
    (0, node_test_1.describe)('Generic template', () => {
        (0, node_test_1.it)('always exists with merchant name', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('merchant', MERCHANT_APPROVED_LIVE);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Réponse à votre demande');
            strict_1.default.ok(tpl, 'generic template always exists');
            strict_1.default.ok(tpl.body.includes('Approved Live'), 'uses merchant name');
            strict_1.default.equal(tpl.subject, '', 'generic has empty subject');
        });
    });
});
/* ── Tests: wallet user template generation ────────────────── */
(0, node_test_1.describe)('buildEmailTemplates — wallet_user', () => {
    (0, node_test_1.describe)('Relance KYC niveau 1', () => {
        (0, node_test_1.it)('exists when kyc_level === 0', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL0);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Relance KYC niveau 1');
            strict_1.default.ok(tpl, 'should exist for level 0');
        });
        (0, node_test_1.it)('does NOT exist when kyc_level >= 1', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL1);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Relance KYC niveau 1');
            strict_1.default.ok(!tpl, 'should not exist for level 1+');
        });
    });
    (0, node_test_1.describe)('Upgrade KYC niveau 2', () => {
        (0, node_test_1.it)('exists when kyc_level === 1', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL1);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Upgrade KYC niveau 2');
            strict_1.default.ok(tpl, 'should exist for level 1');
        });
    });
    (0, node_test_1.describe)('KYC niveau 1 validé', () => {
        (0, node_test_1.it)('exists when kyc_level >= 1 and is_verified', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL1);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'KYC niveau 1 validé');
            strict_1.default.ok(tpl, 'should exist for verified level 1+');
        });
        (0, node_test_1.it)('does NOT exist when kyc_level === 0', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL0);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'KYC niveau 1 validé');
            strict_1.default.ok(!tpl, 'should not exist for level 0');
        });
    });
    (0, node_test_1.describe)('Compte suspendu', () => {
        (0, node_test_1.it)('exists when is_active is false', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_BLOCKED);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Compte suspendu');
            strict_1.default.ok(tpl, 'should exist when blocked');
        });
        (0, node_test_1.it)('does NOT exist when is_active is true', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL1);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Compte suspendu');
            strict_1.default.ok(!tpl, 'should not exist when active');
        });
    });
    (0, node_test_1.describe)('Compte réactivé', () => {
        (0, node_test_1.it)('exists when is_active is true', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL1);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Compte réactivé');
            strict_1.default.ok(tpl, 'should exist when active');
        });
    });
    (0, node_test_1.describe)('Generic template', () => {
        (0, node_test_1.it)('always exists with user name', () => {
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', WALLET_USER_LEVEL1);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Réponse à votre demande');
            strict_1.default.ok(tpl, 'generic template always exists');
            strict_1.default.ok(tpl.body.includes('Marie Curie'), 'uses full_name');
        });
        (0, node_test_1.it)('falls back to phone when full_name is null', () => {
            const noName = { ...WALLET_USER_LEVEL0, full_name: null };
            const templates = (0, email_templates_js_1.buildEmailTemplates)('wallet_user', noName);
            const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, 'Réponse à votre demande');
            strict_1.default.ok(tpl, 'generic template exists');
            strict_1.default.ok(tpl.body.includes('+243880000001'), 'uses phone as name');
        });
    });
});
/* ── Tests: auto-send behavior (static analysis) ────────────── */
(0, node_test_1.describe)('auto-send — static analysis of route files', () => {
    const MERCHANTS_ROUTE = node_path_1.default.resolve(__dirname, '../../routes/admin/merchants.ts');
    const WALLET_ROUTE = node_path_1.default.resolve(__dirname, '../../routes/admin/wallet.ts');
    const MERCHANTS_SRC = node_fs_1.default.readFileSync(MERCHANTS_ROUTE, 'utf-8');
    const WALLET_SRC = node_fs_1.default.readFileSync(WALLET_ROUTE, 'utf-8');
    (0, node_test_1.describe)('merchant actions with auto-send', () => {
        (0, node_test_1.it)('kyc/approve has auto-send for "KYC approuvé"', () => {
            strict_1.default.match(MERCHANTS_SRC, /kyc\/approve[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'KYC approuvé'/, 'kyc/approve auto-sends "KYC approuvé" template');
        });
        (0, node_test_1.it)('reactivate has auto-send for "Compte réactivé"', () => {
            strict_1.default.match(MERCHANTS_SRC, /reactivate[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'Compte réactivé'/, 'reactivate auto-sends "Compte réactivé" template');
        });
        (0, node_test_1.it)('api-keys/regenerate has auto-send for "Régénération de clé API"', () => {
            strict_1.default.match(MERCHANTS_SRC, /api-keys\/regenerate[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'Régénération de clé API'/, 'regenerate auto-sends "Régénération de clé API" template');
        });
        (0, node_test_1.it)('api-keys/revoke has auto-send for "Révocation de clé API"', () => {
            strict_1.default.match(MERCHANTS_SRC, /api-keys\/revoke[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'Révocation de clé API'/, 'revoke auto-sends "Révocation de clé API" template');
        });
    });
    (0, node_test_1.describe)('merchant actions WITHOUT auto-send (manual only)', () => {
        (0, node_test_1.it)('suspend does NOT have sendTemplateAuto', () => {
            // Extract the suspend route body and verify no auto-send
            const suspendMatch = MERCHANTS_SRC.match(/'\/admin\/merchants\/:id\/suspend'[\s\S]*?\n  \);/);
            strict_1.default.ok(suspendMatch, 'suspend route found');
            strict_1.default.ok(!suspendMatch[0].includes('sendTemplateAuto'), 'suspend must NOT auto-send (manual only — investigation context)');
        });
        (0, node_test_1.it)('kyc/reject does NOT have sendTemplateAuto', () => {
            const rejectMatch = MERCHANTS_SRC.match(/'\/admin\/merchants\/:id\/kyc\/reject'[\s\S]*?\n  \);/);
            strict_1.default.ok(rejectMatch, 'kyc/reject route found');
            strict_1.default.ok(!rejectMatch[0].includes('sendTemplateAuto'), 'kyc/reject must NOT auto-send (manual only — tone/context matters)');
        });
    });
    (0, node_test_1.describe)('wallet user actions with auto-send', () => {
        (0, node_test_1.it)('unblock has auto-send for "Compte réactivé"', () => {
            strict_1.default.match(WALLET_SRC, /unblock[\s\S]*?sendTemplateAuto\('wallet_user'[\s\S]*?'Compte réactivé'/, 'unblock auto-sends "Compte réactivé" template');
        });
        (0, node_test_1.it)('kyc/approve (wallet users) has auto-send for "KYC niveau 1 validé"', () => {
            strict_1.default.match(WALLET_SRC, /wallet\/users\/:id\/kyc\/approve[\s\S]*?sendTemplateAuto\('wallet_user'[\s\S]*?'KYC niveau 1 validé'/, 'wallet kyc/approve auto-sends "KYC niveau 1 validé" template');
        });
        (0, node_test_1.it)('kyc submission approve has auto-send for "KYC niveau 1 validé"', () => {
            strict_1.default.match(WALLET_SRC, /wallet\/kyc\/:id\/approve[\s\S]*?sendTemplateAuto\('wallet_user'[\s\S]*?'KYC niveau 1 validé'/, 'kyc submission approve auto-sends "KYC niveau 1 validé" template');
        });
    });
    (0, node_test_1.describe)('wallet user actions WITHOUT auto-send', () => {
        (0, node_test_1.it)('block does NOT have sendTemplateAuto', () => {
            // Extract the block route body (not unblock) and verify no auto-send
            const blockMatch = WALLET_SRC.match(/'\/admin\/wallet\/users\/:id\/block'[\s\S]*?\n  \}\);/);
            strict_1.default.ok(blockMatch, 'block route found');
            strict_1.default.ok(!blockMatch[0].includes('sendTemplateAuto'), 'block must NOT auto-send (manual only — same as merchant suspend)');
        });
    });
    (0, node_test_1.describe)('non-blocking contract', () => {
        (0, node_test_1.it)('all auto-sends use void + .then (fire-and-forget)', () => {
            // Every sendTemplateAuto call should be preceded by void
            const allCalls = MERCHANTS_SRC.match(/void sendTemplateAuto/g) ?? [];
            const allCallsWallet = WALLET_SRC.match(/void sendTemplateAuto/g) ?? [];
            strict_1.default.ok(allCalls.length >= 4, `merchants.ts should have >=4 void sendTemplateAuto calls, found ${allCalls.length}`);
            strict_1.default.ok(allCallsWallet.length >= 3, `wallet.ts should have >=3 void sendTemplateAuto calls, found ${allCallsWallet.length}`);
        });
        (0, node_test_1.it)('auto-send logs success with [admin-auto-email] prefix', () => {
            strict_1.default.match(MERCHANTS_SRC, /\[admin-auto-email\].*sent/, 'logs success');
            strict_1.default.match(MERCHANTS_SRC, /\[admin-auto-email\].*NOT sent/, 'logs failure');
        });
    });
});
/* ── Tests: unified helper (deduplication) ─────────────────── */
(0, node_test_1.describe)('unified helper — deduplication', () => {
    (0, node_test_1.it)('merchants.ts imports from lib/email-templates (not inline)', () => {
        const src = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../routes/admin/merchants.ts'), 'utf-8');
        strict_1.default.match(src, /from '..\/..\/lib\/email-templates/, 'imports unified helper');
        strict_1.default.match(src, /buildEmailTemplates\('merchant'/, 'uses buildEmailTemplates');
    });
    (0, node_test_1.it)('wallet.ts imports from lib/email-templates (not inline)', () => {
        const src = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../routes/admin/wallet.ts'), 'utf-8');
        strict_1.default.match(src, /from '..\/..\/lib\/email-templates/, 'imports unified helper');
        strict_1.default.match(src, /buildEmailTemplates\('wallet_user'/, 'uses buildEmailTemplates');
    });
    (0, node_test_1.it)('merchants.ts no longer has inline template generation', () => {
        const src = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, '../../routes/admin/merchants.ts'), 'utf-8');
        // The old inline pattern was: const name = m.name ?? m.email; followed by templates.push
        strict_1.default.ok(!src.match(/const name = m\.name \?\? m\.email/), 'old inline name assignment removed');
    });
});
//# sourceMappingURL=email-templates.test.js.map