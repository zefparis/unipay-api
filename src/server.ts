import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
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
import walletSwapRoute from './routes/wallet/swap';
import cgltGamingRoute from './routes/wallet/cglt-gaming';
import walletUnipesaRoute from './routes/wallet/unipesa';
import walletTransactionsRoute from './routes/wallet/transactions';
import walletP2PRoute from './routes/wallet/p2p';
import walletProfileRoute from './routes/wallet/profile';
import walletKycRoute from './routes/wallet/kyc';
import walletReconcileRoute from './routes/admin/wallet-reconcile';
import walletInspectRoute from './routes/admin/wallet-inspect';
import adminWalletRoute from './routes/admin/wallet';
import wcgltSwapRoute from './routes/wallet/wcglt-swap';
import walletInternalRoute from './routes/wallet/internal';
import walletStripeRoute from './routes/wallet/stripe';
import walletTransakRoute from './routes/wallet/transak';
import walletCryptoDepositRoute from './routes/wallet/crypto-deposit';
import walletCryptoWithdrawRoute from './routes/wallet/crypto-withdraw';
import adminBinanceRoute from './routes/admin/binance';
import adminHotwalletRoute from './routes/admin/hotwallet';
import adminTreasuryCryptoReceiptsRoute from './routes/admin/treasury-crypto-receipts';
import adminTreasuryCryptoAssetsRoute    from './routes/admin/treasury-crypto-assets';
import walletNotificationsRoute from './routes/wallet/notifications';
import adiDepositRoute from './routes/wallet/adi-deposit';

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
      const str = (body as string).trim();
      done(null, str ? JSON.parse(str) : {});
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

  // Multipart (for KYC document uploads)
  await server.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 3 } });

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
      v1.register(cgltGamingRoute);
      v1.register(walletUnipesaRoute);
      v1.register(walletSwapRoute);
      v1.register(walletWithdrawRoute);
      v1.register(walletTransactionsRoute);
      v1.register(walletP2PRoute);
      v1.register(walletProfileRoute);
      v1.register(walletKycRoute);
      v1.register(walletReconcileRoute);
      v1.register(walletInspectRoute);
      v1.register(adminWalletRoute);
      v1.register(wcgltSwapRoute);
      v1.register(walletInternalRoute);
      v1.register(walletStripeRoute);
      v1.register(walletTransakRoute);
      v1.register(walletCryptoDepositRoute);
      v1.register(walletCryptoWithdrawRoute);
      v1.register(adminBinanceRoute);
      v1.register(adminHotwalletRoute);
      v1.register(adminTreasuryCryptoReceiptsRoute);
      v1.register(adminTreasuryCryptoAssetsRoute);
      v1.register(walletNotificationsRoute);
      v1.register(adiDepositRoute);
    },
    { prefix: '/v1' },
  );

  /* ──────────────────────────────────────────────────────────────────────────
   * GET /api/predictstreet/users/:provider_user_id/limits
   * Server-to-server. Auth: Bearer PS_LIMITS_BEARER_TOKEN.
   * Queries user_limits, converts CDF → USD (÷ 3 600), falls back to defaults.
   * ────────────────────────────────────────────────────────────────────────── */
  server.get<{ Params: { provider_user_id: string } }>(
    '/api/predictstreet/users/:provider_user_id/limits',
    async (req, reply) => {
      const token = env.PREDICTSTREET_BEARER_TOKEN;
      if (!token) return reply.code(503).send({ error: 'Limits API not configured' });

      // Constant-time bearer token comparison
      const provided = req.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      const maxLen = Math.max(provided.length, expected.length);
      const a = Buffer.from(provided.padEnd(maxLen));
      const b = Buffer.from(expected.padEnd(maxLen));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const { provider_user_id } = req.params;

      const DEFAULTS = {
        deposit_limit_cdf:      180_000,
        deposit_consumed_cdf:   0,
        trade_limit_cdf:        720_000,
        trade_consumed_cdf:     0,
        withdrawal_limit_cdf:   180_000,
        withdrawal_consumed_cdf: 0,
        kyc_status:             'not_started',
      };

      const { data } = await server.supabase
        .from('user_limits')
        .select('deposit_limit_cdf,deposit_consumed_cdf,trade_limit_cdf,trade_consumed_cdf,withdrawal_limit_cdf,withdrawal_consumed_cdf,kyc_status')
        .eq('user_id', provider_user_id)
        .maybeSingle();

      const row = data ?? DEFAULTS;
      const toUsd = (cdf: number) => Math.round((cdf / 3600) * 100) / 100;

      return reply.send({
        deposit_limit:         toUsd(Number(row.deposit_limit_cdf      ?? DEFAULTS.deposit_limit_cdf)),
        deposit_consumed:      toUsd(Number(row.deposit_consumed_cdf    ?? DEFAULTS.deposit_consumed_cdf)),
        trade_limit:           toUsd(Number(row.trade_limit_cdf         ?? DEFAULTS.trade_limit_cdf)),
        trade_consumed:        toUsd(Number(row.trade_consumed_cdf      ?? DEFAULTS.trade_consumed_cdf)),
        withdrawal_limit:      toUsd(Number(row.withdrawal_limit_cdf    ?? DEFAULTS.withdrawal_limit_cdf)),
        withdrawal_consumed:   toUsd(Number(row.withdrawal_consumed_cdf ?? DEFAULTS.withdrawal_consumed_cdf)),
        eligible:              (row.kyc_status ?? DEFAULTS.kyc_status) === 'verified',
        kyc_status:            row.kyc_status ?? DEFAULTS.kyc_status,
        currency:              'USD',
      });
    },
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
