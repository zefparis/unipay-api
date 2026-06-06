import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
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
import merchantRegisterRoute from './routes/merchant/register';
import merchantLoginRoute from './routes/merchant/login';
import merchantTransactionsRoute from './routes/merchant/transactions';
import merchantBalanceRoute from './routes/merchant/balance';
import merchantApikeyRoute from './routes/merchant/apikey';
import merchantWebhookRoute from './routes/merchant/webhook';
import merchantKycRoute from './routes/merchant/kyc';
import merchantModeRoute from './routes/merchant/mode';
import adminKycRoute from './routes/admin/kyc';
import walletAuthRoute from './routes/wallet/auth';
import walletBalanceRoute from './routes/wallet/balance';
import walletDepositRoute from './routes/wallet/deposit';
import walletWithdrawRoute from './routes/wallet/withdraw';
import walletTransactionsRoute from './routes/wallet/transactions';
import walletP2PRoute from './routes/wallet/p2p';
import walletReconcileRoute from './routes/admin/wallet-reconcile';

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
    genReqId: () => crypto.randomUUID(),
    ajv: {
      customOptions: {
        coerceTypes: 'array',
        useDefaults: true,
        removeAdditional: true,
      },
    },
  });

  // Body size limit — 64KB max
  server.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 65536 }, (req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Rate limiting
  await server.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.headers['x-api-key'] as string) ?? req.ip,
    errorResponseBuilder: () => ({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded, retry after 1 minute',
      statusCode: 429,
    }),
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
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok',
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
      v1.register(merchantRegisterRoute);
      v1.register(merchantLoginRoute);
      v1.register(merchantTransactionsRoute);
      v1.register(merchantBalanceRoute);
      v1.register(merchantApikeyRoute);
      v1.register(merchantWebhookRoute);
      v1.register(merchantKycRoute);
      v1.register(merchantModeRoute);
      v1.register(adminKycRoute);
      v1.register(walletAuthRoute);
      v1.register(walletBalanceRoute);
      v1.register(walletDepositRoute);
      v1.register(walletWithdrawRoute);
      v1.register(walletTransactionsRoute);
      v1.register(walletP2PRoute);
      v1.register(walletReconcileRoute);
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
