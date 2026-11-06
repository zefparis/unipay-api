import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REGISTER = readFileSync('src/routes/merchant/register.ts', 'utf8');
const CALLBACK = readFileSync('src/routes/payment/callback.ts', 'utf8');
const REMINDERS = readFileSync('scripts/kyc-reminders.ts', 'utf8');
const CAMPAIGN = readFileSync('scripts/kyc-campaign.ts', 'utf8');

describe('register — rattachement partenaire via ?ref', () => {
  it('accepte le champ ref dans le body et le schéma', () => {
    assert.match(REGISTER, /ref\?: string/);
    assert.match(REGISTER, /ref:\s*\{ type: 'string'/);
  });

  it('résout ref → partner_code + is_partner + actif', () => {
    assert.match(REGISTER, /eq\('partner_code', ref\)/);
    assert.match(REGISTER, /eq\('is_partner', true\)/);
    assert.match(REGISTER, /eq\('status', 'active'\)/);
  });

  it('écrit referred_by_partner_id à l\u2019insert, jamais bloquant', () => {
    assert.match(REGISTER, /referred_by_partner_id:\s*referredByPartnerId/);
    assert.match(REGISTER, /referredByPartnerId = \(partner\?\.id as string\) \?\? null/);
    assert.match(REGISTER, /Invalid or inactive partner ref code/);
    // le lookup partenaire précède l'insert → ref inconnu = rattachement null, pas de blocage
    assert.ok(REGISTER.indexOf('eq(\'partner_code\'') < REGISTER.indexOf('referred_by_partner_id:'));
  });
});

describe('paiement filleul → commission partenaire', () => {
  it('la confirmation passe par process_wallet_provider_callback (RPC qui appelle credit_partner_commission en base)', () => {
    assert.match(CALLBACK, /rpc\(\s*'process_wallet_provider_callback'/);
  });
});

describe('email_unreachable — les scripts lisent la colonne', () => {
  it('kyc-reminders filtre sur merchants.email_unreachable', () => {
    assert.match(REMINDERS, /\.eq\('email_unreachable', true\)/);
    assert.match(REMINDERS, /unreachableSet[\s\S]{0,400}\.from\('merchants'\)/);
  });
  it('kyc-campaign exclut les email_unreachable', () => {
    assert.match(CAMPAIGN, /m\.email_unreachable === true/);
  });
});
