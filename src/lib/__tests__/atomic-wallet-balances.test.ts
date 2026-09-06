import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('atomic wallet balance guards', () => {
  const migration = source('supabase/migrations/20260906000000_atomic_wallet_balance_rpcs.sql');

  it('defines guarded USDT and CGLT debits that fail when no row is updated', () => {
    assert.match(migration, /FUNCTION public\.wallet_debit_usdt/);
    assert.match(migration, /usdt_balance >= p_amount[\s\S]*RETURNING usdt_balance INTO v_new_balance;[\s\S]*IF NOT FOUND THEN[\s\S]*INSUFFICIENT_USDT/);
    assert.match(migration, /FUNCTION public\.wallet_debit_cglt/);
    assert.match(migration, /cglt_balance >= p_amount[\s\S]*RETURNING cglt_balance INTO v_new_balance;[\s\S]*IF NOT FOUND THEN[\s\S]*INSUFFICIENT_CGLT/);
  });

  it('does not expose balance mutation RPCs to public roles', () => {
    for (const fn of ['wallet_debit_usdt', 'wallet_debit_cglt', 'wallet_credit_cglt', 'wallet_credit_cdf', 'wallet_adjust_cdf']) {
      assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(UUID, NUMERIC\\) FROM PUBLIC`));
    }
  });

  it('debits USDT through the guarded RPC before any on-chain send', () => {
    const route = source('src/routes/wallet/crypto-withdraw.ts');
    // crypto-withdraw uses begin_usdt_onchain_withdrawal, which atomically debits
    // USDT (with INSUFFICIENT_USDT guard) and creates the withdrawal record.
    const debit = route.indexOf("'begin_usdt_onchain_withdrawal'");
    const send = route.indexOf('await sendUsdt');
    assert.ok(debit >= 0);
    assert.ok(send > debit);
    assert.doesNotMatch(route, /\.gte\('usdt_balance', amount\)/);
  });

  it('uses atomic balance RPCs for admin adjustments and CGLT bridge or gaming paths', () => {
    const admin = source('src/routes/admin/wallet.ts');
    const gaming = source('src/routes/wallet/cglt-gaming.ts');
    const bridge = source('src/routes/wallet/wcglt-swap.ts');
    const incoming = source('src/routes/wallet/internal.ts');

    assert.match(admin, /\.rpc\('wallet_adjust_cdf'/);
    assert.match(gaming, /\.rpc\('wallet_debit_cglt'/);
    assert.match(gaming, /\.rpc\('wallet_credit_cglt'/);
    // wcglt-swap uses begin_wcglt_onchain_operation, which atomically debits
    // CGLT (with INSUFFICIENT_CGLT guard) and creates the operation state.
    assert.match(bridge, /\.rpc\(\s*'begin_wcglt_onchain_operation'/);
    // internal.ts uses process_bridge_incoming_credit, which atomically credits
    // CGLT and enforces tx_hash idempotency in one call.
    assert.match(incoming, /\.rpc\(\s*'process_bridge_incoming_credit'/);

    for (const route of [admin, gaming, bridge, incoming]) {
      assert.doesNotMatch(route, /update\(\{\s*(?:balance_cdf|cglt_balance|usdt_balance):/);
    }
  });
});
