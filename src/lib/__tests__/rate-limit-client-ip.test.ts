import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

process.env.BFF_IP_SECRET = 'test-bff-secret-0123456789abcdef';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.HMAC_SECRET = process.env.HMAC_SECRET || 'test-hmac-secret-0123456';
const SECRET = process.env.BFF_IP_SECRET;

const sign = (ip: string) =>
  crypto.createHmac('sha256', SECRET!).update(ip).digest('hex');

type ClientIp = typeof import('../client-ip.js');
let lib: ClientIp;

describe('rate limiting — IP réelle', () => {
  before(async () => {
    lib = await import('../client-ip.js');
  });

  it('fait confiance aux sauts locaux et privés uniquement', () => {
    for (const ok of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '172.18.0.2', '169.254.1.1', '::1']) {
      assert.equal(lib.isTrustedProxy(ok), true, ok);
    }
    for (const ko of ['8.8.8.8', '1.2.3.4', '2001:861::1', '172.32.0.1', '']) {
      assert.equal(lib.isTrustedProxy(ko), false, ko);
    }
  });

  it('accepte une signature valide / rejette une invalide', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
    assert.equal(lib.verifySignedClientIp(req({ 'x-unipay-client-ip': '1.2.3.4', 'x-unipay-client-sig': sign('1.2.3.4') })), '1.2.3.4');
    assert.equal(lib.verifySignedClientIp(req({ 'x-unipay-client-ip': '1.2.3.4', 'x-unipay-client-sig': sign('9.9.9.9') })), null);
    assert.equal(lib.verifySignedClientIp(req({ 'x-unipay-client-ip': '1.2.3.4' })), null);
  });

  // ── Intégration : même config que server.ts ──────────────────

  async function makeServer(keyGen: (req: FastifyRequest) => string, max = 3): Promise<FastifyInstance> {
    const { default: Fastify } = await import('fastify');
    const { default: rateLimit } = await import('@fastify/rate-limit');
    const app = Fastify({ trustProxy: lib.trustedProxy, logger: false });
    await app.register(rateLimit, { global: true, max, timeWindow: '1 minute', keyGenerator: keyGen });
    app.get('/probe', async () => ({ ok: true }));
    return app;
  }

  it('un X-Forwarded-For forgé en tête ne contourne pas la limite', async () => {
    const app = await makeServer(lib.rateLimitKey);
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await app.inject({
        method: 'GET', url: '/probe', remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `10.${i}.0.1, 203.0.113.9` },
      }));
    }
    // 4e requête → compteur de 203.0.113.9 (dernier saut non privé) épuisé,
    // les entrées forgées à gauche sont ignorées.
    assert.equal(results[3].statusCode, 429);
    await app.close();
  });

  it('deux marchands via le BFF ont des compteurs séparés', async () => {
    const app = await makeServer(lib.rateLimitKey);
    const via = (ip: string) => ({
      'x-forwarded-for': '18.192.0.1', // IP de sortie Vercel (partagée)
      'x-unipay-client-ip': ip,
      'x-unipay-client-sig': sign(ip),
    });
    for (let i = 0; i < 3; i++) {
      assert.equal((await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: via('41.1.1.1') })).statusCode, 200);
    }
    // Le marchand B a toujours un compteur plein malgré l'épuisement de A
    assert.equal((await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: via('105.2.2.2') })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: via('41.1.1.1') })).statusCode, 429);
    await app.close();
  });

  it('un client ne peut pas usurper l\'en-tête signé', async () => {
    const app = await makeServer(lib.rateLimitKey);
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: {
        'x-forwarded-for': '203.0.113.50',
        'x-unipay-client-ip': `66.66.66.${i}`,
        'x-unipay-client-sig': 'deadbeef'.repeat(8),
      } });
    }
    const r = await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: {
      'x-forwarded-for': '203.0.113.50', 'x-unipay-client-ip': '66.66.66.9', 'x-unipay-client-sig': 'deadbeef'.repeat(8),
    } });
    // signature bidon → repli sur req.ip : les 4 IPs forgées partagent le compteur
    assert.equal(r.statusCode, 429);
    await app.close();
  });

  it('payment/initiate : limite par clé API, pas par IP', async () => {
    const app = await makeServer(lib.apiKeyLimitKey);
    const call = (key: string) => app.inject({
      method: 'GET', url: '/probe', remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '18.192.0.1', 'x-api-key': key },
    });
    for (let i = 0; i < 3; i++) assert.equal((await call('key-marchand-AAAA')).statusCode, 200);
    assert.equal((await call('key-marchand-AAAA')).statusCode, 429);
    // une autre clé via la MÊME IP n'est pas bloquée
    assert.equal((await call('key-marchand-BBBB')).statusCode, 200);
    await app.close();
  });
});

describe('source — server.ts', () => {
  it('trustProxy ne fait confiance qu\'aux sauts privés', () => {
    assert.match(source('src/server.ts'), /trustProxy: trustedProxy/);
    assert.match(source('src/server.ts'), /keyGenerator: rateLimitKey/);
  });
  it('limites dédiées KYC + initiate', () => {
    const kyc = source('src/routes/merchant/kyc.ts');
    assert.equal((kyc.match(/max: 20, timeWindow: '1 hour'/g) ?? []).length, 2);
    assert.match(source('src/routes/payment/initiate.ts'), /keyGenerator: apiKeyLimitKey/);
  });
});

describe('email login limiter (CGNAT-safe)', () => {
  it('bloque à la 6e tentative sur le même email, pas sur un autre', async () => {
    const { loginEmailAllowed, resetEmailLimiter } = await import('../email-login-limiter.js');
    resetEmailLimiter();
    for (let i = 0; i < 5; i++) assert.equal(loginEmailAllowed('marchand@test.cd'), true);
    assert.equal(loginEmailAllowed('marchand@test.cd'), false);
    assert.equal(loginEmailAllowed('autre@test.cd'), true);
    assert.equal(loginEmailAllowed('MARCHAND@test.cd'), false); // normalisé
  });

  it('la route login a une limite par email + garde IP large', () => {
    const login = source('src/routes/merchant/login.ts');
    assert.match(login, /loginEmailAllowed\(email\)/);
    assert.match(login, /keyGenerator: rateLimitKey/);
    assert.match(login, /max: 60, timeWindow: '1 minute'/);
  });
});

describe('KYC — clé par merchant_id', () => {
  it('les deux routes KYC sont limitées par merchant', () => {
    const kyc = source('src/routes/merchant/kyc.ts');
    assert.match(kyc, /merchantIdFromRequest/);
    assert.equal((kyc.match(/keyGenerator: kycMerchantKey/g) ?? []).length, 2);
  });
});
