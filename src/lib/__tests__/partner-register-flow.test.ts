import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REGISTER = readFileSync('src/routes/merchant/register.ts', 'utf8');
const CALLBACK = readFileSync('src/routes/payment/callback.ts', 'utf8');
const REMINDERS = readFileSync('scripts/kyc-reminders.ts', 'utf8');
const CAMPAIGN = readFileSync('scripts/kyc-campaign.ts', 'utf8');
const BACKFILL_MIGRATION = readFileSync('supabase/migrations/20261106110000_backfill_merchant_filter.sql', 'utf8');
const ADMIN_PARTNER = readFileSync('src/routes/admin/partner.ts', 'utf8');

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

describe('backfill partner commissions — filtre par marchand', () => {
  it('la migration ajoute p_merchant_id optionnel et filtre t.merchant_id', () => {
    assert.match(BACKFILL_MIGRATION, /p_merchant_id UUID DEFAULT NULL/);
    assert.match(BACKFILL_MIGRATION, /p_merchant_id IS NULL OR t\.merchant_id = p_merchant_id/);
    // sécurité inchangée : grants sur la nouvelle signature
    assert.match(BACKFILL_MIGRATION, /REVOKE ALL ON FUNCTION public\.backfill_partner_commissions\(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC, UUID\)/);
    assert.match(BACKFILL_MIGRATION, /GRANT EXECUTE ON FUNCTION public\.backfill_partner_commissions\(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC, UUID\) TO service_role/);
  });
  it('la route admin accepte merchant_id et le passe à la RPC (conditionnel)', () => {
    assert.match(ADMIN_PARTNER, /merchant_id\?: string/);
    assert.match(ADMIN_PARTNER, /merchant_id: \{ type: 'string', format: 'uuid' \}/);
    assert.match(ADMIN_PARTNER, /\.\.\.\(merchantId \? \{ p_merchant_id: merchantId \} : \{\}\)/);
  });
  it('journalise merchant_id dans l\u2019action admin', () => {
    assert.match(ADMIN_PARTNER, /merchant_id: merchantId \?\? null/);
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
