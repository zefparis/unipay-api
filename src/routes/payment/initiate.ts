import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { getProviderService } from '../../services/index';
import { sandboxCollection, sandboxPayout, getBalance } from '../../services/avada';
import type { Channel, Direction } from '../../types/payment';
import { env } from '../../config/env';
import { isSandboxAllowed } from '../../lib/sandbox-mode';
import { isValidDrcPhone, validatePhoneOperatorMatch } from '../../lib/phone-normalization';

const FEE_RATE = Number(env.MERCHANT_FEE_RATE); // 5% default (configurable via MERCHANT_FEE_RATE env var)

// ── Provider error classification ────────────────────────────
// Parses the error message thrown by avada.ts to classify it as a
// provider outage (upstream API unreachable) vs a client/unknown
// error, and extracts the provider code + message when available.
// Mirrors the logic in lib/provider-outage.ts but works on Error
// objects at initiation time (before metadata is stored).
const PROVIDER_OUTAGE_CODES = new Set([10301, 10201]);

interface ClassifiedError {
  kind: 'provider_outage' | 'client_error' | 'unknown';
  provider_code?: string | number;
  provider_message?: string;
  raw_message: string;
}

function classifyProviderError(err: unknown): ClassifiedError {
  const raw = err instanceof Error ? err.message : String(err);
  // "Unipesa provider error: code=10301 message=..."
  const codeMatch = raw.match(/code=(\S+)\s+message=(.*)/);
  if (codeMatch) {
    const code = codeMatch[1];
    const message = codeMatch[2];
    const numCode = Number(code);
    const isOutage = PROVIDER_OUTAGE_CODES.has(numCode) ||
      /get token error|API unreachable|provider.*unavailable/i.test(message);
    return {
      kind: isOutage ? 'provider_outage' : 'client_error',
      provider_code: code,
      provider_message: message,
      raw_message: raw,
    };
  }
  // "Unipesa HTTP 5xx: ..." or "FIXIE_PROXY_REQUIRED: ..."
  if (/Unipesa HTTP 5\d\d|FIXIE_PROXY_REQUIRED|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(raw)) {
    return { kind: 'provider_outage', raw_message: raw };
  }
  // "Unipesa provider did not create a transaction: ..."
  const noTxMatch = raw.match(/did not create a transaction: (.*)/);
  if (noTxMatch) {
    return { kind: 'client_error', provider_message: noTxMatch[1], raw_message: raw };
  }
  return { kind: 'unknown', raw_message: raw };
}

interface InitiateBody {
  operator: Channel;
  direction: Direction;
  amount: number;
  currency: string;
  phone: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

const initiateRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: InitiateBody }>(
    '/payment/initiate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['operator', 'direction', 'amount', 'currency', 'phone'],
          properties: {
            operator: { type: 'string', enum: ['orange', 'airtel', 'afrimoney', 'usdt'] },
            direction: { type: 'string', enum: ['collect', 'payout'] },
            amount: { type: 'number', minimum: 1 },
            currency: { type: 'string', enum: ['CDF', 'USD', 'USDT'] },
            phone: { type: 'string', pattern: '^\\+?[1-9]\\d{7,14}$' },
            reference: { type: 'string', maxLength: 128 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              transaction_id: { type: 'string' },
              status: { type: 'string' },
              amount: { type: 'number' },
              fee: { type: 'number' },
              net_amount: { type: 'number' },
              currency: { type: 'string' },
              idempotent: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { operator, direction, amount, currency, phone, reference, metadata } = request.body;
      const merchantId = request.operatorId;

      // ── Currency ↔ operator validation ────────────────────────
      // USDT operator must use USDT currency; Mobile Money operators
      // (orange/airtel/afrimoney) accept CDF or USD.
      if (operator === 'usdt' && currency !== 'USDT') {
        return reply.status(400).send({
          error: 'INVALID_CURRENCY',
          message: "L'opérateur USDT nécessite currency: 'USDT'",
          statusCode: 400,
        });
      }
      if (operator !== 'usdt' && currency === 'USDT') {
        return reply.status(400).send({
          error: 'INVALID_CURRENCY',
          message: "USDT n'est supporté qu'avec l'opérateur 'usdt'",
          statusCode: 400,
        });
      }

      // ── Phone validation (reject before hitting provider) ──────
      // USDT doesn't use a phone number, skip validation for it
      if (operator !== 'usdt' && !isValidDrcPhone(phone)) {
        return reply.status(400).send({
          error: 'INVALID_PHONE',
          message: 'Numéro invalide : 9 chiffres significatifs requis (ex: +243XXXXXXXXX, 0XXXXXXXXX, ou XXXXXXXXX)',
          statusCode: 400,
        });
      }

      // ── Phone-operator match (payout only) ─────────────────────
      // For payouts (B2C), the destination operator must own the phone
      // number. A mismatch causes the operator to reject with MSISDN
      // INCORRECT (code 10401). Detect early to avoid a doomed round-trip.
      if (operator !== 'usdt' && direction === 'payout') {
        const phoneOpCheck = validatePhoneOperatorMatch(phone, operator);
        if (!phoneOpCheck.ok) {
          return reply.status(400).send({
            error: 'OPERATOR_PHONE_MISMATCH',
            message: phoneOpCheck.message,
            detected_operator: phoneOpCheck.detected,
            statusCode: 400,
          });
        }
      }

      // ── Sandbox detection ──────────────────────────────────────
      let isSandbox = isSandboxAllowed(env.NODE_ENV, request.headers['x-unipay-mode']);
      if (!isSandbox) {
        const { data: mData } = await fastify.supabase
          .from('merchants')
          .select('mode')
          .eq('id', merchantId)
          .maybeSingle();
        isSandbox = mData?.mode === 'sandbox';
      }

      const fee = Math.round(amount * FEE_RATE * 100) / 100;
      const net_amount = Math.round((amount - fee) * 100) / 100;
      const transactionId = crypto.randomUUID();
      const resolvedReference = reference ?? `TXN-${transactionId.slice(0, 8).toUpperCase()}`;

      // ── Idempotency check (M9) ──────────────────────────────────
      // If the merchant provided an explicit reference, check whether
      // a transaction with the same (merchant_id, reference) already
      // exists. This prevents accidental duplicates from network
      // retries and deliberate collision attacks on the callback
      // lookup (which uses reference as a fallback key).
      //
      // - Non-terminal (pending/processing): return the existing
      //   transaction — true idempotent behavior for a POST that may
      //   be replayed by the client after a network timeout.
      // - Terminal (success/failed/cancelled): reject with
      //   DUPLICATE_REFERENCE — the merchant must use a new reference.
      //
      // Auto-generated references (reference === undefined) are always
      // unique by construction (UUID-based) and skip this check.
      if (reference !== undefined) {
        const { data: existingTx, error: lookupErr } = await fastify.supabase
          .from('transactions')
          .select('id, status, amount, fee, net_amount, currency, direction, operator')
          .eq('merchant_id', merchantId)
          .eq('reference', resolvedReference)
          .maybeSingle();

        if (lookupErr) {
          fastify.log.error({ err: lookupErr, merchantId, reference: resolvedReference }, '[initiate] Idempotency lookup failed');
          return reply.status(500).send({ error: 'Failed to check transaction idempotency', statusCode: 500 });
        }

        if (existingTx) {
          if (existingTx.status === 'pending' || existingTx.status === 'processing') {
            // Idempotent return — same transaction, still in flight
            fastify.log.info({ merchantId, reference: resolvedReference, existingTxId: existingTx.id }, '[initiate] Idempotent replay — returning existing transaction');
            return reply.status(201).send({
              transaction_id: existingTx.id,
              status: existingTx.status,
              amount: Number(existingTx.amount),
              fee: Number(existingTx.fee),
              net_amount: Number(existingTx.net_amount),
              currency: existingTx.currency,
              idempotent: true,
            });
          }
          // Terminal — reject
          return reply.status(409).send({
            error: 'DUPLICATE_REFERENCE',
            message: `A transaction with reference '${resolvedReference}' already exists with status '${existingTx.status}'. Use a different reference.`,
            existing_transaction_id: existingTx.id,
            existing_status: existingTx.status,
            statusCode: 409,
          });
        }
      }

      // ── Pre-flight Avada balance check (payout only) ───────────
      // For payouts (B2C), the Unipesa merchant account must have
      // sufficient balance to send the funds. Checking beforehand
      // avoids a doomed round-trip and gives the merchant a clear
      // error instead of a generic "Provider service unavailable".
      // For collects (C2B), the merchant's Avada balance is not
      // relevant (the customer's balance is) — skip the check.
      if (!isSandbox && operator !== 'usdt' && direction === 'payout' && currency === 'CDF') {
        try {
          const avadaBalance = await getBalance();
          if (avadaBalance.balance < amount) {
            return reply.status(503).send({
              error: 'INSUFFICIENT_PROVIDER_BALANCE',
              message: `Solde momentanément indisponible : le solde Avada (${avadaBalance.balance} CDF) est insuffisant pour ce paiement de ${amount} CDF. Veuillez réessayer dans un instant.`,
              provider_balance: avadaBalance.balance,
              required: amount,
              currency,
              statusCode: 503,
            });
          }
        } catch (balanceErr) {
          // Balance check itself failed — don't block the transaction,
          // just log. The provider call may still succeed.
          fastify.log.warn({ err: balanceErr, merchantId }, '[initiate] Pre-flight balance check failed — proceeding anyway');
        }
      }

      // ── Merchant ledger debit (payout only, live mode) ─────────
      // Atomically debit the merchant's ledger before calling the
      // provider. This ensures the merchant has sufficient balance
      // (from their own collects) and prevents draining the global
      // Unipesa treasury. The debit is re-credited on failure (either
      // immediately in the catch block below, or later via the
      // callback RPC process_wallet_provider_callback).
      //
      // Sandbox mode skips this — sandbox transactions don't use real
      // money and the merchant ledger is not affected.
      if (!isSandbox && direction === 'payout') {
        try {
          const { error: debitError } = await fastify.supabase.rpc(
            'debit_merchant_for_payout',
            {
              p_merchant_id: merchantId,
              p_transaction_id: transactionId,
              p_amount: amount,
              p_currency: currency,
            },
          );

          if (debitError) {
            // Classify the error for a clear response
            if (debitError.message.includes('KYC_REQUIRED_FOR_PAYOUT')) {
              return reply.status(403).send({
                error: 'KYC_REQUIRED_FOR_PAYOUT',
                message: 'KYC validation required before initiating payouts. Contact support to validate your account.',
                statusCode: 403,
              });
            }
            if (debitError.message.includes('INSUFFICIENT_MERCHANT_BALANCE')) {
              const match = debitError.message.match(/available ([\d.]+), requested ([\d.]+)/);
              return reply.status(402).send({
                error: 'INSUFFICIENT_MERCHANT_BALANCE',
                message: `Solde marchand insuffisant pour ce payout. Disponible: ${match?.[1] ?? '?'} ${currency}, demandé: ${amount} ${currency}.`,
                available: match ? Number(match[1]) : undefined,
                required: amount,
                currency,
                statusCode: 402,
              });
            }
            fastify.log.error({ err: debitError, merchantId, transactionId }, '[initiate] Merchant ledger debit failed');
            return reply.status(500).send({ error: 'Failed to debit merchant balance', statusCode: 500 });
          }

          fastify.log.info({ merchantId, transactionId, amount, currency }, '[initiate] Merchant ledger debited for payout');
        } catch (debitErr) {
          fastify.log.error({ err: debitErr, merchantId, transactionId }, '[initiate] debit_merchant_for_payout RPC threw');
          return reply.status(500).send({ error: 'Failed to debit merchant balance', statusCode: 500 });
        }
      }

      // ── Sandbox path: mock, persist as success, return immediately ──
      if (isSandbox) {
        const mockRef = direction === 'collect'
          ? sandboxCollection(amount).avada_transaction_id
          : sandboxPayout(amount).avada_transaction_id;

        await fastify.supabase.from('transactions').insert({
          id: transactionId,
          merchant_id: merchantId,
          operator,
          direction,
          amount,
          fee,
          net_amount,
          currency,
          phone,
          reference: resolvedReference,
          avada_transaction_id: mockRef,
          status: 'success',
          metadata: { ...(metadata ?? {}), sandbox: true },
        });

        fastify.log.info({ transactionId, merchantId, isSandbox: true }, 'Sandbox transaction');
        return reply.status(201).send({
          transaction_id: transactionId,
          status: 'success',
          amount,
          fee,
          net_amount,
          currency,
          sandbox: true,
        });
      }

      // ── Live path ──────────────────────────────────────────────
      // 1. Persist transaction as pending
      const { error: insertError } = await fastify.supabase
        .from('transactions')
        .insert({
          id: transactionId,
          merchant_id: merchantId,
          operator,
          direction,
          amount,
          fee,
          net_amount,
          currency,
          phone,
          reference: resolvedReference,
          status: 'pending',
          metadata: metadata ?? {},
        });

      if (insertError) {
        fastify.log.error({ err: insertError, transactionId }, 'DB insert failed');
        return reply.status(500).send({ error: 'Failed to create transaction', statusCode: 500 });
      }

      // 2. Call provider service
      const service = getProviderService(operator);
      try {
        const providerRes = await service.initiatePayment({
          transaction_id: transactionId,
          amount,
          currency,
          phone,
          direction,
          reference: resolvedReference,
        });

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing', avada_transaction_id: providerRes.provider_ref })
          .eq('id', transactionId);

        return reply.status(201).send({
          transaction_id: transactionId,
          status: 'processing',
          amount,
          fee,
          net_amount,
          currency,
        });
      } catch (err) {
        const classified = classifyProviderError(err);
        fastify.log.error({ err, transactionId, operator, errorKind: classified.kind }, 'Provider error');

        // Store the error details in the transaction metadata so the
        // merchant can see WHY it failed (not just that it failed).
        // This mirrors the shape of callback-resolved failures
        // (metadata.provider_result.code / .message).
        const failureMetadata = {
          ...(metadata ?? {}),
          provider_result: {
            code: classified.provider_code ?? 'TF',
            message: classified.provider_message ?? classified.raw_message,
          },
          failure_kind: classified.kind,
          failed_at: 'initiation',
        };

        // ── Re-credit merchant ledger (payout only, live mode) ────
        // If we debited the merchant ledger before the provider call,
        // we must re-credit it now that the payout failed. The
        // recredit_merchant_payout RPC is idempotent — if the callback
        // already processed the failure, it returns without doing
        // anything (already_terminal guard).
        //
        // ⚠️ This MUST run BEFORE the direct status update below,
        // because the RPC checks `status IN ('success','failed','cancelled')`
        // and returns `already_terminal` if the transaction is already
        // terminal. If we mark it as 'failed' first, the RPC will
        // skip the re-credit.
        if (!isSandbox && direction === 'payout') {
          try {
            const { error: recreditError } = await fastify.supabase.rpc(
              'recredit_merchant_payout',
              {
                p_transaction_id: transactionId,
                p_reason: `Provider error at initiation: ${classified.kind}`,
              },
            );
            if (recreditError) {
              fastify.log.error({ err: recreditError, transactionId }, '[initiate] recredit_merchant_payout failed');
            }
          } catch (recreditErr) {
            fastify.log.error({ err: recreditErr, transactionId }, '[initiate] recredit_merchant_payout RPC threw');
          }
        }

        await fastify.supabase
          .from('transactions')
          .update({ status: 'failed', metadata: failureMetadata })
          .eq('id', transactionId);

        // Return a specific error message based on the failure kind.
        if (classified.kind === 'provider_outage') {
          return reply.status(503).send({
            error: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
            message: `L'opérateur ${operator} est momentanément indisponible. Veuillez réessayer dans quelques minutes.`,
            provider_code: classified.provider_code,
            transaction_id: transactionId,
            statusCode: 503,
          });
        }

        return reply.status(502).send({
          error: 'PROVIDER_REJECTED',
          message: classified.provider_message ?? 'Le paiement a été rejeté par l\'opérateur.',
          provider_code: classified.provider_code,
          transaction_id: transactionId,
          statusCode: 502,
        });
      }
    },
  );
};

export default initiateRoute;
