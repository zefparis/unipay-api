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
import merchantSupportRoute from './routes/merchant/support';
import merchantSettlementRoute from './routes/merchant/settlement';
import merchantProfileRoute from './routes/merchant/profile';
import merchantPartnerRoute from './routes/merchant/partner';
import adminPartnerRoute from './routes/admin/partner';
import merchantPasswordResetRoute from './routes/merchant/password-reset';
import adminKycRoute from './routes/admin/kyc';
import adminSettlementRoute from './routes/admin/settlements';
import adminActionLogRoute from './routes/admin/action-log';
import statusOperatorsRoute from './routes/status/operators';
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
import walletSupportRoute from './routes/wallet/support';
import walletReconcileRoute from './routes/admin/wallet-reconcile';
import walletInspectRoute from './routes/admin/wallet-inspect';
import adminWalletRoute from './routes/admin/wallet';
import adminMerchantsRoute from './routes/admin/merchants';
import adminSupportRoute from './routes/admin/support';
import wcgltSwapRoute from './routes/wallet/wcglt-swap';
import walletInternalRoute from './routes/wallet/internal';
import walletStripeRoute from './routes/wallet/stripe';
import walletTransakRoute from './routes/wallet/transak';
import walletCryptoDepositRoute from './routes/wallet/crypto-deposit';
import walletCryptoWithdrawRoute from './routes/wallet/crypto-withdraw';
import walletSensitiveSessionRoute from './routes/wallet/sensitive-session';
import adminHotwalletRoute from './routes/admin/hotwallet';
import adminTreasuryCryptoReceiptsRoute from './routes/admin/treasury-crypto-receipts';
import adminTreasuryCryptoAssetsRoute    from './routes/admin/treasury-crypto-assets';
import walletNotificationsRoute from './routes/wallet/notifications';
import adminDevExpensesRoute from './routes/admin/dev-expenses';
import adminCreditorsRoute from './routes/admin/creditors';
import adminQuotesRoute from './routes/admin/quotes';
import adminDevExpensesV4Route from './routes/admin/dev-expenses-v4';
import adminExpenseEntitiesRoute from './routes/admin/expense-entities';
import cgltHealthRoute from './routes/admin/cglt-health';
import adminOnchainReconciliationRoute from './routes/admin/onchain-reconciliation';
import { validateCgltConfig } from './config/cglt-config-validator';
import { trustedProxy, rateLimitKey } from './lib/client-ip';

export async function buildServer() {
  const server = Fastify({
    // Ne faire confiance qu'aux sauts privés : cloudflared tourne sur le
    // même hôte (socket 127.0.0.1) et l'entrée XFF ajoutée en queue par
    // Cloudflare est le premier saut non privé → req.ip = IP réelle du
    // client. Un X-Forwarded-For forgé en tête de chaîne est ignoré.
    // Les clients du BFF Vercel sont départagés par l'en-tête signé
    // (voir rateLimitKey dans lib/client-ip).
    trustProxy: trustedProxy,
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
    // IP signée du BFF quand elle est valide (les marchands via Vercel
    // ne partagent plus le compteur des IP de sortie Vercel), sinon
    // req.ip — déjà corrigée par trustProxy restreint aux sauts privés.
    // Jamais un en-tête client non vérifié (x-api-key) ici.
    keyGenerator: rateLimitKey,
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

  // Public operator status — no auth (public status page)
  // Enveloppe d'erreur uniforme : toute payload d'erreur (>=400) reçoit
  // statusCode si absent — cohérent avec errorResponses des routes.
  server.addHook('preSerialization', async (request, reply, payload) => {
    const p = payload as { error?: unknown; statusCode?: number } | null;
    if (reply.statusCode >= 400 && p && typeof p.error === 'string' && p.statusCode === undefined) {
      p.statusCode = reply.statusCode;
    }
    return payload;
  });

  server.register(statusOperatorsRoute);

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
      v1.register(merchantSupportRoute);
      v1.register(merchantSettlementRoute);
      v1.register(merchantProfileRoute);
      v1.register(merchantPartnerRoute);
      v1.register(adminPartnerRoute);
      v1.register(merchantPasswordResetRoute);
      v1.register(adminKycRoute);
      v1.register(adminSettlementRoute);
      v1.register(adminActionLogRoute);
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
      v1.register(walletSupportRoute);
      v1.register(walletReconcileRoute);
      v1.register(walletInspectRoute);
      v1.register(adminWalletRoute);
      v1.register(adminMerchantsRoute);
      v1.register(adminSupportRoute);
      v1.register(wcgltSwapRoute);
      v1.register(walletInternalRoute);
      v1.register(walletStripeRoute);
      v1.register(walletTransakRoute);
      v1.register(walletCryptoDepositRoute);
      v1.register(walletCryptoWithdrawRoute);
      v1.register(walletSensitiveSessionRoute);
      v1.register(adminHotwalletRoute);
      v1.register(adminTreasuryCryptoReceiptsRoute);
      v1.register(adminTreasuryCryptoAssetsRoute);
      v1.register(walletNotificationsRoute);
      v1.register(adminCreditorsRoute);
      v1.register(adminQuotesRoute);
      v1.register(adminDevExpensesRoute);
      v1.register(adminDevExpensesV4Route);
      v1.register(adminExpenseEntitiesRoute);
      v1.register(cgltHealthRoute);
      v1.register(adminOnchainReconciliationRoute);
    },
    { prefix: '/v1' },
  );

  /* ──────────────────────────────────────────────────────────────────────────
   * GET /dev-expenses/report/:token — PUBLIC, token-protected, rate-limited.
   * Registered without /v1 prefix so the public page can call it directly.
   * CORS: DEV_EXPENSES_PUBLIC_ORIGIN is included in the global corsPlugin.
   * Note: admin routes from this plugin are also available at /admin/dev-expenses/*
   * (without /v1) in addition to /v1/admin/dev-expenses/* — both require admin auth.
   * ────────────────────────────────────────────────────────────────────────── */
  await server.register(adminDevExpensesRoute);

  // CGLT blockchain config validation — non-blocking, forces disabled on failure
  void validateCgltConfig(server.log).catch((err) => {
    server.log.error({ err }, '[CGLT_CONFIG_INVALID] Validation failed to run');
  });

  // Global error handler
  server.setErrorHandler((error: Error, request, reply) => {
    const err = error as Error & { validation?: unknown; statusCode?: number };
    if (err.validation) {
      server.log.warn({ url: request.url, validation: err.validation }, 'Validation error');
      return reply.status(400).send({
        error: 'Validation Error',
        message: err.message,
        statusCode: 400,
      });
    }

    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 500) {
      server.log.error({ err: err, reqId: request.id }, 'Server error');
    } else {
      server.log.warn({ statusCode, url: request.url }, err.message);
    }

    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : err.message,
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
