import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// env.ts exits the process when required vars are missing — stub
// them before importing partner-commission (which imports env).
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { logPartnerCommissionResult } = require('../partner-commission') as typeof import('../partner-commission');

/**
 * Partner program — static-analysis + unit tests.
 *
 * Covers the business rules that are checkable without a live DB:
 *   - one commission per transaction (UNIQUE + ON CONFLICT)
 *   - reversal is a counter-entry, never a delete
 *   - no commission on failed/pending (eligibility guards)
 *   - commission is capped by the real UniPay margin
 *   - a commission error can never abort the tx success transition
 *   - self-referral forbidden (DB CHECK + route guard)
 *   - invalid ref code does not block registration
 *   - uniform { error, statusCode } envelope hook
 */

const MIGRATION = path.resolve(__dirname, '../../../supabase/migrations/20261027000000_partner_program.sql');
const SQL = fs.readFileSync(MIGRATION, 'utf-8');

const SRC = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
const CALLBACK = SRC('routes/payment/callback.ts');
const RECONCILE = SRC('services/unipesa-reconciliation.ts');
const REGISTER = SRC('routes/merchant/register.ts');
const MERCHANT_AUTH = SRC('lib/merchant-auth.ts');
const SERVER = SRC('server.ts');
const ADMIN_PARTNER = SRC('routes/admin/partner.ts');
const MERCHANT_PARTNER = SRC('routes/merchant/partner.ts');

describe('migration: merchants partner columns', () => {
  it('adds is_partner, partner_code, partner_rate, referred_by_partner_id', () => {
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS is_partner boolean NOT NULL DEFAULT false/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS partner_code text/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS partner_rate numeric\(6,4\) NOT NULL DEFAULT 0\.01/);
    assert.match(SQL, /referred_by_partner_id uuid\s+REFERENCES public\.merchants\(id\)/);
  });

  it('partner_code is UNIQUE', () => {
    assert.match(SQL, /CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_partner_code/);
  });

  it('forbids self-referral at DB level', () => {
    assert.match(SQL, /merchants_no_self_referral/);
    assert.match(SQL, /referred_by_partner_id <> id/);
  });
});

describe('migration: partner_commissions table', () => {
  it('enforces exactly one commission per transaction (UNIQUE)', () => {
    assert.match(SQL, /CONSTRAINT partner_commissions_transaction_unique UNIQUE \(transaction_id\)/);
  });

  it('status is credited|reversed — no delete semantics', () => {
    assert.match(SQL, /CHECK \(status IN \('credited', 'reversed'\)\)/);
    assert.match(SQL, /reversed_at\s+timestamptz/);
    assert.ok(!/DROP TABLE.*partner_commissions/i.test(SQL));
  });

  it('stores reversal linkage + reason', () => {
    assert.match(SQL, /reversal_ledger_entry_id uuid/);
    assert.match(SQL, /reverse_reason\s+text/);
  });

  it('enables RLS with service_role-only policy', () => {
    assert.match(SQL, /ALTER TABLE public\.partner_commissions ENABLE ROW LEVEL SECURITY/);
    assert.match(SQL, /FOR ALL TO service_role/);
  });
});

describe('credit_partner_commission — business rules', () => {
  it('only commissions successful fee-bearing merchant transactions', () => {
    assert.match(SQL, /v_tx\.status <> 'success'/);
    assert.match(SQL, /v_tx\.wallet_user_id IS NOT NULL/);
    assert.match(SQL, /v_tx\.settlement_request_id IS NOT NULL/);
    assert.match(SQL, /v_tx\.fee IS NULL OR v_tx\.fee <= 0/);
    assert.match(SQL, /v_tx\.merchant_id IS NULL/);
  });

  it('refuses to compute when provider fee rate is NULL (fail loud)', () => {
    assert.match(SQL, /IF p_provider_fee_rate IS NULL THEN\s*RETURN jsonb_build_object\('status', 'error', 'message', 'provider_fee_rate missing'\)/);
  });

  it('caps commission by the real UniPay margin (no charge on top)', () => {
    assert.match(SQL, /LEAST\(\s*v_partner\.partner_rate \* v_tx\.amount,\s*v_tx\.fee - v_tx\.amount \* p_provider_fee_rate\s*\)/);
  });

  it('returns no_margin when cap <= 0', () => {
    assert.match(SQL, /v_commission IS NULL OR v_commission <= 0/);
    assert.match(SQL, /'status', 'no_margin'/);
  });

  it('is idempotent via ON CONFLICT DO NOTHING', () => {
    assert.match(SQL, /ON CONFLICT \(transaction_id\) DO NOTHING/);
    assert.match(SQL, /'status', 'skipped_duplicate'/);
  });

  it('credits the partner settlement ledger in the same function', () => {
    assert.match(SQL, /INSERT INTO public\.merchant_ledger_entries \(\s*merchant_id, transaction_id, type, amount, balance_after, currency\s*\) VALUES \(\s*v_partner\.id, v_tx\.id, 'credit', v_commission/);
  });

  it('uses the tx currency (no conversion)', () => {
    assert.match(SQL, /currency = upper\(v_tx\.currency\)/);
    assert.match(SQL, /upper\(v_tx\.currency\), v_tx\.amount, v_partner\.partner_rate, v_commission/);
  });
});

describe('process_wallet_provider_callback — isolation', () => {
  it('keeps the 20260929000000 logic (wallet_withdraw_fail_and_refund delegation intact)', () => {
    const fnBody = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.process_wallet_provider_callback'));
    assert.match(fnBody, /wallet_withdraw_fail_and_refund/);
    assert.match(fnBody, /Settlement propagation/);
    assert.match(fnBody, /merchant_metadata/);
  });

  it('accepts p_provider_fee_rate param (NULL default → commission error, never silent)', () => {
    assert.match(SQL, /p_provider_fee_rate NUMERIC DEFAULT NULL/);
    // credit_partner_commission surfaces the missing rate as 'error'
    assert.match(SQL, /'provider_fee_rate missing'/);
  });

  it('wraps commission in an EXCEPTION-isolated sub-block (never aborts success)', () => {
    assert.match(SQL, /v_partner_commission := public\.credit_partner_commission\(/);
    assert.match(SQL, /EXCEPTION WHEN OTHERS THEN\s*v_partner_commission := jsonb_build_object\(\s*'status', 'error'/);
  });

  it('only runs commission on success transition', () => {
    assert.match(SQL, /IF p_new_status = 'success' THEN\s*BEGIN\s*v_partner_commission/);
  });

  it('returns partner_commission in the result payload', () => {
    assert.match(SQL, /'partner_commission', v_partner_commission/);
  });
});

describe('reverse_partner_commission', () => {
  it('marks reversed + writes a NEGATIVE credit ledger entry (no delete)', () => {
    assert.match(SQL, /SET status = 'reversed'/);
    assert.match(SQL, /-v_comm\.commission_amount, v_balance, v_comm\.currency/);
    assert.ok(!/DELETE FROM public\.partner_commissions/i.test(SQL));
  });

  it('is idempotent (already_reversed short-circuit)', () => {
    assert.match(SQL, /IF v_comm\.status = 'reversed' THEN/);
    assert.match(SQL, /'status', 'already_reversed'/);
  });
});

describe('backfill_partner_commissions', () => {
  it('exists and is idempotent through credit_partner_commission', () => {
    assert.match(SQL, /CREATE OR REPLACE FUNCTION public\.backfill_partner_commissions/);
    assert.match(SQL, /v_result := public\.credit_partner_commission\(v_tx_id, p_provider_fee_rate\)/);
  });

  it('contains per-row errors (savepoint) and reports counts', () => {
    assert.match(SQL, /EXCEPTION WHEN OTHERS THEN\s*v_errors := v_errors \+ 1/);
    assert.match(SQL, /'skipped_duplicate', v_skipped/);
  });

  it('refuses the whole batch when provider fee rate is NULL', () => {
    const backfillBody = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.backfill_partner_commissions'));
    assert.match(backfillBody, /p_provider_fee_rate NUMERIC DEFAULT NULL/);
    assert.match(backfillBody, /IF p_provider_fee_rate IS NULL THEN\s*RETURN jsonb_build_object\('status', 'error', 'message', 'provider_fee_rate missing'\)/);
  });
});

describe('RPC callers pass provider fee rate + emit events', () => {
  it('callback.ts passes p_provider_fee_rate and logs result', () => {
    assert.match(CALLBACK, /p_provider_fee_rate: PROVIDER_FEE_RATE/);
    assert.match(CALLBACK, /logPartnerCommissionResult\(fastify\.log/);
  });

  it('reconciliation passes p_provider_fee_rate on both RPC calls', () => {
    const occurrences = (RECONCILE.match(/p_provider_fee_rate: PROVIDER_FEE_RATE/g) ?? []).length;
    assert.ok(occurrences >= 2, `expected >=2 call sites, got ${occurrences}`);
    assert.match(RECONCILE, /logPartnerCommissionResult\(log/);
  });
});

describe('logPartnerCommissionResult — event mapping', () => {
  const fakeLog = () => {
    const calls: { level: string; data: Record<string, unknown> }[] = [];
    return {
      calls,
      info: (d: unknown) => calls.push({ level: 'info', data: d as Record<string, unknown> }),
      warn: (d: unknown) => calls.push({ level: 'warn', data: d as Record<string, unknown> }),
      error: (d: unknown) => calls.push({ level: 'error', data: d as Record<string, unknown> }),
    };
  };

  it('emits partner_commission_credited on credited', () => {
    const log = fakeLog();
    logPartnerCommissionResult(log, { status: 'credited', amount: 10, currency: 'CDF' });
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].level, 'info');
    assert.equal(log.calls[0].data.event, 'partner_commission_credited');
  });

  it('emits partner_commission_skipped_duplicate on duplicate', () => {
    const log = fakeLog();
    logPartnerCommissionResult(log, { status: 'skipped_duplicate' });
    assert.equal(log.calls[0].data.event, 'partner_commission_skipped_duplicate');
  });

  it('emits partner_commission_skipped_no_margin (warn)', () => {
    const log = fakeLog();
    logPartnerCommissionResult(log, { status: 'no_margin' });
    assert.equal(log.calls[0].level, 'warn');
    assert.equal(log.calls[0].data.event, 'partner_commission_skipped_no_margin');
  });

  it('emits partner_commission_error (error level) on DB-side error', () => {
    const log = fakeLog();
    logPartnerCommissionResult(log, { status: 'error', message: 'boom' });
    assert.equal(log.calls[0].level, 'error');
    assert.equal(log.calls[0].data.event, 'partner_commission_error');
  });

  it('emits nothing on none / undefined', () => {
    const log = fakeLog();
    logPartnerCommissionResult(log, { status: 'none' });
    logPartnerCommissionResult(log, undefined);
    assert.equal(log.calls.length, 0);
  });
});

describe('merchant register — ref code', () => {
  it('accepts optional ref in schema + body', () => {
    assert.match(REGISTER, /ref:\s*\{ type: 'string', maxLength: 64 \}/);
    assert.match(REGISTER, /ref\?: string/);
  });

  it('looks up ACTIVE partners only', () => {
    assert.match(REGISTER, /\.eq\('partner_code', ref\)/);
    assert.match(REGISTER, /\.eq\('is_partner', true\)/);
    assert.match(REGISTER, /\.eq\('status', 'active'\)/);
  });

  it('does not block registration on invalid ref (warn only)', () => {
    assert.match(REGISTER, /Invalid or inactive partner ref code/);
    assert.match(REGISTER, /referred_by_partner_id: referredByPartnerId/);
  });
});

describe('dual auth — requireMerchantIdentity', () => {
  it('tries JWT then falls back to X-API-Key', () => {
    assert.match(MERCHANT_AUTH, /export async function requireMerchantIdentity/);
    assert.match(MERCHANT_AUTH, /requireActiveMerchant\(request, supabase\)/);
    assert.match(MERCHANT_AUTH, /request\.headers\['x-api-key'\]/);
    assert.match(MERCHANT_AUTH, /bcrypt\.compare\(apiKey/);
  });
});

describe('routes — guards and registration', () => {
  it('merchant partner routes use requireMerchantIdentity', () => {
    const occurrences = (MERCHANT_PARTNER.match(/requireMerchantIdentity\(request, fastify\.supabase\)/g) ?? []).length;
    assert.ok(occurrences >= 3, `expected 3 guarded routes, got ${occurrences}`);
    assert.match(MERCHANT_PARTNER, /'\/merchant\/partner'/);
    assert.match(MERCHANT_PARTNER, /'\/merchant\/partner\/clients'/);
    assert.match(MERCHANT_PARTNER, /'\/merchant\/partner\/commissions'/);
  });

  it('admin partner routes all require isAdmin', () => {
    const occurrences = (ADMIN_PARTNER.match(/!request\.isAdmin/g) ?? []).length;
    assert.ok(occurrences >= 5, `expected >=5 admin guards, got ${occurrences}`);
  });

  it('admin referrer change is audit-logged and self-referral refused', () => {
    assert.match(ADMIN_PARTNER, /SELF_REFERRAL_FORBIDDEN/);
    assert.match(ADMIN_PARTNER, /'merchant\.referrer_update'/);
    assert.match(ADMIN_PARTNER, /logAdminAction/);
  });

  it('admin endpoints exist: partner toggle, reverse, backfill, list', () => {
    assert.match(ADMIN_PARTNER, /'\/admin\/merchants\/:id\/partner'/);
    assert.match(ADMIN_PARTNER, /'\/admin\/merchants\/:id\/referrer'/);
    assert.match(ADMIN_PARTNER, /'\/admin\/partner-commissions'/);
    assert.match(ADMIN_PARTNER, /'\/admin\/partner-commissions\/:id\/reverse'/);
    assert.match(ADMIN_PARTNER, /'\/admin\/partner-commissions\/backfill'/);
  });

  it('routes are registered in server.ts', () => {
    assert.match(SERVER, /v1\.register\(merchantPartnerRoute\)/);
    assert.match(SERVER, /v1\.register\(adminPartnerRoute\)/);
  });
});

describe('uniform error envelope — preSerialization hook', () => {
  it('injects statusCode on >=400 error payloads only', () => {
    assert.match(SERVER, /addHook\('preSerialization'/);
    assert.match(SERVER, /reply\.statusCode >= 400/);
    assert.match(SERVER, /typeof p\.error === 'string' && p\.statusCode === undefined/);
    assert.match(SERVER, /p\.statusCode = reply\.statusCode/);
  });
});

describe('grants — new SECURITY DEFINER functions locked down', () => {
  it('REVOKE from anon/authenticated + GRANT service_role', () => {
    for (const fn of [
      'credit_partner_commission\\(UUID, NUMERIC\\)',
      'reverse_partner_commission\\(UUID, TEXT\\)',
      'backfill_partner_commissions\\(TIMESTAMPTZ, TIMESTAMPTZ, NUMERIC\\)',
      'process_wallet_provider_callback\\(TEXT, TEXT, UUID, TEXT, TEXT, JSONB, NUMERIC\\)',
    ]) {
      assert.match(SQL, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC, anon, authenticated`));
      assert.match(SQL, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO service_role`));
    }
  });
});
