import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Scénario diff 4 : le callback a répondu 503 (defer) et laissé la tx
 * en pending. On vérifie que unipesa-reconciliation la reprend et la
 * crédite via process_wallet_provider_callback(p_new_status='success')
 * dès que le provider confirme.
 */
describe('réconciliation — crédite une tx laissée pending par le callback (defer)', () => {
  process.env.SUPABASE_URL ??= 'http://localhost';
  process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
  process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';

  const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

  const pendingTx = {
    id: 'tx-defer-1',
    reference: 'WD-DEFER01',
    merchant_id: null,
    wallet_user_id: 'wu-1',
    operator: 'orange',
    direction: 'collect',
    amount: 1000,
    fee: 50,
    net_amount: 950,
    currency: 'CDF',
    status: 'pending',
    avada_transaction_id: 'MP261106.1200.X00001',
    created_at: new Date(Date.now() - 120_000).toISOString(),
  };

  function mockSupabase() {
    const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        if (fn === 'process_wallet_provider_callback') return { data: { processed: true, credited: 950 }, error: null };
        return { data: { ok: true }, error: null };
      },
    };
    return { supabase, rpcCalls };
  }

  it('provider success → process_wallet_provider_callback appelé avec p_new_status=success', async () => {
    const { reconcileOne } = await import('../../services/unipesa-reconciliation');
    const { supabase, rpcCalls } = mockSupabase();
    await reconcileOne(
      supabase as never,
      pendingTx,
      silentLog,
      async () => ({ status: 'success', raw: { status: 2, result: { code: 0, message: 'OK' } } }),
    );
    const credit = rpcCalls.find((c) => c.fn === 'process_wallet_provider_callback');
    assert.ok(credit, 'la réconciliation doit appeler la RPC de crédit');
    assert.equal(credit!.params.p_transaction_id, 'tx-defer-1');
    assert.equal(credit!.params.p_new_status, 'success');
    assert.equal(credit!.params.p_provider, 'unipesa');
  });

  it('provider encore pending → aucune RPC, la tx reste pending pour le prochain tick', async () => {
    const { reconcileOne } = await import('../../services/unipesa-reconciliation');
    const { supabase, rpcCalls } = mockSupabase();
    await reconcileOne(
      supabase as never,
      pendingTx,
      silentLog,
      async () => ({ status: 'pending', raw: { status: 0 } }),
    );
    assert.equal(rpcCalls.filter((c) => c.fn === 'process_wallet_provider_callback').length, 0);
  });

  it('cadence : MIN_AGE 90 s / tick 60 s → reprise entre 90 s et ~150 s après création', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/services/unipesa-reconciliation.ts', 'utf8'));
    assert.match(src, /const MIN_AGE_SECONDS = 90;/);
    assert.match(src, /intervalMs = 60_000/);
    assert.match(src, /claim_pending_unipay_transactions/);
  });
});
