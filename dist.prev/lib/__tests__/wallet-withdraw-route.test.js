"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const fastify_1 = __importDefault(require("fastify"));
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
const node_module_1 = __importDefault(require("node:module"));
function stubModule(rel, exports) {
    const filename = require.resolve(rel);
    const m = new node_module_1.default(filename);
    m.filename = filename;
    m.loaded = true;
    m.exports = exports;
    require.cache[filename] = m;
}
let providerImpl;
stubModule('../../services/index', { getProviderService: () => ({ initiatePayment: (p) => providerImpl(p) }) });
stubModule('../../services/email', { sendWalletWithdrawalEmail: () => undefined });
stubModule('../../utils/push', { notify: async () => undefined });
stubModule('../../services/avada', { sandboxPayout: () => ({ avada_transaction_id: 'sandbox_x' }) });
const { signWalletToken } = require('../../utils/wallet-jwt');
const walletWithdrawRoute = require('../../routes/wallet/withdraw').default;
const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const wallet = { id: WALLET_ID, is_active: true, balance_cdf: 1000, kyc_level: 1, token_version: 0, email: null, full_name: 'T', lang: 'fr' };
let rpcHandler;
const calls = { rpc: [], updates: [] };
const fakeSupabase = {
    rpc: async (name, args) => {
        const call = { name, args };
        calls.rpc.push(call);
        return rpcHandler(call);
    },
    from: (table) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'wallet_users' ? wallet : null, error: null }) }) }),
        update: (values) => ({
            eq: async (_col, id) => { calls.updates.push({ table, values, id }); return { data: null, error: null }; },
        }),
    }),
};
const claimOk = (args) => ({
    data: { idempotent: false, claimed: true, transaction_id: args.p_tx_id, new_balance: 895 },
    error: null,
});
const token = signWalletToken({ wallet_id: WALLET_ID, phone: '+243997174834', role: 'wallet', token_version: 0 }, process.env.JWT_SECRET);
const BODY = { phone_mm: '+243997174834', operator: 'airtel', amount: 100 };
function post(server, body, headers = {}) {
    return server.inject({
        method: 'POST', url: '/wallet/withdraw',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        payload: body,
    });
}
const rpcNames = () => calls.rpc.map((c) => c.name);
(0, node_test_1.describe)('POST /wallet/withdraw (claim-first, single refund path)', () => {
    let server;
    (0, node_test_1.before)(async () => {
        server = (0, fastify_1.default)({ logger: false, ajv: { customOptions: { coerceTypes: 'array', useDefaults: true, removeAdditional: true } } });
        server.decorate('supabase', fakeSupabase);
        await server.register(walletWithdrawRoute);
        await server.ready();
    });
    (0, node_test_1.after)(async () => { await server.close(); });
    (0, node_test_1.beforeEach)(() => {
        calls.rpc.length = 0;
        calls.updates.length = 0;
        rpcHandler = async ({ name, args }) => (name === 'wallet_withdraw_claim' ? claimOk(args) : { data: null, error: null });
        providerImpl = async () => ({ provider_ref: 'PROV-1', status: 'processing', raw: {} });
    });
    (0, node_test_1.it)('success: claim → provider → processing, 201, no refund', async () => {
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 201, res.body);
        const j = res.json();
        strict_1.default.equal(j.status, 'processing');
        strict_1.default.equal(j.idempotent, false);
        strict_1.default.equal(j.amount, 100);
        strict_1.default.equal(j.fee, 5);
        strict_1.default.equal(j.net_amount, 100);
        strict_1.default.deepEqual(rpcNames(), ['wallet_withdraw_claim']);
        const claim = calls.rpc[0].args;
        strict_1.default.equal(claim.p_total_amount, 105);
        strict_1.default.equal(claim.p_currency, 'CDF');
        strict_1.default.equal(claim.p_reference, `WW-${String(claim.p_tx_id).slice(0, 8).toUpperCase()}`);
        strict_1.default.deepEqual(calls.updates.map((u) => u.values.status), ['processing']);
        strict_1.default.equal(calls.updates[0].values.avada_transaction_id, 'PROV-1');
    });
    (0, node_test_1.it)('never calls the legacy debit/credit RPCs', async () => {
        providerImpl = async () => { throw new Error('Unipesa provider error: code=10105 message=WRONG MERCHANT_ID'); };
        await post(server, BODY);
        strict_1.default.ok(!rpcNames().includes('wallet_debit_with_kyc_limit'));
        strict_1.default.ok(!rpcNames().includes('wallet_credit_cdf'));
    });
    (0, node_test_1.it)('server generates an idempotency key when the client sends none', async () => {
        await post(server, BODY);
        strict_1.default.match(String(calls.rpc[0].args.p_idempotency_key), /^srv:[0-9a-f-]{36}$/);
    });
    (0, node_test_1.it)('Idempotency-Key header is forwarded to the claim RPC', async () => {
        await post(server, BODY, { 'idempotency-key': 'client-key-0001' });
        strict_1.default.equal(calls.rpc[0].args.p_idempotency_key, 'client-key-0001');
    });
    (0, node_test_1.it)('definitive rejection (10105): ONE refund RPC, 502, no provider detail leaked', async () => {
        providerImpl = async () => { throw new Error('Unipesa provider error: code=10105 message=WRONG MERCHANT_ID'); };
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 502);
        strict_1.default.deepEqual(res.json(), { error: 'Provider service unavailable', statusCode: 502 });
        strict_1.default.doesNotMatch(res.body, /MERCHANT_ID|10105|Unipesa/);
        const refunds = calls.rpc.filter((c) => c.name === 'wallet_withdraw_fail_and_refund');
        strict_1.default.equal(refunds.length, 1);
        strict_1.default.equal(refunds[0].args.p_tx_id, calls.rpc[0].args.p_tx_id);
        strict_1.default.equal(refunds[0].args.p_reason, 'provider_rejected_10105');
        strict_1.default.equal(calls.updates.length, 0, 'no direct status update — the RPC owns the transition');
    });
    (0, node_test_1.it)('timeout: ZERO refund, tx stays pending, 202 with transaction_id', async () => {
        providerImpl = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 202, res.body);
        const j = res.json();
        strict_1.default.equal(j.status, 'pending');
        strict_1.default.equal(j.transaction_id, calls.rpc[0].args.p_tx_id);
        strict_1.default.ok(typeof j.message === 'string' && !/Unipesa|abort/i.test(j.message));
        strict_1.default.deepEqual(rpcNames(), ['wallet_withdraw_claim'], 'no refund RPC');
        strict_1.default.equal(calls.updates.length, 1);
        strict_1.default.equal(calls.updates[0].values.status, undefined, 'status untouched (pending)');
        strict_1.default.equal(calls.updates[0].values.metadata.error, 'PROVIDER_AMBIGUOUS');
    });
    (0, node_test_1.it)('unknown provider code (13104) is ambiguous → no refund, 202', async () => {
        providerImpl = async () => { throw new Error('Unipesa provider error: code=13104 message=x'); };
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 202);
        strict_1.default.deepEqual(rpcNames(), ['wallet_withdraw_claim']);
    });
    (0, node_test_1.it)('HTTP 502 from Unipesa is ambiguous → no refund, 202', async () => {
        providerImpl = async () => { throw new Error('Unipesa HTTP 502: Bad Gateway'); };
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 202);
        strict_1.default.deepEqual(rpcNames(), ['wallet_withdraw_claim']);
    });
    (0, node_test_1.it)('replay of a processing tx → 201, idempotent:true, same shape, no provider call', async () => {
        let providerCalls = 0;
        providerImpl = async () => { providerCalls += 1; return { provider_ref: 'X', status: 'processing', raw: {} }; };
        rpcHandler = async () => ({
            data: { idempotent: true, claimed: false, transaction_id: 'orig-tx', status: 'processing', amount: 100, fee: 5, net_amount: 100, currency: 'CDF' },
            error: null,
        });
        const res = await post(server, BODY, { 'idempotency-key': 'client-key-0001' });
        strict_1.default.equal(res.statusCode, 201);
        strict_1.default.deepEqual(res.json(), { transaction_id: 'orig-tx', status: 'processing', amount: 100, fee: 5, net_amount: 100, currency: 'CDF', sandbox: false, idempotent: true });
        strict_1.default.equal(providerCalls, 0);
        strict_1.default.equal(calls.updates.length, 0);
    });
    (0, node_test_1.it)('replay of a failed tx → 409 with the existing id', async () => {
        rpcHandler = async () => ({ data: { idempotent: true, claimed: false, transaction_id: 'orig-tx', status: 'failed' }, error: null });
        const res = await post(server, BODY, { 'idempotency-key': 'client-key-0001' });
        strict_1.default.equal(res.statusCode, 409);
        strict_1.default.deepEqual(res.json(), { error: 'WITHDRAWAL_ALREADY_FAILED', transaction_id: 'orig-tx', status: 'failed', idempotent: true, statusCode: 409 });
    });
    (0, node_test_1.it)('same key, different payload → 422 IDEMPOTENCY_KEY_REUSED', async () => {
        rpcHandler = async () => ({ data: null, error: { message: 'IDEMPOTENCY_KEY_REUSED' } });
        const res = await post(server, { ...BODY, amount: 200 }, { 'idempotency-key': 'client-key-0001' });
        strict_1.default.equal(res.statusCode, 422);
        strict_1.default.equal(res.json().error, 'IDEMPOTENCY_KEY_REUSED');
    });
    for (const code of ['INVALID_TOTAL', 'INVALID_AMOUNT', 'INVALID_FEE', 'UNSUPPORTED_WALLET_CURRENCY']) {
        (0, node_test_1.it)(`claim guard ${code} → 400`, async () => {
            rpcHandler = async () => ({ data: null, error: { message: `${code}: detail` } });
            const res = await post(server, BODY);
            strict_1.default.equal(res.statusCode, 400);
            strict_1.default.equal(res.json().error, code);
        });
    }
    (0, node_test_1.it)('INSUFFICIENT_FUNDS → 402 (unchanged contract)', async () => {
        rpcHandler = async () => ({ data: null, error: { message: 'INSUFFICIENT_FUNDS: balance 50, required 105' } });
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 402);
        strict_1.default.equal(res.json().required_cdf, 105);
    });
    (0, node_test_1.it)('KYC_LIMIT_EXCEEDED → 403 with parsed limit (unchanged contract)', async () => {
        rpcHandler = async () => ({ data: null, error: { message: 'KYC_LIMIT_EXCEEDED: daily_used 900, requested 105, limit 1000' } });
        const res = await post(server, BODY);
        strict_1.default.equal(res.statusCode, 403);
        strict_1.default.equal(res.json().limit, 1000);
        strict_1.default.equal(res.json().daily_used, 900);
    });
    (0, node_test_1.it)('currency USD is rejected by the schema before any RPC', async () => {
        const res = await post(server, { ...BODY, currency: 'USD' });
        strict_1.default.equal(res.statusCode, 400);
        strict_1.default.equal(calls.rpc.length, 0);
    });
    (0, node_test_1.it)('phone/operator mismatch is rejected BEFORE the claim (no debit, no refund)', async () => {
        const res = await post(server, { ...BODY, operator: 'orange' }); // 099… is Airtel
        strict_1.default.equal(res.statusCode, 400);
        strict_1.default.equal(res.json().error, 'OPERATOR_PHONE_MISMATCH');
        strict_1.default.equal(calls.rpc.length, 0);
    });
});
//# sourceMappingURL=wallet-withdraw-route.test.js.map