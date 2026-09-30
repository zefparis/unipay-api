/**
 * Reconciliation worker × real PostgreSQL (disposable) × simulated Unipesa.
 *
 * Requires TEST_DATABASE_URL pointing at a DISPOSABLE PostgreSQL 16 with:
 *   supabase/tests/fixtures/minimal_schema.sql
 *   supabase/migrations/20260916120000_fix_callback_regressions.sql
 *   supabase/migrations/20260914000000_unipesa_reconciliation.sql
 *   supabase/migrations/20260929000000_wallet_withdraw_idempotency.sql
 *   supabase/migrations/20260930000000_reconcile_pending_wallet_payouts.sql
 * Skipped entirely when TEST_DATABASE_URL is unset (never touches Supabase).
 *
 * The SupabaseClient surface used by the worker (rpc / from.select.eq.lt.limit)
 * is emulated over psql so no DB driver dependency is added.
 *
 * Proves, for a wallet payout claimed 'pending' (debited amount+fee):
 *   (a) /status 2 → success, balance unchanged
 *   (b) /status 3 → refund amount+fee ONCE; second tick no-op
 *   (c) /status 0|1 → nothing changes
 *   (d) /status -1, age 10 min → NO refund (grace)
 *   (e) /status -1, age 16 min → refund ONCE
 *   (f) pending aged 60 s → never claimed
 *   (g) two concurrent claim calls never return the same row (SKIP LOCKED)
 */
import { describe, it, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import Module from 'node:module';

const DB = process.env.TEST_DATABASE_URL;
const PSQL = process.env.PSQL_BIN ?? 'psql';

process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';

// ── psql helpers ───────────────────────────────────────────────
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
function run(sqlText: string): void {
  execFileSync(PSQL, [DB!, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sqlText], { stdio: ['ignore', 'pipe', 'pipe'] });
}
function rows<T = Record<string, unknown>>(query: string): T[] {
  const out = execFileSync(PSQL, [DB!, '-v', 'ON_ERROR_STOP=1', '-tA', '-c',
    `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query}) t`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  return JSON.parse(out || '[]') as T[];
}
function one<T = unknown>(query: string): T {
  return rows<Record<string, T>>(`${query}`)[0]?.v as T;
}

// ── Minimal SupabaseClient emulation over psql ─────────────────
const SETOF_RPCS = new Set(['claim_pending_unipay_transactions', 'claim_pending_settlements']);
function fakeSupabase() {
  return {
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const argList = Object.entries(args).map(([k, v]) => `${k} := ${lit(v)}`).join(', ');
      try {
        if (name === 'claim_pending_settlements') return { data: [], error: null }; // not part of this schema
        if (SETOF_RPCS.has(name)) return { data: rows(`SELECT * FROM public.${name}(${argList})`), error: null };
        return { data: one(`SELECT public.${name}(${argList}) AS v`), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from: (table: string) => {
      const where: string[] = []; let cols = '*'; let limit = '';
      const q = {
        select: (c: string) => { cols = c; return q; },
        eq: (c: string, v: unknown) => { where.push(`${c} = ${lit(v)}`); return q; },
        lt: (c: string, v: unknown) => { where.push(`${c} < ${lit(v)}`); return q; },
        limit: (n: number) => { limit = ` LIMIT ${n}`; return q; },
        maybeSingle: async () => ({ data: q.exec()[0] ?? null, error: null }),
        exec: () => rows(`SELECT ${cols} FROM public.${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}${limit}`),
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
          try { res({ data: q.exec(), error: null }); } catch (e) { rej(e); }
        },
      };
      return q;
    },
  };
}

// ── Simulated Unipesa /status ──────────────────────────────────
type StatusCode = -1 | 0 | 1 | 2 | 3;
const STATUS_TEXT: Record<StatusCode, string> = { [-1]: 'failed', 0: 'pending', 1: 'processing', 2: 'success', 3: 'failed' };
let unipesaStatus: StatusCode = 0;
const statusCalls: string[] = [];

function stubModule(rel: string, exports: Record<string, unknown>): void {
  const filename = require.resolve(rel);
  const m = new Module(filename); m.filename = filename; m.loaded = true; m.exports = exports;
  require.cache[filename] = m;
}
stubModule('../../services/avada', {
  getTransactionStatusWithRaw: async (orderId: string) => {
    statusCalls.push(orderId);
    return { status: STATUS_TEXT[unipesaStatus], raw: { status: unipesaStatus, order_id: orderId } };
  },
});
stubModule('../merchant-webhook', { notifyMerchantWebhook: async () => undefined });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { env } = require('../../config/env') as typeof import('../../config/env');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runReconciliationTick, RECONCILE_NOT_FOUND_GRACE_SECONDS } = require('../../services/unipesa-reconciliation') as typeof import('../../services/unipesa-reconciliation');

function setAutoRefund(on: boolean): void {
  // The flag is read from the parsed env object at tick time — mutate it
  // directly so both branches can be exercised in one process.
  (env as { RECONCILE_AUTO_REFUND_NOT_FOUND: boolean }).RECONCILE_AUTO_REFUND_NOT_FOUND = on;
}

const logged: { level: string; data: Record<string, unknown> }[] = [];
const log = {
  info:  (d: unknown) => { logged.push({ level: 'info',  data: d as Record<string, unknown> }); },
  warn:  (d: unknown) => { logged.push({ level: 'warn',  data: d as Record<string, unknown> }); },
  error: (d: unknown) => { logged.push({ level: 'error', data: d as Record<string, unknown> }); },
};
const events = () => logged.map((l) => l.data.event);

// ── Fixture ────────────────────────────────────────────────────
const W  = '55555555-5555-4555-8555-555555555555';
const TX = 'ffffffff-0000-4000-8000-0000000000f1';
const TX2 = 'ffffffff-0000-4000-8000-0000000000f2';
const START_BALANCE = 895; // 1000 − (100 + 5) already debited by the claim

function seedPendingPayout(id: string, ageSeconds: number, reference = `WW-${id.slice(-4).toUpperCase()}`): void {
  run(`INSERT INTO public.transactions (id, wallet_user_id, operator, direction, amount, fee, net_amount, currency, phone,
        reference, status, metadata, created_at, idempotency_key)
       VALUES ('${id}', '${W}', 'airtel', 'payout', 100, 5, 100, 'CDF', '+243997174834', '${reference}', 'pending',
        '{"source":"wallet_withdraw","error":"PROVIDER_AMBIGUOUS"}'::jsonb, now() - make_interval(secs => ${ageSeconds}), 'k-${id}')`);
}
function reset(): void {
  run(`DELETE FROM public.provider_webhook_events; DELETE FROM public.transactions; DELETE FROM public.worker_locks;
       DELETE FROM public.wallet_users;
       INSERT INTO public.wallet_users (id, phone, pin_hash, kyc_level, balance_cdf) VALUES ('${W}', 'TESTRECON', 'x', 1, ${START_BALANCE});`);
  logged.length = 0; statusCalls.length = 0;
  setAutoRefund(false); // default: never auto-refund on -1
}
const balance = () => Number(one<string>(`SELECT balance_cdf AS v FROM public.wallet_users WHERE id = '${W}'`));
const txStatus = (id = TX) => one<string>(`SELECT status AS v FROM public.transactions WHERE id = '${id}'`);
const txMeta = (id = TX) => one<Record<string, unknown>>(`SELECT metadata AS v FROM public.transactions WHERE id = '${id}'`);
const attempted = (id = TX) => one<string | null>(`SELECT reconcile_attempted_at::text AS v FROM public.transactions WHERE id = '${id}'`);

describe('unipesa reconciliation worker — pending wallet payouts', { skip: !DB && 'TEST_DATABASE_URL not set (disposable PG required)' }, () => {
  before(() => { assert.ok(RECONCILE_NOT_FOUND_GRACE_SECONDS === 900, 'grace period is 15 min'); });
  beforeEach(reset);

  it('(a) /status=2 → success, balance unchanged', async () => {
    seedPendingPayout(TX, 120); unipesaStatus = 2;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.deepEqual(statusCalls, [`WW-${TX.slice(-4).toUpperCase()}`], 'queried by order_id = reference');
    assert.equal(txStatus(), 'success');
    assert.equal(balance(), START_BALANCE);
    assert.ok(events().includes('transaction_reconciled'));
  });

  it('(b) /status=3 → refund amount+fee once; second tick is a no-op', async () => {
    seedPendingPayout(TX, 120); unipesaStatus = 3;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(txStatus(), 'failed');
    assert.equal(balance(), START_BALANCE + 105);
    const meta = txMeta();
    assert.equal((meta.merchant_metadata as Record<string, unknown>).refunded_amount, 105);
    assert.equal((meta.merchant_metadata as Record<string, unknown>).refund_reason, 'provider_callback_failed');

    // second tick: row is terminal → not claimed; force a direct replay too
    run(`UPDATE public.transactions SET reconcile_attempted_at = NULL WHERE id = '${TX}'`);
    statusCalls.length = 0;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(statusCalls.length, 0, 'terminal row is not claimed again');
    const replay = one<Record<string, unknown>>(`SELECT public.process_wallet_provider_callback('unipesa','reconcile:${TX}:failed-again','${TX}','failed',NULL,'{}'::jsonb) AS v`);
    assert.equal(replay.already_terminal, true);
    assert.equal(balance(), START_BALANCE + 105, 'no double credit');
  });

  for (const code of [0, 1] as StatusCode[]) {
    it(`(c) /status=${code} → nothing changes`, async () => {
      seedPendingPayout(TX, 120); unipesaStatus = code;
      await runReconciliationTick(fakeSupabase() as never, log);
      assert.equal(statusCalls.length, 1);
      assert.equal(txStatus(), 'pending');
      assert.equal(balance(), START_BALANCE);
      assert.ok(events().includes('transaction_still_pending'));
      assert.ok(attempted() !== null, 'stamped so it is retried after the cooldown, not on every tick');
    });
  }

  it('(d) flag off (default): /status=-1 NEVER refunds — manual_review log, still pending even past grace', async () => {
    // env.RECONCILE_AUTO_REFUND_NOT_FOUND defaults to false
    seedPendingPayout(TX, 10 * 60); unipesaStatus = -1;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(statusCalls.length, 1);
    assert.equal(txStatus(), 'pending');
    assert.equal(balance(), START_BALANCE);
    const ev = logged.find((l) => l.data.event === 'transaction_not_found_manual_review');
    assert.ok(ev, 'manual_review log emitted');
    assert.equal(ev!.level, 'warn');
    assert.equal(ev!.data.raw_status, -1);
    assert.equal(ev!.data.raw_status_type, 'number');
    assert.equal(ev!.data.autoRefund, false);
    assert.ok(!events().includes('transaction_reconciled'));

    // Even well past the grace period: still NO refund, still pending.
    run(`UPDATE public.transactions SET reconcile_attempted_at = NULL, created_at = now() - interval '60 minutes' WHERE id = '${TX}'`);
    logged.length = 0;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(txStatus(), 'pending');
    assert.equal(balance(), START_BALANCE);
    const ev2 = logged.find((l) => l.data.event === 'transaction_not_found_manual_review');
    assert.ok(ev2, 'manual_review logged again at 60 min');
    assert.equal((ev2!.data.ageSeconds as number) > 3590, true);
  });

  it('(e) flag on: /status=-1 at 10 min → NO refund (within grace)', async () => {
    setAutoRefund(true);
    seedPendingPayout(TX, 10 * 60); unipesaStatus = -1;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(statusCalls.length, 1);
    assert.equal(txStatus(), 'pending');
    assert.equal(balance(), START_BALANCE);
    const ev = logged.find((l) => l.data.event === 'transaction_not_found_within_grace');
    assert.ok(ev, 'grace log emitted');
    assert.equal(ev!.level, 'warn');
    assert.equal(ev!.data.graceSeconds, 900);
    assert.equal(ev!.data.raw_status, -1);
    assert.equal(ev!.data.raw_status_type, 'number');
    assert.ok(!events().includes('transaction_reconciled'));
  });

  it('(e) flag on: /status=-1 at 16 min → refund once', async () => {
    setAutoRefund(true);
    seedPendingPayout(TX, 16 * 60); unipesaStatus = -1;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(txStatus(), 'failed');
    assert.equal(balance(), START_BALANCE + 105);
    const ev = logged.find((l) => l.data.event === 'transaction_not_found_after_grace');
    assert.ok(ev, 'after-grace log emitted');
    assert.equal(ev!.data.raw_status, -1);
    assert.equal(ev!.data.raw_status_type, 'number');
    run(`UPDATE public.transactions SET reconcile_attempted_at = NULL WHERE id = '${TX}'`);
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(balance(), START_BALANCE + 105, 'second tick does not credit again');
  });

  it('(f) pending aged 60 s is never claimed', async () => {
    seedPendingPayout(TX, 60); unipesaStatus = 3;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(statusCalls.length, 0);
    assert.equal(txStatus(), 'pending');
    assert.equal(attempted(), null);
    assert.equal(balance(), START_BALANCE);
  });

  it('pending rows that are NOT wallet payouts are still ignored', async () => {
    run(`INSERT INTO public.transactions (id, merchant_id, operator, direction, amount, fee, net_amount, currency, reference, status, created_at)
         VALUES ('${TX2}', gen_random_uuid(), 'airtel', 'collect', 100, 0, 100, 'CDF', 'FRK-X', 'pending', now() - interval '5 minutes')`);
    unipesaStatus = 3;
    await runReconciliationTick(fakeSupabase() as never, log);
    assert.equal(statusCalls.length, 0);
    assert.equal(txStatus(TX2), 'pending');
  });

  it('(g) two concurrent claims never return the same row (FOR UPDATE SKIP LOCKED)', async () => {
    seedPendingPayout(TX, 120, 'WW-G1'); seedPendingPayout(TX2, 130, 'WW-G2');
    const claim = `SELECT id FROM public.claim_pending_unipay_transactions(p_min_age_seconds := 90, p_max_age_seconds := 604800, p_batch_size := 1, p_retry_after_seconds := 90)`;
    // Session A claims one row inside an OPEN transaction and holds it for 2 s.
    const a = spawn(PSQL, [DB!, '-tA', '-q', '-c', `BEGIN; ${claim}; SELECT pg_sleep(2); COMMIT;`]);
    let aOut = ''; a.stdout.on('data', (d) => { aOut += d.toString(); });
    await new Promise((r) => setTimeout(r, 500));
    // Session B must NOT block on A's locked row and must get the OTHER row.
    const t0 = Date.now();
    const bRows = rows<{ id: string }>(claim);
    const bMs = Date.now() - t0;
    await new Promise<void>((r) => a.on('close', () => r()));
    const aId = aOut.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l));
    assert.equal(bRows.length, 1);
    assert.notEqual(bRows[0].id, aId, 'B skipped the row locked by A');
    assert.ok(bMs < 1500, `B did not wait for A (took ${bMs} ms)`);
    assert.deepEqual([aId, bRows[0].id].sort(), [TX, TX2].sort());
  });
});
