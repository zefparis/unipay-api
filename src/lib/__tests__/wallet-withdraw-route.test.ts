/**
 * POST /wallet/withdraw — behavioural tests via fastify.inject with a
 * fake Supabase client and a simulated provider. No network, no DB.
 *
 * Proves the money-safety contract of the route:
 *   - success        → claim, provider, 'processing', 201, no refund
 *   - definitive rej.→ exactly ONE wallet_withdraw_fail_and_refund, 502,
 *                      no provider detail in the body
 *   - timeout        → ZERO refund calls, tx left pending, 202
 *   - replay         → 201 idempotent:true (processing) / 409 (failed)
 *   - key reuse      → 422 ; claim input guards → 400
 *   - every withdrawal goes through wallet_withdraw_claim (server key
 *     when the client sends none)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';
process.env.JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long';
process.env.NODE_ENV = 'test';
delete process.env.WALLET_FEE_RATE;

// ── Module stubs (CJS): seed require.cache BEFORE the route is required ──
// tsx compiles exports to getters, so they cannot be reassigned after the
// fact; a pre-seeded cache entry is what the route's require() resolves to.
/* eslint-disable @typescript-eslint/no-require-imports */
import Module from 'node:module';
function stubModule(rel: string, exports: Record<string, unknown>): void {
  const filename = require.resolve(rel);
  const m = new Module(filename);
  m.filename = filename;
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
}

let providerImpl: (payload: unknown) => Promise<{ provider_ref: string; status: string; raw: unknown }>;
stubModule('../../services/index', { getProviderService: () => ({ initiatePayment: (p: unknown) => providerImpl(p) }) });
stubModule('../../services/email', { sendWalletWithdrawalEmail: () => undefined });
stubModule('../../utils/push', { notify: async () => undefined });
stubModule('../../services/avada', { sandboxPayout: () => ({ avada_transaction_id: 'sandbox_x' }) });

const { signWalletToken } = require('../../utils/wallet-jwt') as typeof import('../../utils/wallet-jwt');
const walletWithdrawRoute = (require('../../routes/wallet/withdraw') as { default: import('fastify').FastifyPluginAsync }).default;
/* eslint-enable @typescript-eslint/no-require-imports */

// ── Fake Supabase ──────────────────────────────────────────────
type RpcCall = { name: string; args: Record<string, unknown> };
type UpdateCall = { table: string; values: Record<string, unknown>; id: unknown };

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const wallet = { id: WALLET_ID, is_active: true, balance_cdf: 1000, kyc_level: 1, token_version: 0, email: null, full_name: 'T', lang: 'fr' };

let rpcHandler: (call: RpcCall) => Promise<{ data: unknown; error: { message: string } | null }>;
const calls: { rpc: RpcCall[]; updates: UpdateCall[] } = { rpc: [], updates: [] };

const fakeSupabase = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    const call = { name, args };
    calls.rpc.push(call);
    return rpcHandler(call);
  },
  from: (table: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'wallet_users' ? wallet : null, error: null }) }) }),
    update: (values: Record<string, unknown>) => ({
      eq: async (_col: string, id: unknown) => { calls.updates.push({ table, values, id }); return { data: null, error: null }; },
    }),
  }),
};

const claimOk = (args: Record<string, unknown>) => ({
  data: { idempotent: false, claimed: true, transaction_id: args.p_tx_id, new_balance: 895 },
  error: null,
});

const token = signWalletToken({ wallet_id: WALLET_ID, phone: '+243997174834', role: 'wallet', token_version: 0 }, process.env.JWT_SECRET!);
const BODY = { phone_mm: '+243997174834', operator: 'airtel', amount: 100 };

function post(server: FastifyInstance, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return server.inject({
    method: 'POST', url: '/wallet/withdraw',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    payload: body,
  });
}
const rpcNames = () => calls.rpc.map((c) => c.name);

describe('POST /wallet/withdraw (claim-first, single refund path)', () => {
  let server: FastifyInstance;

  before(async () => {
    server = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: 'array', useDefaults: true, removeAdditional: true } } });
    server.decorate('supabase', fakeSupabase as never);
    await server.register(walletWithdrawRoute);
    await server.ready();
  });
  after(async () => { await server.close(); });
  beforeEach(() => {
    calls.rpc.length = 0; calls.updates.length = 0;
    rpcHandler = async ({ name, args }) => (name === 'wallet_withdraw_claim' ? claimOk(args) : { data: null, error: null });
    providerImpl = async () => ({ provider_ref: 'PROV-1', status: 'processing', raw: {} });
  });

  it('success: claim → provider → processing, 201, no refund', async () => {
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 201, res.body);
    const j = res.json();
    assert.equal(j.status, 'processing');
    assert.equal(j.idempotent, false);
    assert.equal(j.amount, 100); assert.equal(j.fee, 5); assert.equal(j.net_amount, 100);
    assert.deepEqual(rpcNames(), ['wallet_withdraw_claim']);
    const claim = calls.rpc[0].args;
    assert.equal(claim.p_total_amount, 105);
    assert.equal(claim.p_currency, 'CDF');
    assert.equal(claim.p_reference, `WW-${String(claim.p_tx_id).slice(0, 8).toUpperCase()}`);
    assert.deepEqual(calls.updates.map((u) => u.values.status), ['processing']);
    assert.equal(calls.updates[0].values.avada_transaction_id, 'PROV-1');
  });

  it('never calls the legacy debit/credit RPCs', async () => {
    providerImpl = async () => { throw new Error('Unipesa provider error: code=10105 message=WRONG MERCHANT_ID'); };
    await post(server, BODY);
    assert.ok(!rpcNames().includes('wallet_debit_with_kyc_limit'));
    assert.ok(!rpcNames().includes('wallet_credit_cdf'));
  });

  it('server generates an idempotency key when the client sends none', async () => {
    await post(server, BODY);
    assert.match(String(calls.rpc[0].args.p_idempotency_key), /^srv:[0-9a-f-]{36}$/);
  });

  it('Idempotency-Key header is forwarded to the claim RPC', async () => {
    await post(server, BODY, { 'idempotency-key': 'client-key-0001' });
    assert.equal(calls.rpc[0].args.p_idempotency_key, 'client-key-0001');
  });

  it('definitive rejection (10105): ONE refund RPC, 502, no provider detail leaked', async () => {
    providerImpl = async () => { throw new Error('Unipesa provider error: code=10105 message=WRONG MERCHANT_ID'); };
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: 'Provider service unavailable', statusCode: 502 });
    assert.doesNotMatch(res.body, /MERCHANT_ID|10105|Unipesa/);
    const refunds = calls.rpc.filter((c) => c.name === 'wallet_withdraw_fail_and_refund');
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].args.p_tx_id, calls.rpc[0].args.p_tx_id);
    assert.equal(refunds[0].args.p_reason, 'provider_rejected_10105');
    assert.equal(calls.updates.length, 0, 'no direct status update — the RPC owns the transition');
  });

  it('timeout: ZERO refund, tx stays pending, 202 with transaction_id', async () => {
    providerImpl = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 202, res.body);
    const j = res.json();
    assert.equal(j.status, 'pending');
    assert.equal(j.transaction_id, calls.rpc[0].args.p_tx_id);
    assert.ok(typeof j.message === 'string' && !/Unipesa|abort/i.test(j.message));
    assert.deepEqual(rpcNames(), ['wallet_withdraw_claim'], 'no refund RPC');
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].values.status, undefined, 'status untouched (pending)');
    assert.equal((calls.updates[0].values.metadata as Record<string, unknown>).error, 'PROVIDER_AMBIGUOUS');
  });

  it('unknown provider code (13104) is ambiguous → no refund, 202', async () => {
    providerImpl = async () => { throw new Error('Unipesa provider error: code=13104 message=x'); };
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(rpcNames(), ['wallet_withdraw_claim']);
  });

  it('HTTP 502 from Unipesa is ambiguous → no refund, 202', async () => {
    providerImpl = async () => { throw new Error('Unipesa HTTP 502: Bad Gateway'); };
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(rpcNames(), ['wallet_withdraw_claim']);
  });

  it('replay of a processing tx → 201, idempotent:true, same shape, no provider call', async () => {
    let providerCalls = 0;
    providerImpl = async () => { providerCalls += 1; return { provider_ref: 'X', status: 'processing', raw: {} }; };
    rpcHandler = async () => ({
      data: { idempotent: true, claimed: false, transaction_id: 'orig-tx', status: 'processing', amount: 100, fee: 5, net_amount: 100, currency: 'CDF' },
      error: null,
    });
    const res = await post(server, BODY, { 'idempotency-key': 'client-key-0001' });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { transaction_id: 'orig-tx', status: 'processing', amount: 100, fee: 5, net_amount: 100, currency: 'CDF', sandbox: false, idempotent: true });
    assert.equal(providerCalls, 0);
    assert.equal(calls.updates.length, 0);
  });

  it('replay of a failed tx → 409 with the existing id', async () => {
    rpcHandler = async () => ({ data: { idempotent: true, claimed: false, transaction_id: 'orig-tx', status: 'failed' }, error: null });
    const res = await post(server, BODY, { 'idempotency-key': 'client-key-0001' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: 'WITHDRAWAL_ALREADY_FAILED', transaction_id: 'orig-tx', status: 'failed', idempotent: true, statusCode: 409 });
  });

  it('same key, different payload → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    rpcHandler = async () => ({ data: null, error: { message: 'IDEMPOTENCY_KEY_REUSED' } });
    const res = await post(server, { ...BODY, amount: 200 }, { 'idempotency-key': 'client-key-0001' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, 'IDEMPOTENCY_KEY_REUSED');
  });

  for (const code of ['INVALID_TOTAL', 'INVALID_AMOUNT', 'INVALID_FEE', 'UNSUPPORTED_WALLET_CURRENCY']) {
    it(`claim guard ${code} → 400`, async () => {
      rpcHandler = async () => ({ data: null, error: { message: `${code}: detail` } });
      const res = await post(server, BODY);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, code);
    });
  }

  it('INSUFFICIENT_FUNDS → 402 (unchanged contract)', async () => {
    rpcHandler = async () => ({ data: null, error: { message: 'INSUFFICIENT_FUNDS: balance 50, required 105' } });
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().required_cdf, 105);
  });

  it('KYC_LIMIT_EXCEEDED → 403 with parsed limit (unchanged contract)', async () => {
    rpcHandler = async () => ({ data: null, error: { message: 'KYC_LIMIT_EXCEEDED: daily_used 900, requested 105, limit 1000' } });
    const res = await post(server, BODY);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().limit, 1000);
    assert.equal(res.json().daily_used, 900);
  });

  it('currency USD is rejected by the schema before any RPC', async () => {
    const res = await post(server, { ...BODY, currency: 'USD' });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.rpc.length, 0);
  });

  it('phone/operator mismatch is rejected BEFORE the claim (no debit, no refund)', async () => {
    const res = await post(server, { ...BODY, operator: 'orange' }); // 099… is Airtel
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'OPERATOR_PHONE_MISMATCH');
    assert.equal(calls.rpc.length, 0);
  });
});
