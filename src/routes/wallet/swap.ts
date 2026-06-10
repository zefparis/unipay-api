import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { notify } from '../../utils/push';

const getFiatRate   = () => Number(env.FIAT_USD_CDF_RATE ?? '2850') || 2850;
const CGLT_PER_USDT = Number(process.env.CGLT_PER_USDT ?? '500') || 500;
const FEE_PCT       = 0.005; // 0.5% ratio (stored internally)
const FEE_DISPLAY   = FEE_PCT * 100; // 0.5 — sent to clients as percent

// All swap directions — pure ledger, no blockchain.
type SwapDirection =
  | 'cdf_to_cglt'  | 'cglt_to_cdf'
  | 'cdf_to_usd'   | 'usd_to_cdf'
  | 'cglt_to_usdt' | 'usdt_to_cglt'
  | 'usd_to_usdt'  | 'usdt_to_usd';

interface SwapBody {
  direction: SwapDirection;
  amount: number;
}

const walletSwapRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/wallet/swap/rate ─── all pair rates ─── */
  fastify.get('/wallet/swap/rate', async (_request, reply) => {
    const fiatRate = getFiatRate();
    return reply.send({
      rate:   CGLT_PER_USDT,    // backward-compat: CGLT/USDT rate
      fee:    FEE_DISPLAY,       // 0.5 (percent)
      paused: false,
      pairs: {
        CDF_CGLT:  { rate: 1,             fee: 0,           direction: 'both' },
        CDF_USD:   { rate: fiatRate,       fee: FEE_DISPLAY, direction: 'both' },
        CGLT_USDT: { rate: CGLT_PER_USDT, fee: FEE_DISPLAY, direction: 'both' },
        USD_USDT:  { rate: 1,             fee: FEE_DISPLAY, direction: 'both' },
      },
    });
  });

  /* ── POST /v1/wallet/swap ── pure ledger, no blockchain ─── */
  fastify.post<{ Body: SwapBody }>(
    '/wallet/swap',
    {
      schema: {
        body: {
          type: 'object',
          required: ['direction', 'amount'],
          properties: {
            direction: {
              type: 'string',
              enum: ['cdf_to_cglt', 'cglt_to_cdf', 'cdf_to_usd', 'usd_to_cdf',
                     'cglt_to_usdt', 'usdt_to_cglt', 'usd_to_usdt', 'usdt_to_usd'],
            },
            amount: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const payload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { direction, amount } = request.body;
      if (!amount || amount <= 0) {
        return reply.status(400).send({ error: 'Invalid amount', statusCode: 400 });
      }

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, lang, is_active, balance_cdf, cglt_balance, usdt_balance, usd_balance')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet)          return reply.status(404).send({ error: 'Wallet not found',      statusCode: 404 });
      if (!wallet.is_active) return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });

      const cdfBal  = Number(wallet.balance_cdf ?? 0);
      const cgltBal = Number(wallet.cglt_balance ?? 0);
      const usdtBal = Number(wallet.usdt_balance ?? 0);
      const usdBal  = Number(wallet.usd_balance  ?? 0);

      // ── Compute debit/credit params per direction ───────────
      let debitCol:  string;
      let creditCol: string;
      let debitBal:  number;
      let amountOut: number;
      let feeAmt:    number;
      let fromSym:   string;
      let toSym:     string;

      switch (direction) {
        // CDF ↔ CGLT — 1:1, 0% fee
        case 'cdf_to_cglt':
          debitCol = 'balance_cdf'; creditCol = 'cglt_balance'; debitBal = cdfBal;
          feeAmt = 0; amountOut = amount;
          fromSym = 'CDF'; toSym = 'CGLT';
          break;
        case 'cglt_to_cdf':
          debitCol = 'cglt_balance'; creditCol = 'balance_cdf'; debitBal = cgltBal;
          feeAmt = 0; amountOut = amount;
          fromSym = 'CGLT'; toSym = 'CDF';
          break;
        // USD ↔ CDF — market rate, 0.5% fee on the OUT amount
        case 'usd_to_cdf': {
          const r = getFiatRate();
          debitCol = 'usd_balance'; creditCol = 'balance_cdf'; debitBal = usdBal;
          feeAmt   = Math.round(amount * FEE_PCT * 1e6) / 1e6;
          amountOut = Math.round((amount - feeAmt) * r * 100) / 100;
          fromSym = 'USD'; toSym = 'CDF';
          break;
        }
        case 'cdf_to_usd': {
          const r = getFiatRate();
          debitCol = 'balance_cdf'; creditCol = 'usd_balance'; debitBal = cdfBal;
          const gross = amount / r;
          feeAmt   = Math.round(gross * FEE_PCT * 1e6) / 1e6;
          amountOut = Math.round((gross - feeAmt) * 1e6) / 1e6;
          fromSym = 'CDF'; toSym = 'USD';
          break;
        }
        // CGLT ↔ USDT — rate CGLT_PER_USDT, 0.5% fee
        case 'cglt_to_usdt': {
          const gross = amount / CGLT_PER_USDT;
          debitCol = 'cglt_balance'; creditCol = 'usdt_balance'; debitBal = cgltBal;
          feeAmt   = Math.round(gross * FEE_PCT * 1e6) / 1e6;
          amountOut = Math.round((gross - feeAmt) * 1e6) / 1e6;
          fromSym = 'CGLT'; toSym = 'USDT';
          break;
        }
        case 'usdt_to_cglt': {
          debitCol = 'usdt_balance'; creditCol = 'cglt_balance'; debitBal = usdtBal;
          feeAmt   = Math.round(amount * FEE_PCT * 1e6) / 1e6;
          amountOut = Math.round((amount - feeAmt) * CGLT_PER_USDT * 100) / 100;
          fromSym = 'USDT'; toSym = 'CGLT';
          break;
        }
        // USD ↔ USDT — 1:1, 0.5% fee
        case 'usd_to_usdt':
          debitCol = 'usd_balance'; creditCol = 'usdt_balance'; debitBal = usdBal;
          feeAmt   = Math.round(amount * FEE_PCT * 1e6) / 1e6;
          amountOut = Math.round((amount - feeAmt) * 1e6) / 1e6;
          fromSym = 'USD'; toSym = 'USDT';
          break;
        case 'usdt_to_usd':
          debitCol = 'usdt_balance'; creditCol = 'usd_balance'; debitBal = usdtBal;
          feeAmt   = Math.round(amount * FEE_PCT * 1e6) / 1e6;
          amountOut = Math.round((amount - feeAmt) * 1e6) / 1e6;
          fromSym = 'USDT'; toSym = 'USD';
          break;
        default:
          return reply.status(400).send({ error: 'Invalid direction', statusCode: 400 });
      }

      // ── Balance check (pre-flight) ────────────────────────────
      if (debitBal < amount) {
        return reply.status(402).send({
          error:      `Insufficient ${fromSym} balance`,
          available:  debitBal,
          required:   amount,
          statusCode: 402,
        });
      }

      // ── Atomic DB swap via RPC ────────────────────────────────
      const { error: rpcErr } = await fastify.supabase.rpc('swap_balances', {
        p_user_id:       wallet.id,
        p_debit_col:     debitCol,
        p_credit_col:    creditCol,
        p_debit_amount:  amount,
        p_credit_amount: amountOut,
        p_fee:           feeAmt,
      });

      if (rpcErr) {
        fastify.log.error({ rpcErr, walletId: wallet.id, direction, amount }, '[swap] rpc error');
        if ((rpcErr.message ?? '').includes('INSUFFICIENT_BALANCE')) {
          return reply.status(402).send({ error: 'Insufficient balance', statusCode: 402 });
        }
        return reply.status(500).send({ error: 'Swap failed', statusCode: 500 });
      }

      // ── New balances (computed, no extra DB round-trip) ───────
      const newCdfBal  = debitCol === 'balance_cdf'  ? Math.max(cdfBal  - amount, 0) : (creditCol === 'balance_cdf'  ? cdfBal  + amountOut : cdfBal);
      const newCgltBal = debitCol === 'cglt_balance'  ? Math.max(cgltBal - amount, 0) : (creditCol === 'cglt_balance'  ? cgltBal + amountOut : cgltBal);
      const newUsdtBal = debitCol === 'usdt_balance'  ? Math.max(usdtBal - amount, 0) : (creditCol === 'usdt_balance'  ? usdtBal + amountOut : usdtBal);
      const newUsdBal  = debitCol === 'usd_balance'   ? Math.max(usdBal  - amount, 0) : (creditCol === 'usd_balance'   ? usdBal  + amountOut : usdBal);

      // ── Record transaction ────────────────────────────────────
      const txId      = crypto.randomUUID();
      const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;

      await fastify.supabase.from('transactions').insert({
        id:             txId,
        wallet_user_id: wallet.id,
        operator:       'internal_swap',
        direction:      'swap',
        amount,
        fee:            feeAmt,
        net_amount:     amountOut,
        currency:       fromSym,
        phone:          wallet.phone,
        reference,
        swap_direction: direction,
        status:         'success',
        metadata:       { source: 'wallet_swap', from: fromSym, to: toSym },
      });

      // ── Push notification (fire-and-forget) ───────────────────
      notify({
        userId:  wallet.id,
        type:    'swap',
        titleFr: '🔄 Conversion effectuée',
        titleEn: '🔄 Swap completed',
        bodyFr:  `${amount} ${fromSym} → ${amountOut} ${toSym}`,
        bodyEn:  `${amount} ${fromSym} → ${amountOut} ${toSym}`,
        data:    { from: fromSym, to: toSym, amount_sent: amount, amount_received: amountOut },
        lang:    (wallet.lang as string | undefined),
      }).catch(() => {});

      fastify.log.info(
        { walletId: wallet.id, direction, amount, amountOut, feeAmt },
        '[swap] completed',
      );

      return reply.status(201).send({
        success:         true,
        from:            fromSym,
        to:              toSym,
        amount_sent:     amount,
        amount_received: amountOut,
        fee:             feeAmt,
        amount_in:       amount,    // backward compat
        amount_out:      amountOut, // backward compat
        new_balances: {
          balance_cdf:  newCdfBal,
          cglt_balance: newCgltBal,
          usdt_balance: newUsdtBal,
          usd_balance:  newUsdBal,
        },
      });
    },
  );
};

export default walletSwapRoute;
