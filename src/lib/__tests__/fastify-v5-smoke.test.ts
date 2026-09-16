/**
 * Fastify v5 migration smoke test.
 *
 * Boots a minimal Fastify v5 server with the same plugins and configuration
 * patterns used in the real app (helmet, rate-limit, multipart, custom
 * content type parser, error handler, preHandler hook) to verify the
 * migration doesn't break the framework integration.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

describe('Fastify v5 migration smoke test', () => {
  let server: FastifyInstance;

  before(async () => {
    server = Fastify({
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

    server.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 65536 },
      (req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
        try {
          const str = body.trim();
          done(null, str ? JSON.parse(str) : {});
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    await server.register(rateLimit, {
      global: true,
      max: 5,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
      errorResponseBuilder: () => ({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded',
        statusCode: 429,
      }),
    });

    await server.register(helmet, { global: true });
    await server.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 3 } });

    // Health route — public, no auth
    server.get('/health', async () => ({ status: 'ok' }));

    // Protected routes — scoped sub-instance with preHandler hook
    await server.register(async (sub: FastifyInstance) => {
      sub.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) {
          return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        }
      });
      sub.get('/protected', async () => ({ ok: true }));
    });

    server.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
      const err = error as Error & { validation?: unknown; statusCode?: number };
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

    server.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(404).send({
        error: 'Not Found',
        message: 'Route not found',
        statusCode: 404,
      });
    });

    await server.listen({ port: 0, host: '127.0.0.1' });
  });

  after(async () => {
    await server.close();
  });

  it('server boots and health route returns 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).status, 'ok');
  });

  it('helmet security headers are present', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    assert.ok(res.headers['x-content-type-options']);
    assert.ok(res.headers['x-frame-options']);
    assert.ok(res.headers['strict-transport-security']);
  });

  it('preHandler hook rejects unauthenticated requests (401)', async () => {
    const res = await server.inject({ method: 'GET', url: '/protected' });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, 'Unauthorized');
  });

  it('preHandler hook accepts authenticated requests (200)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).ok, true);
  });

  it('404 handler returns not found', async () => {
    const res = await server.inject({ method: 'GET', url: '/nonexistent-route' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(JSON.parse(res.body).error, 'Not Found');
  });

  it('rate-limit kicks in after max requests (429)', async () => {
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
    assert.strictEqual(results[0].statusCode, 200);
    assert.strictEqual(results[4].statusCode, 200);
    assert.strictEqual(results[5].statusCode, 429);
  });
});
