import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildEmailTemplates,
  findTemplateByLabel,
  type MerchantTemplateData,
  type WalletUserTemplateData,
} from '../email-templates.js';

/* ── Test fixtures ─────────────────────────────────────────── */

const MERCHANT_PENDING_MISSING: MerchantTemplateData = {
  name: 'Lotika Forex',
  email: 'lotika@example.com',
  phone: '+243880000100',
  kyc_status: 'pending',
  mode: 'sandbox',
  status: 'active',
  company_name: 'Lotika Forex SARL',
  company_rccm: null,        // ← missing
  company_idnat: null,      // ← missing
  kyc_notes: null,
  kyc_submitted_at: null,
  kyc_reviewed_at: null,
};

const MERCHANT_PENDING_COMPLETE: MerchantTemplateData = {
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

const MERCHANT_PENDING_RCCM_ONLY: MerchantTemplateData = {
  name: 'Partial SARL',
  email: 'partial@example.com',
  phone: '+243880000102',
  kyc_status: 'pending',
  mode: 'sandbox',
  status: 'active',
  company_name: 'Partial SARL',
  company_rccm: 'CD/KIN/2024/456',
  company_idnat: null,      // ← only ID Nat missing
  kyc_notes: null,
  kyc_submitted_at: null,
  kyc_reviewed_at: null,
};

// Only phone missing (all KYC doc fields present but no contact phone)
const MERCHANT_PENDING_PHONE_MISSING: MerchantTemplateData = {
  name: 'NoPhone SARL',
  email: 'nophone@example.com',
  phone: null,              // ← only phone missing
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
const MERCHANT_PENDING_NAME_MISSING: MerchantTemplateData = {
  name: 'NoCoName',
  email: 'noconame@example.com',
  phone: '+243880000103',
  kyc_status: 'pending',
  mode: 'sandbox',
  status: 'active',
  company_name: null,        // ← only company_name missing
  company_rccm: 'CD/KIN/2024/888',
  company_idnat: 'ID-777888',
  kyc_notes: null,
  kyc_submitted_at: null,
  kyc_reviewed_at: null,
};

// Everything missing (fresh registration, never submitted KYC)
const MERCHANT_PENDING_ALL_MISSING: MerchantTemplateData = {
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

const MERCHANT_REJECTED: MerchantTemplateData = {
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

const MERCHANT_APPROVED_LIVE: MerchantTemplateData = {
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

const MERCHANT_APPROVED_SANDBOX: MerchantTemplateData = {
  ...MERCHANT_APPROVED_LIVE,
  mode: 'sandbox',
};

const MERCHANT_SUSPENDED: MerchantTemplateData = {
  ...MERCHANT_APPROVED_LIVE,
  status: 'suspended',
};

const WALLET_USER_LEVEL0: WalletUserTemplateData = {
  phone: '+243880000001',
  full_name: 'Jean Dupont',
  email: 'jean@example.com',
  kyc_level: 0,
  is_verified: false,
  is_active: true,
  kyc_submitted_at: null,
};

const WALLET_USER_LEVEL1: WalletUserTemplateData = {
  phone: '+243880000002',
  full_name: 'Marie Curie',
  email: 'marie@example.com',
  kyc_level: 1,
  is_verified: true,
  is_active: true,
  kyc_submitted_at: '2026-09-01T10:00:00Z',
};

const WALLET_USER_BLOCKED: WalletUserTemplateData = {
  ...WALLET_USER_LEVEL1,
  is_active: false,
};

/* ── Tests: merchant template generation ────────────────────── */

describe('buildEmailTemplates — merchant', () => {
  describe('A — Complément KYC ciblé', () => {
    it('lists RCCM and ID National when both missing (phone + company_name present)', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_PENDING_MISSING);
      const tpl = findTemplateByLabel(templates, 'Complément KYC ciblé');
      assert.ok(tpl, 'targeted template should exist');
      assert.ok(tpl.body.includes('RCCM'), 'mentions RCCM');
      assert.ok(tpl.body.includes('ID National'), 'mentions ID National');
      assert.ok(!tpl.body.includes('Raison sociale'), 'does not mention company_name (present)');
      assert.ok(!tpl.body.includes('téléphone'), 'does not mention phone (present)');
      assert.ok(tpl.body.includes('Lotika Forex'), 'uses merchant name');
    });

    it('lists only ID National when RCCM is present but ID Nat is missing', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_PENDING_RCCM_ONLY);
      const tpl = findTemplateByLabel(templates, 'Complément KYC ciblé');
      assert.ok(tpl, 'targeted template should exist');
      assert.ok(tpl.body.includes('ID National'), 'mentions ID National');
      assert.ok(!tpl.body.includes('RCCM (Registre de Commerce)'), 'does not mention RCCM as missing');
    });

    it('lists only phone when all doc fields are present but phone is missing', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_PENDING_PHONE_MISSING);
      const tpl = findTemplateByLabel(templates, 'Complément KYC ciblé');
      assert.ok(tpl, 'targeted template should exist');
      assert.ok(tpl.body.includes('téléphone'), 'mentions phone');
      assert.ok(!tpl.body.includes('RCCM (Registre de Commerce)'), 'does not mention RCCM (present)');
      assert.ok(!tpl.body.includes('ID National'), 'does not mention ID National (present)');
    });

    it('lists only raison sociale when company_name is missing', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_PENDING_NAME_MISSING);
      const tpl = findTemplateByLabel(templates, 'Complément KYC ciblé');
      assert.ok(tpl, 'targeted template should exist');
      assert.ok(tpl.body.includes('Raison sociale'), 'mentions company_name');
      assert.ok(!tpl.body.includes('RCCM (Registre de Commerce)'), 'does not mention RCCM (present)');
    });

    it('lists ALL four fields when everything is missing (fresh registration)', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_PENDING_ALL_MISSING);
      const tpl = findTemplateByLabel(templates, 'Complément KYC ciblé');
      assert.ok(tpl, 'targeted template should exist');
      assert.ok(tpl.body.includes('Raison sociale'), 'mentions company_name');
      assert.ok(tpl.body.includes('RCCM'), 'mentions RCCM');
      assert.ok(tpl.body.includes('ID National'), 'mentions ID National');
      assert.ok(tpl.body.includes('téléphone'), 'mentions phone');
    });

    it('falls back to generic "Relance KYC" when pending but no fields are missing', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_PENDING_COMPLETE);
      const targeted = findTemplateByLabel(templates, 'Complément KYC ciblé');
      const generic = findTemplateByLabel(templates, 'Relance KYC');
      assert.ok(!targeted, 'targeted template should NOT exist when all fields are complete');
      assert.ok(generic, 'generic relance should exist as fallback');
    });
  });

  describe('B — KYC rejeté', () => {
    it('includes kyc_notes in the body when available', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_REJECTED);
      const tpl = findTemplateByLabel(templates, 'KYC rejeté');
      assert.ok(tpl, 'rejected template should exist');
      assert.ok(tpl.body.includes('Document illisible'), 'includes kyc_notes content');
    });

    it('works without kyc_notes (graceful)', () => {
      const noNotes = { ...MERCHANT_REJECTED, kyc_notes: null };
      const templates = buildEmailTemplates('merchant', noNotes);
      const tpl = findTemplateByLabel(templates, 'KYC rejeté');
      assert.ok(tpl, 'rejected template should exist');
      assert.ok(!tpl.body.includes('Motif :'), 'does not show empty motif section');
    });
  });

  describe('C — KYC approuvé', () => {
    it('exists when kyc_status is approved', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'KYC approuvé');
      assert.ok(tpl, 'approved template should exist');
      assert.ok(tpl.body.includes('Approved Live'), 'uses merchant name');
    });
  });

  describe('Passage en mode live (existing)', () => {
    it('exists when approved + sandbox', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_SANDBOX);
      const tpl = findTemplateByLabel(templates, 'Passage en mode live');
      assert.ok(tpl, 'passage en mode live template should exist');
    });

    it('does NOT exist when approved + live', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Passage en mode live');
      assert.ok(!tpl, 'should not exist when already live');
    });
  });

  describe('D — Compte suspendu', () => {
    it('exists when status is suspended', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_SUSPENDED);
      const tpl = findTemplateByLabel(templates, 'Compte suspendu');
      assert.ok(tpl, 'suspended template should exist');
    });

    it('does NOT exist when status is active', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Compte suspendu');
      assert.ok(!tpl, 'should not exist when active');
    });
  });

  describe('E — Compte réactivé', () => {
    it('exists when status is active', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Compte réactivé');
      assert.ok(tpl, 'reactivated template should exist when active');
    });
  });

  describe('F — Régénération de clé API', () => {
    it('always exists (not conditional)', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Régénération de clé API');
      assert.ok(tpl, 'regeneration template should always exist');
    });

    it('uses api_key_label from extraVars when provided', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE, { api_key_label: 'production-key' });
      const tpl = findTemplateByLabel(templates, 'Régénération de clé API');
      assert.ok(tpl, 'template exists');
      assert.ok(tpl.body.includes('production-key'), 'uses custom api_key_label');
    });

    it('falls back to generic "votre clé API" when no label provided', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Régénération de clé API');
      assert.ok(tpl, 'template exists');
      assert.ok(tpl.body.includes('votre clé API'), 'uses generic label');
    });
  });

  describe('G — Révocation de clé API', () => {
    it('always exists (not conditional)', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Révocation de clé API');
      assert.ok(tpl, 'revocation template should always exist');
    });
  });

  describe('Generic template', () => {
    it('always exists with merchant name', () => {
      const templates = buildEmailTemplates('merchant', MERCHANT_APPROVED_LIVE);
      const tpl = findTemplateByLabel(templates, 'Réponse à votre demande');
      assert.ok(tpl, 'generic template always exists');
      assert.ok(tpl.body.includes('Approved Live'), 'uses merchant name');
      assert.equal(tpl.subject, '', 'generic has empty subject');
    });
  });
});

/* ── Tests: wallet user template generation ────────────────── */

describe('buildEmailTemplates — wallet_user', () => {
  describe('Relance KYC niveau 1', () => {
    it('exists when kyc_level === 0', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL0);
      const tpl = findTemplateByLabel(templates, 'Relance KYC niveau 1');
      assert.ok(tpl, 'should exist for level 0');
    });

    it('does NOT exist when kyc_level >= 1', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL1);
      const tpl = findTemplateByLabel(templates, 'Relance KYC niveau 1');
      assert.ok(!tpl, 'should not exist for level 1+');
    });
  });

  describe('Upgrade KYC niveau 2', () => {
    it('exists when kyc_level === 1', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL1);
      const tpl = findTemplateByLabel(templates, 'Upgrade KYC niveau 2');
      assert.ok(tpl, 'should exist for level 1');
    });
  });

  describe('KYC niveau 1 validé', () => {
    it('exists when kyc_level >= 1 and is_verified', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL1);
      const tpl = findTemplateByLabel(templates, 'KYC niveau 1 validé');
      assert.ok(tpl, 'should exist for verified level 1+');
    });

    it('does NOT exist when kyc_level === 0', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL0);
      const tpl = findTemplateByLabel(templates, 'KYC niveau 1 validé');
      assert.ok(!tpl, 'should not exist for level 0');
    });
  });

  describe('Compte suspendu', () => {
    it('exists when is_active is false', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_BLOCKED);
      const tpl = findTemplateByLabel(templates, 'Compte suspendu');
      assert.ok(tpl, 'should exist when blocked');
    });

    it('does NOT exist when is_active is true', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL1);
      const tpl = findTemplateByLabel(templates, 'Compte suspendu');
      assert.ok(!tpl, 'should not exist when active');
    });
  });

  describe('Compte réactivé', () => {
    it('exists when is_active is true', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL1);
      const tpl = findTemplateByLabel(templates, 'Compte réactivé');
      assert.ok(tpl, 'should exist when active');
    });
  });

  describe('Generic template', () => {
    it('always exists with user name', () => {
      const templates = buildEmailTemplates('wallet_user', WALLET_USER_LEVEL1);
      const tpl = findTemplateByLabel(templates, 'Réponse à votre demande');
      assert.ok(tpl, 'generic template always exists');
      assert.ok(tpl.body.includes('Marie Curie'), 'uses full_name');
    });

    it('falls back to phone when full_name is null', () => {
      const noName: WalletUserTemplateData = { ...WALLET_USER_LEVEL0, full_name: null };
      const templates = buildEmailTemplates('wallet_user', noName);
      const tpl = findTemplateByLabel(templates, 'Réponse à votre demande');
      assert.ok(tpl, 'generic template exists');
      assert.ok(tpl.body.includes('+243880000001'), 'uses phone as name');
    });
  });
});

/* ── Tests: auto-send behavior (static analysis) ────────────── */

describe('auto-send — static analysis of route files', () => {
  const MERCHANTS_ROUTE = path.resolve(__dirname, '../../routes/admin/merchants.ts');
  const WALLET_ROUTE = path.resolve(__dirname, '../../routes/admin/wallet.ts');
  const MERCHANTS_SRC = fs.readFileSync(MERCHANTS_ROUTE, 'utf-8');
  const WALLET_SRC = fs.readFileSync(WALLET_ROUTE, 'utf-8');

  describe('merchant actions with auto-send', () => {
    it('kyc/approve has auto-send for "KYC approuvé"', () => {
      assert.match(
        MERCHANTS_SRC,
        /kyc\/approve[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'KYC approuvé'/,
        'kyc/approve auto-sends "KYC approuvé" template',
      );
    });

    it('reactivate has auto-send for "Compte réactivé"', () => {
      assert.match(
        MERCHANTS_SRC,
        /reactivate[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'Compte réactivé'/,
        'reactivate auto-sends "Compte réactivé" template',
      );
    });

    it('api-keys/regenerate has auto-send for "Régénération de clé API"', () => {
      assert.match(
        MERCHANTS_SRC,
        /api-keys\/regenerate[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'Régénération de clé API'/,
        'regenerate auto-sends "Régénération de clé API" template',
      );
    });

    it('api-keys/revoke has auto-send for "Révocation de clé API"', () => {
      assert.match(
        MERCHANTS_SRC,
        /api-keys\/revoke[\s\S]*?sendTemplateAuto\('merchant'[\s\S]*?'Révocation de clé API'/,
        'revoke auto-sends "Révocation de clé API" template',
      );
    });
  });

  describe('merchant actions WITHOUT auto-send (manual only)', () => {
    it('suspend does NOT have sendTemplateAuto', () => {
      // Extract the suspend route body and verify no auto-send
      const suspendMatch = MERCHANTS_SRC.match(/'\/admin\/merchants\/:id\/suspend'[\s\S]*?\n  \);/);
      assert.ok(suspendMatch, 'suspend route found');
      assert.ok(
        !suspendMatch[0].includes('sendTemplateAuto'),
        'suspend must NOT auto-send (manual only — investigation context)',
      );
    });

    it('kyc/reject does NOT have sendTemplateAuto', () => {
      const rejectMatch = MERCHANTS_SRC.match(/'\/admin\/merchants\/:id\/kyc\/reject'[\s\S]*?\n  \);/);
      assert.ok(rejectMatch, 'kyc/reject route found');
      assert.ok(
        !rejectMatch[0].includes('sendTemplateAuto'),
        'kyc/reject must NOT auto-send (manual only — tone/context matters)',
      );
    });
  });

  describe('wallet user actions with auto-send', () => {
    it('unblock has auto-send for "Compte réactivé"', () => {
      assert.match(
        WALLET_SRC,
        /unblock[\s\S]*?sendTemplateAuto\('wallet_user'[\s\S]*?'Compte réactivé'/,
        'unblock auto-sends "Compte réactivé" template',
      );
    });

    it('kyc/approve (wallet users) has auto-send for "KYC niveau 1 validé"', () => {
      assert.match(
        WALLET_SRC,
        /wallet\/users\/:id\/kyc\/approve[\s\S]*?sendTemplateAuto\('wallet_user'[\s\S]*?'KYC niveau 1 validé'/,
        'wallet kyc/approve auto-sends "KYC niveau 1 validé" template',
      );
    });

    it('kyc submission approve has auto-send for "KYC niveau 1 validé"', () => {
      assert.match(
        WALLET_SRC,
        /wallet\/kyc\/:id\/approve[\s\S]*?sendTemplateAuto\('wallet_user'[\s\S]*?'KYC niveau 1 validé'/,
        'kyc submission approve auto-sends "KYC niveau 1 validé" template',
      );
    });
  });

  describe('wallet user actions WITHOUT auto-send', () => {
    it('block does NOT have sendTemplateAuto', () => {
      // Extract the block route body (not unblock) and verify no auto-send
      const blockMatch = WALLET_SRC.match(/'\/admin\/wallet\/users\/:id\/block'[\s\S]*?\n  \}\);/);
      assert.ok(blockMatch, 'block route found');
      assert.ok(
        !blockMatch[0].includes('sendTemplateAuto'),
        'block must NOT auto-send (manual only — same as merchant suspend)',
      );
    });
  });

  describe('non-blocking contract', () => {
    it('all auto-sends use void + .then (fire-and-forget)', () => {
      // Every sendTemplateAuto call should be preceded by void
      const allCalls = MERCHANTS_SRC.match(/void sendTemplateAuto/g) ?? [];
      const allCallsWallet = WALLET_SRC.match(/void sendTemplateAuto/g) ?? [];
      assert.ok(allCalls.length >= 4, `merchants.ts should have >=4 void sendTemplateAuto calls, found ${allCalls.length}`);
      assert.ok(allCallsWallet.length >= 3, `wallet.ts should have >=3 void sendTemplateAuto calls, found ${allCallsWallet.length}`);
    });

    it('auto-send logs success with [admin-auto-email] prefix', () => {
      assert.match(MERCHANTS_SRC, /\[admin-auto-email\].*sent/, 'logs success');
      assert.match(MERCHANTS_SRC, /\[admin-auto-email\].*NOT sent/, 'logs failure');
    });
  });
});

/* ── Tests: unified helper (deduplication) ─────────────────── */

describe('unified helper — deduplication', () => {
  it('merchants.ts imports from lib/email-templates (not inline)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../routes/admin/merchants.ts'),
      'utf-8',
    );
    assert.match(src, /from '..\/..\/lib\/email-templates/, 'imports unified helper');
    assert.match(src, /buildEmailTemplates\('merchant'/, 'uses buildEmailTemplates');
  });

  it('wallet.ts imports from lib/email-templates (not inline)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../routes/admin/wallet.ts'),
      'utf-8',
    );
    assert.match(src, /from '..\/..\/lib\/email-templates/, 'imports unified helper');
    assert.match(src, /buildEmailTemplates\('wallet_user'/, 'uses buildEmailTemplates');
  });

  it('merchants.ts no longer has inline template generation', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../routes/admin/merchants.ts'),
      'utf-8',
    );
    // The old inline pattern was: const name = m.name ?? m.email; followed by templates.push
    assert.ok(
      !src.match(/const name = m\.name \?\? m\.email/),
      'old inline name assignment removed',
    );
  });
});
