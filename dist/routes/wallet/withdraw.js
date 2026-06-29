"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
const index_1 = require("../../services/index");
const email_1 = require("../../services/email");
const push_1 = require("../../utils/push");
const avada_1 = require("../../services/avada");
const kyc_limits_1 = require("../../utils/kyc-limits");
const WALLET_OPERATORS = ['orange', 'airtel', 'afrimoney'];
const FEE_RATE = 0.03;
const walletWithdrawRoute = async (fastify) => {
    fastify.post('/wallet/withdraw', {
        schema: {
            body: {
                type: 'object',
                required: ['phone_mm', 'operator', 'amount'],
                properties: {
                    phone_mm: { type: 'string', pattern: '^\\+?[1-9]\\d{7,14}$' },
                    operator: { type: 'string', enum: WALLET_OPERATORS },
                    amount: { type: 'number', minimum: 100 },
                    currency: { type: 'string', minLength: 3, maxLength: 3, default: 'CDF' },
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
                        sandbox: { type: 'boolean' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const walletPayload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!walletPayload) {
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        }
        const { phone_mm, operator, amount, currency = 'CDF' } = request.body;
        const walletId = walletPayload.wallet_id;
        const normalizedPhone = phone_mm.replace(/\s/g, '');
        if (!/^\+243[0-9]{9}$/.test(normalizedPhone)) {
            return reply.status(400).send({
                error: 'INVALID_PHONE',
                message: 'Invalid DRC number. Required format: +243XXXXXXXXX (9 digits after +243)',
            });
        }
        // Fetch wallet with current balance
        const { data: wallet } = await fastify.supabase
            .from('wallet_users')
            .select('id, is_active, balance_cdf, kyc_level, blockchain_address, email, full_name, lang')
            .eq('id', walletId)
            .maybeSingle();
        if (!wallet?.is_active) {
            return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
        }
        // ── KYC daily withdrawal limit check ─────────────────
        const kycLevel = Number(wallet.kyc_level ?? 0);
        const limits = (0, kyc_limits_1.getLimits)(kycLevel);
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const { data: todayRows } = await fastify.supabase
            .from('transactions')
            .select('amount')
            .eq('wallet_user_id', walletId)
            .eq('direction', 'payout')
            .in('status', ['processing', 'success'])
            .gte('created_at', dayStart.toISOString());
        const dailyUsed = (todayRows ?? []).reduce((s, r) => s + Number(r.amount), 0);
        if (dailyUsed + amount > limits.withdraw_daily) {
            return reply.status(403).send({
                error: 'KYC_LIMIT_EXCEEDED',
                limit: limits.withdraw_daily,
                daily_used: dailyUsed,
                kyc_level: kycLevel,
                statusCode: 403,
            });
        }
        const fee = Math.round(amount * FEE_RATE * 100) / 100;
        const totalDeducted = Math.round((amount + fee) * 100) / 100;
        const netAmount = amount;
        const currentBalance = Number(wallet.balance_cdf ?? 0);
        if (currentBalance < totalDeducted) {
            return reply.status(402).send({
                error: 'Insufficient balance',
                balance_cdf: currentBalance,
                required_cdf: totalDeducted,
                statusCode: 402,
            });
        }
        const isSandbox = request.headers['x-unipay-mode'] === 'sandbox';
        const txId = node_crypto_1.default.randomUUID();
        const reference = `WW-${txId.slice(0, 8).toUpperCase()}`;
        // ── Deduct balance atomically via RPC ────────────────────
        const { error: debitError } = await fastify.supabase
            .rpc('wallet_debit', { p_user_id: walletId, p_amount: totalDeducted });
        if (debitError) {
            const isInsufficient = debitError.message?.includes('INSUFFICIENT_FUNDS');
            return reply.status(isInsufficient ? 402 : 500).send({
                error: isInsufficient ? 'Insufficient balance' : 'Debit failed',
                statusCode: isInsufficient ? 402 : 500,
            });
        }
        // ── Sandbox path ──────────────────────────────────────────
        if (isSandbox) {
            const mockRef = (0, avada_1.sandboxPayout)(amount).avada_transaction_id;
            await fastify.supabase.from('transactions').insert({
                id: txId,
                wallet_user_id: walletId,
                operator,
                direction: 'payout',
                amount,
                fee,
                net_amount: netAmount,
                currency,
                phone: normalizedPhone,
                reference,
                avada_transaction_id: mockRef,
                blockchain_tx_hash: null,
                status: 'success',
                metadata: { sandbox: true, source: 'wallet_withdraw' },
            });
            fastify.log.info({ txId, walletId, isSandbox: true }, 'Wallet withdraw (sandbox)');
            (0, push_1.notify)({
                userId: walletId, type: 'withdrawal',
                titleFr: '💸 Retrait effectué', titleEn: '💸 Withdrawal completed',
                bodyFr: `${amount} ${currency} envoyé vers ${normalizedPhone}`,
                bodyEn: `${amount} ${currency} sent to ${normalizedPhone}`,
                data: { amount, currency, phone: normalizedPhone, operator },
            }).catch(() => { });
            return reply.status(201).send({
                transaction_id: txId,
                status: 'success',
                amount,
                fee,
                net_amount: netAmount,
                currency,
                sandbox: true,
            });
        }
        // ── Live path ─────────────────────────────────────────────
        const { error: insertError } = await fastify.supabase
            .from('transactions')
            .insert({
            id: txId,
            wallet_user_id: walletId,
            operator,
            direction: 'payout',
            amount,
            fee,
            net_amount: netAmount,
            currency,
            phone: normalizedPhone,
            reference,
            blockchain_tx_hash: null,
            status: 'pending',
            metadata: { source: 'wallet_withdraw' },
        });
        if (insertError) {
            // Compensate — refund deducted balance
            await fastify.supabase
                .from('wallet_users')
                .update({ balance_cdf: currentBalance })
                .eq('id', walletId);
            fastify.log.error({ err: insertError, txId }, 'Wallet withdraw insert failed — balance refunded');
            return reply.status(500).send({ error: 'Failed to create withdrawal', statusCode: 500 });
        }
        // Call provider (payout to user's mobile money)
        const service = (0, index_1.getProviderService)(operator);
        try {
            const providerRes = await service.initiatePayment({
                transaction_id: txId,
                amount,
                currency,
                phone: normalizedPhone,
                direction: 'payout',
                reference,
            });
            await fastify.supabase
                .from('transactions')
                .update({ status: 'processing', avada_transaction_id: providerRes.provider_ref })
                .eq('id', txId);
            fastify.log.info({ txId, walletId, operator }, 'Wallet withdrawal initiated');
            const wUser = wallet;
            (0, push_1.notify)({
                userId: walletId, type: 'withdrawal',
                titleFr: '💸 Retrait en cours', titleEn: '💸 Withdrawal processing',
                bodyFr: `${amount} ${currency} — envoyé vers ${normalizedPhone} (${operator})`,
                bodyEn: `${amount} ${currency} — sent to ${normalizedPhone} (${operator})`,
                data: { amount, currency, phone: normalizedPhone, operator },
                lang: wUser?.lang,
            }).catch(() => { });
            if (wUser?.email) {
                (0, email_1.sendWalletWithdrawalEmail)({
                    to: wUser.email, name: wUser.full_name ?? '', amount: String(amount),
                    currency, phone: normalizedPhone, operator, txRef: reference,
                    lang: wUser.lang ?? 'fr',
                });
            }
            return reply.status(201).send({
                transaction_id: txId,
                status: 'processing',
                amount,
                fee,
                net_amount: netAmount,
                currency,
                sandbox: false,
            });
        }
        catch (err) {
            // Provider failed — refund balance and mark transaction failed
            fastify.log.error({ err, txId, operator }, 'Wallet withdraw provider error — refunding');
            await fastify.supabase
                .from('wallet_users')
                .update({ balance_cdf: currentBalance })
                .eq('id', walletId);
            await fastify.supabase
                .from('transactions')
                .update({ status: 'failed' })
                .eq('id', txId);
            return reply.status(502).send({ error: 'Provider service unavailable', statusCode: 502 });
        }
    });
};
exports.default = walletWithdrawRoute;
//# sourceMappingURL=withdraw.js.map