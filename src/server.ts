import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { randomUUID } from 'crypto';
import { env } from './config/env';

import corsPlugin from './plugins/cors';
import supabasePlugin from './plugins/supabase';
import hmacPlugin from './plugins/hmac';

import paymentInitiateRoute from './routes/payment/initiate';
import paymentCallbackRoute from './routes/payment/callback';
import paymentStatusRoute from './routes/payment/status';
import operatorAuthRoute from './routes/operator/auth';
import operatorBalanceRoute from './routes/operator/balance';
import adminTransactionsRoute from './routes/admin/transactions';

export async function buildServer() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      ...(env.NODE_ENV !== 'production' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }),
    },
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        useDefaults: true,
        removeAdditional: true,
      },
    },
  });

  // Security headers
  await server.register(helmet, { global: true });

  // Core plugins (order matters — supabase before hmac)
  await server.register(corsPlugin);
  await server.register(supabasePlugin);
  await server.register(hmacPlugin);

  // Health check — public, no auth
  server.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              version: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    }),
  );

  // Versioned routes
  await server.register(
    async (v1) => {
      v1.register(paymentInitiateRoute);
      v1.register(paymentCallbackRoute);
      v1.register(paymentStatusRoute);
      v1.register(operatorAuthRoute);
      v1.register(operatorBalanceRoute);
      v1.register(adminTransactionsRoute);
    },
    { prefix: '/v1' },
  );

  // Global error handler
  server.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      server.log.warn({ url: request.url, validation: error.validation }, 'Validation error');
      return reply.status(400).send({
        error: 'Validation Error',
        message: error.message,
        statusCode: 400,
      });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      server.log.error({ err: error, reqId: request.id }, 'Server error');
    } else {
      server.log.warn({ statusCode, url: request.url }, error.message);
    }

    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  // 404 handler
  server.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });

  return server;
}
