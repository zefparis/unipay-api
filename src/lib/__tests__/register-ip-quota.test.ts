import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Quota IP persisté (registration_attempts) — intégration avec Fastify
 * réel et Supabase MOCKÉ (aucune écriture en prod, règle AGENTS.md).
 */
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';
process.env.JWT_SECRET ??= 'test-jwt-secret-1234567890-abcdefghijklmnop';
process.env.BREVO_API_KEY ??= 'xkeysib-test';

type Row = Record<string, unknown>;

function makeSupabaseMock(opts: { ipCountToday: number; tableMissing?: boolean }) {
  const inserted: { table: string; row: Row }[] = [];
  const makeQuery = (table: string) => {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    Object.assign(q, {
      select: (_c?: string, o?: { count?: string; head?: boolean }) => {
        (q as Row).__count = o?.count === 'exact';
        return q;
      },
      eq: chain, ilike: chain, gte: chain, is: chain, neq: chain, limit: chain, order: chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { id: 'm-new-1' }, error: null }),
      insert: (row: Row | Row[]) => {
        inserted.push({ table, row: Array.isArray(row) ? row[0] : row });
        return {
          select: () => ({ single: async () => ({ data: { id: 'm-new-1' }, error: null }) }),
          then: (res: (v: unknown) => void) => res({ error: null }),
        };
      },
      then: (res: (v: unknown) => void) => {
        if (table === 'registration_attempts') {
          if (opts.tableMissing) return res({ count: null, error: { message: 'relation does not exist' } });
          return res({ count: opts.ipCountToday, error: null });
        }
        return res({ count: 0, data: [], error: null });
      },
    });
    return q;
  };
  return { from: (t: string) => makeQuery(t), inserted };
}

async function build(sb: ReturnType<typeof makeSupabaseMock>) {
  const warns: string[] = [];
  const app: FastifyInstance = Fastify({
    logger: { level: 'warn', hooks: { logMethod(args, method) { warns.push(String(args[0] ?? args[1] ?? '')); method.apply(this, args); } } },
    trustProxy: true,
  });
  app.decorate('supabase', sb as never);
  const { default: registerRoute } = await import('../../routes/merchant/register');
  await app.register(async (v1) => { v1.register(registerRoute); }, { prefix: '/v1' });
  await app.ready();
  return { app, warns };
}

const body = { name: 'Test Local', email: 'local@unipay-test.local', password: 'Passw0rd!xyz' };

describe('register — quota IP persisté en base', () => {
  let app: FastifyInstance | undefined;
  after(async () => { await app?.close(); });

  it('inscription OK → une ligne insérée dans registration_attempts (ip + merchant_id), aucun warn fail-open', async () => {
    const sb = makeSupabaseMock({ ipCountToday: 0 });
    const b = await build(sb); app = b.app;
    const res = await app.inject({ method: 'POST', url: '/v1/merchant/register', payload: body, headers: { 'x-forwarded-for': '41.243.1.10' } });
    assert.equal(res.statusCode, 201, res.body);
    const ra = sb.inserted.find((i) => i.table === 'registration_attempts');
    assert.ok(ra, 'registration_attempts doit recevoir une ligne');
    assert.equal(ra!.row.ip, '41.243.1.10');
    assert.equal(ra!.row.merchant_id, 'm-new-1');
    assert.ok(!b.warns.some((w) => /registration_attempts indisponible/.test(w)), 'pas de warn fail-open');
    await app.close(); app = undefined;
  });

  it('10 inscriptions déjà faites aujourd\u2019hui depuis cette IP → 429, rien inséré', async () => {
    const sb = makeSupabaseMock({ ipCountToday: 10 });
    const b = await build(sb); app = b.app;
    const res = await app.inject({ method: 'POST', url: '/v1/merchant/register', payload: body, headers: { 'x-forwarded-for': '41.243.1.10' } });
    assert.equal(res.statusCode, 429);
    assert.match(res.body, /adresse IP/);
    assert.equal(sb.inserted.length, 0);
    await app.close(); app = undefined;
  });

  it('table absente (migration non appliquée) → fail open + warn explicite', async () => {
    const sb = makeSupabaseMock({ ipCountToday: 0, tableMissing: true });
    const b = await build(sb); app = b.app;
    const res = await app.inject({ method: 'POST', url: '/v1/merchant/register', payload: body, headers: { 'x-forwarded-for': '41.243.1.11' } });
    assert.equal(res.statusCode, 201);
    assert.ok(b.warns.some((w) => /registration_attempts indisponible/.test(w)), 'warn fail-open attendu');
  });
});
