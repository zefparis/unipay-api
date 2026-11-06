"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function source(relativePath) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), relativePath), 'utf8');
}
process.env.BFF_IP_SECRET = 'test-bff-secret-0123456789abcdef';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';
process.env.HMAC_SECRET = process.env.HMAC_SECRET || 'test-hmac-secret-0123456';
const SECRET = process.env.BFF_IP_SECRET;
const sign = (ip) => node_crypto_1.default.createHmac('sha256', SECRET).update(ip).digest('hex');
let lib;
(0, node_test_1.describe)('rate limiting — IP réelle', () => {
    (0, node_test_1.before)(async () => {
        lib = await Promise.resolve().then(() => __importStar(require('../client-ip.js')));
    });
    (0, node_test_1.it)('fait confiance aux sauts locaux et privés uniquement', () => {
        for (const ok of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '172.18.0.2', '169.254.1.1', '::1']) {
            strict_1.default.equal(lib.isTrustedProxy(ok), true, ok);
        }
        for (const ko of ['8.8.8.8', '1.2.3.4', '2001:861::1', '172.32.0.1', '']) {
            strict_1.default.equal(lib.isTrustedProxy(ko), false, ko);
        }
    });
    (0, node_test_1.it)('accepte une signature valide / rejette une invalide', () => {
        const req = (headers) => ({ headers });
        strict_1.default.equal(lib.verifySignedClientIp(req({ 'x-unipay-client-ip': '1.2.3.4', 'x-unipay-client-sig': sign('1.2.3.4') })), '1.2.3.4');
        strict_1.default.equal(lib.verifySignedClientIp(req({ 'x-unipay-client-ip': '1.2.3.4', 'x-unipay-client-sig': sign('9.9.9.9') })), null);
        strict_1.default.equal(lib.verifySignedClientIp(req({ 'x-unipay-client-ip': '1.2.3.4' })), null);
    });
    // ── Intégration : même config que server.ts ──────────────────
    async function makeServer(keyGen, max = 3) {
        const { default: Fastify } = await Promise.resolve().then(() => __importStar(require('fastify')));
        const { default: rateLimit } = await Promise.resolve().then(() => __importStar(require('@fastify/rate-limit')));
        const app = Fastify({ trustProxy: lib.trustedProxy, logger: false });
        await app.register(rateLimit, { global: true, max, timeWindow: '1 minute', keyGenerator: keyGen });
        app.get('/probe', async () => ({ ok: true }));
        return app;
    }
    (0, node_test_1.it)('un X-Forwarded-For forgé en tête ne contourne pas la limite', async () => {
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
        strict_1.default.equal(results[3].statusCode, 429);
        await app.close();
    });
    (0, node_test_1.it)('deux marchands via le BFF ont des compteurs séparés', async () => {
        const app = await makeServer(lib.rateLimitKey);
        const via = (ip) => ({
            'x-forwarded-for': '18.192.0.1', // IP de sortie Vercel (partagée)
            'x-unipay-client-ip': ip,
            'x-unipay-client-sig': sign(ip),
        });
        for (let i = 0; i < 3; i++) {
            strict_1.default.equal((await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: via('41.1.1.1') })).statusCode, 200);
        }
        // Le marchand B a toujours un compteur plein malgré l'épuisement de A
        strict_1.default.equal((await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: via('105.2.2.2') })).statusCode, 200);
        strict_1.default.equal((await app.inject({ method: 'GET', url: '/probe', remoteAddress: '127.0.0.1', headers: via('41.1.1.1') })).statusCode, 429);
        await app.close();
    });
    (0, node_test_1.it)('un client ne peut pas usurper l\'en-tête signé', async () => {
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
        strict_1.default.equal(r.statusCode, 429);
        await app.close();
    });
    (0, node_test_1.it)('payment/initiate : limite par clé API, pas par IP', async () => {
        const app = await makeServer(lib.apiKeyLimitKey);
        const call = (key) => app.inject({
            method: 'GET', url: '/probe', remoteAddress: '127.0.0.1',
            headers: { 'x-forwarded-for': '18.192.0.1', 'x-api-key': key },
        });
        for (let i = 0; i < 3; i++)
            strict_1.default.equal((await call('key-marchand-AAAA')).statusCode, 200);
        strict_1.default.equal((await call('key-marchand-AAAA')).statusCode, 429);
        // une autre clé via la MÊME IP n'est pas bloquée
        strict_1.default.equal((await call('key-marchand-BBBB')).statusCode, 200);
        await app.close();
    });
});
(0, node_test_1.describe)('source — server.ts', () => {
    (0, node_test_1.it)('trustProxy ne fait confiance qu\'aux sauts privés', () => {
        strict_1.default.match(source('src/server.ts'), /trustProxy: trustedProxy/);
        strict_1.default.match(source('src/server.ts'), /keyGenerator: rateLimitKey/);
    });
    (0, node_test_1.it)('limites dédiées KYC + initiate', () => {
        const kyc = source('src/routes/merchant/kyc.ts');
        strict_1.default.equal((kyc.match(/max: 20, timeWindow: '1 hour'/g) ?? []).length, 2);
        strict_1.default.match(source('src/routes/payment/initiate.ts'), /keyGenerator: apiKeyLimitKey/);
    });
});
(0, node_test_1.describe)('email login limiter (CGNAT-safe)', () => {
    (0, node_test_1.it)('bloque à la 6e tentative sur le même email, pas sur un autre', async () => {
        const { loginEmailAllowed, resetEmailLimiter } = await Promise.resolve().then(() => __importStar(require('../email-login-limiter.js')));
        resetEmailLimiter();
        for (let i = 0; i < 5; i++)
            strict_1.default.equal(loginEmailAllowed('marchand@test.cd'), true);
        strict_1.default.equal(loginEmailAllowed('marchand@test.cd'), false);
        strict_1.default.equal(loginEmailAllowed('autre@test.cd'), true);
        strict_1.default.equal(loginEmailAllowed('MARCHAND@test.cd'), false); // normalisé
    });
    (0, node_test_1.it)('la route login a une limite par email + garde IP large', () => {
        const login = source('src/routes/merchant/login.ts');
        strict_1.default.match(login, /loginEmailAllowed\(email\)/);
        strict_1.default.match(login, /keyGenerator: rateLimitKey/);
        strict_1.default.match(login, /max: 60, timeWindow: '1 minute'/);
    });
});
(0, node_test_1.describe)('KYC — clé par merchant_id', () => {
    (0, node_test_1.it)('les deux routes KYC sont limitées par merchant', () => {
        const kyc = source('src/routes/merchant/kyc.ts');
        strict_1.default.match(kyc, /merchantIdFromRequest/);
        strict_1.default.equal((kyc.match(/keyGenerator: kycMerchantKey/g) ?? []).length, 2);
    });
});
//# sourceMappingURL=rate-limit-client-ip.test.js.map