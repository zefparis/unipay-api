/**
 * Retroactive diagnostic script: find merchant_settlement_requests
 * marked 'success' in the DB but actually 'failed' at the provider.
 *
 * This is the systemic bug: settlements were marked 'success'
 * immediately after initiatePayout() returned, before the operator
 * callback arrived. If the operator later rejected the payout
 * (e.g. MSISDN2 INCORRECT), the settlement remained falsely 'success'
 * because no transactions row linked the callback to the settlement.
 *
 * Usage:
 *   npx tsx scripts/check-false-success-settlements.ts
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (loaded via src/config/env).
 * Optional: UNIPESA_PUBLIC_ID, UNIPESA_MERCHANT_ID, UNIPESA_SECRET_KEY for
 *           Unipesa /status lookup.
 *
 * This script is READ-ONLY — it does not modify any data. After review,
 * run the fix migration and use the admin endpoints to manually resolve
 * affected settlements.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';
import { getTransactionStatus } from '../src/services/avada';

interface SettlementRow {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  phone: string;
  provider_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  merchants: { name: string | null; email: string | null }[] | null;
}

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ── 1. List all settlements marked 'success' with a provider_ref ──
  // Only settlements with a provider_ref can be checked against Unipesa.
  // Settlements without a provider_ref predate the payout flow or were
  // created by a path that did not store the provider reference.
  const { data: settlements, error } = await supabase
    .from('merchant_settlement_requests')
    .select(
      'id, merchant_id, amount, currency, phone, provider_ref, status, created_at, updated_at, merchants(name, email)',
    )
    .eq('status', 'success')
    .not('provider_ref', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Query failed:', error);
    process.exit(1);
  }

  const rows = (settlements as SettlementRow[] | null) ?? [];
  console.log('=== Settlements marked success (with provider_ref) ===');
  console.log(`Count: ${rows.length}`);

  if (rows.length === 0) {
    console.log('No settlements to check.');
    return;
  }

  // ── 2. For each settlement, query Unipesa /status ──────────────
  // Compare DB status ('success') with provider status.
  // Flag mismatches where the provider says 'failed'.
  const mismatches: Array<{
    settlementId: string;
    merchantId: string;
    merchantName: string | null;
    amount: number;
    currency: string;
    phone: string;
    providerRef: string;
    dbStatus: string;
    providerStatus: string;
    createdAt: string;
    linkedTxStatus: string | null;
  }> = [];

  const unreachable: Array<{ settlementId: string; providerRef: string; err: string }> = [];

  for (const s of rows) {
    const providerRef = s.provider_ref!;
    let providerStatus: string;
    try {
      providerStatus = await getTransactionStatus(providerRef);
    } catch (err) {
      unreachable.push({
        settlementId: s.id,
        providerRef,
        err: (err as Error)?.message ?? 'unknown',
      });
      continue;
    }

    if (providerStatus === 'failed' || providerStatus === 'cancelled') {
      // Also check the linked transactions row (if any) for corroboration.
      let linkedTxStatus: string | null = null;
      const { data: linkedTx } = await supabase
        .from('transactions')
        .select('status')
        .eq('settlement_request_id', s.id)
        .maybeSingle();
      if (linkedTx) {
        linkedTxStatus = (linkedTx as { status: string }).status;
      }

      mismatches.push({
        settlementId: s.id,
        merchantId: s.merchant_id,
        merchantName: s.merchants?.[0]?.name ?? null,
        amount: Number(s.amount),
        currency: s.currency,
        phone: s.phone,
        providerRef,
        dbStatus: s.status,
        providerStatus,
        createdAt: s.created_at,
        linkedTxStatus,
      });
    }
  }

  // ── 3. Report ──────────────────────────────────────────────────
  console.log('\n=== FALSE-SUCCESS SETTLEMENTS (DB=success, provider=failed) ===');
  console.log(`Count: ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.table(
      mismatches.map((m) => ({
        settlement_id: m.settlementId.slice(0, 8),
        merchant: m.merchantName ?? m.merchantId.slice(0, 8),
        amount: m.amount,
        currency: m.currency,
        phone: m.phone,
        provider_ref: m.providerRef.slice(0, 20),
        db_status: m.dbStatus,
        provider_status: m.providerStatus,
        linked_tx_status: m.linkedTxStatus ?? 'none',
        created_at: m.createdAt,
      })),
    );

    // Aggregate by merchant for manual resolution.
    const byMerchant = new Map<string, { name: string | null; count: number; totalAmount: number; currency: string }>();
    for (const m of mismatches) {
      const key = m.merchantId;
      const existing = byMerchant.get(key);
      if (existing) {
        existing.count += 1;
        existing.totalAmount += m.amount;
      } else {
        byMerchant.set(key, {
          name: m.merchantName,
          count: 1,
          totalAmount: m.amount,
          currency: m.currency,
        });
      }
    }

    console.log('\n=== Affected merchants (aggregate) ===');
    console.table(
      Array.from(byMerchant.entries()).map(([merchantId, v]) => ({
        merchant_id: merchantId.slice(0, 8),
        merchant_name: v.name ?? '(unknown)',
        affected_settlements: v.count,
        total_amount: v.totalAmount,
        currency: v.currency,
      })),
    );

    console.log('\n=== Resolution guidance ===');
    console.log('These settlements were marked success but the provider rejected the payout.');
    console.log('For each affected settlement, the merchant was debited but never received the funds.');
    console.log('To resolve:');
    console.log('  1. Verify the provider status manually if in doubt.');
    console.log('  2. Call mark_settlement_failed(request_id, reason) to re-credit the merchant.');
    console.log('     This will insert a compensating ledger credit in the settlement currency.');
    console.log('  3. Notify the merchant that the payout failed and their balance has been restored.');
    console.log('  4. After deploying the settlement-callback-fix migration, new settlements will');
    console.log('     no longer be marked success prematurely — they will stay processing until');
    console.log('     the operator callback confirms success or failure.');
  }

  if (unreachable.length > 0) {
    console.log('\n=== Settlements where Unipesa /status could not be queried ===');
    console.log(`Count: ${unreachable.length}`);
    console.table(
      unreachable.map((u) => ({
        settlement_id: u.settlementId.slice(0, 8),
        provider_ref: u.providerRef.slice(0, 20),
        error: u.err.slice(0, 60),
      })),
    );
    console.log('These could not be verified — check manually or retry later.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
