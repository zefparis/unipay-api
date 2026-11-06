"use strict";
/**
 * Fastify v5 migration smoke test.
 *
 * Boots a minimal Fastify v5 server with the same plugins and configuration
 * patterns used in the real app (helmet, rate-limit, multipart, custom
 * content type parser, error handler, preHandler hook) to verify the
 * migration doesn't break the framework integration.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const fastify_1 = __importDefault(require("fastify"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
(0, node_test_1.describe)('Fastify v5 migration smoke test', () => {
    let server;
    (0, node_test_1.before)(async () => {
        server = (0, fastify_1.default)({
            trustProxy: true,
            logger: false,
            ajv: {
                customOptions: {
                    coerceTypes: 'array',
                    useDefaults: true,
                    removeAdditional: true,
                },
            },
        });
        server.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 65536 }, (req, body, done) => {
            try {
                const str = body.trim();
                done(null, str ? JSON.parse(str) : {});
            }
            catch (err) {
                done(err, undefined);
            }
        });
        await server.register(rate_limit_1.default, {
            global: true,
            max: 5,
            timeWindow: '1 minute',
            keyGenerator: (req) => req.ip,
            errorResponseBuilder: () => ({
                error: 'Too Many Requests',
                message: 'Rate limit exceeded',
                statusCode: 429,
            }),
        });
        await server.register(helmet_1.default, { global: true });
        await server.register(multipart_1.default, { limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
        // Health route — public, no auth
        server.get('/health', async () => ({ status: 'ok' }));
        // Protected routes — scoped sub-instance with preHandler hook
        await server.register(async (sub) => {
            sub.addHook('preHandler', async (request, reply) => {
                const auth = request.headers.authorization;
                if (!auth || !auth.startsWith('Bearer ')) {
                    return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
                }
            });
            sub.get('/protected', async () => ({ ok: true }));
        });
        server.setErrorHandler((error, _request, reply) => {
            const err = error;
            if (err.validation) {
                return reply.status(400).send({
                    error: 'Validation Error',
                    message: err.message,
                    statusCode: 400,
                });
            }
            const statusCode = err.statusCode ?? 500;
            return reply.status(statusCode).send({
                error: statusCode >= 500 ? 'Internal Server Error' : err.message,
                statusCode,
            });
        });
        server.setNotFoundHandler((_request, reply) => {
            reply.status(404).send({
                error: 'Not Found',
                message: 'Route not found',
                statusCode: 404,
            });
        });
        await server.listen({ port: 0, host: '127.0.0.1' });
    });
    (0, node_test_1.after)(async () => {
        await server.close();
    });
    (0, node_test_1.it)('server boots and health route returns 200', async () => {
        const res = await server.inject({ method: 'GET', url: '/health' });
        strict_1.default.strictEqual(res.statusCode, 200);
        strict_1.default.strictEqual(JSON.parse(res.body).status, 'ok');
    });
    (0, node_test_1.it)('helmet security headers are present', async () => {
        const res = await server.inject({ method: 'GET', url: '/health' });
        strict_1.default.ok(res.headers['x-content-type-options']);
        strict_1.default.ok(res.headers['x-frame-options']);
        strict_1.default.ok(res.headers['strict-transport-security']);
    });
    (0, node_test_1.it)('preHandler hook rejects unauthenticated requests (401)', async () => {
        const res = await server.inject({ method: 'GET', url: '/protected' });
        strict_1.default.strictEqual(res.statusCode, 401);
        strict_1.default.strictEqual(JSON.parse(res.body).error, 'Unauthorized');
    });
    (0, node_test_1.it)('preHandler hook accepts authenticated requests (200)', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/protected',
            headers: { authorization: 'Bearer test-token' },
        });
        strict_1.default.strictEqual(res.statusCode, 200);
        strict_1.default.strictEqual(JSON.parse(res.body).ok, true);
    });
    (0, node_test_1.it)('404 handler returns not found', async () => {
        const res = await server.inject({ method: 'GET', url: '/nonexistent-route' });
        strict_1.default.strictEqual(res.statusCode, 404);
        strict_1.default.strictEqual(JSON.parse(res.body).error, 'Not Found');
    });
    (0, node_test_1.it)('rate-limit kicks in after max requests (429)', async () => {
        // max is 5 per minute — send 6 requests to /health (a real route)
        // Use a fixed remoteAddress so they share the same rate-limit bucket
        const results = [];
        for (let i = 0; i < 6; i++) {
            results.push(await server.inject({
                method: 'GET',
                url: '/health',
                remoteAddress: '10.0.0.99',
            }));
        }
        // First 5 should be 200, 6th should be 429
        strict_1.default.strictEqual(results[0].statusCode, 200);
        strict_1.default.strictEqual(results[4].statusCode, 200);
        strict_1.default.strictEqual(results[5].statusCode, 429);
    });
});
//# sourceMappingURL=fastify-v5-smoke.test.js.map