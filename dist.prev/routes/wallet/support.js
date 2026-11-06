"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const support_bot_js_1 = require("../../services/support-bot.js");
const email_js_1 = require("../../services/email.js");
const wallet_auth_js_1 = require("../../lib/wallet-auth.js");
const walletSupportRoute = async (fastify) => {
    /* ── POST /v1/wallet/support/message ────────────────────────── */
    fastify.post('/wallet/support/message', {
        schema: {
            body: {
                type: 'object',
                required: ['message'],
                properties: {
                    conversation_id: { type: 'string', format: 'uuid' },
                    message: { type: 'string', minLength: 1, maxLength: 4000 },
                },
            },
        },
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 hour',
                keyGenerator: (req) => (0, wallet_auth_js_1.walletIdFromRequest)(req) || req.ip,
            },
        },
    }, async (request, reply) => {
        const auth = await (0, wallet_auth_js_1.requireActiveWallet)(request, fastify.supabase, 'id, phone, full_name, email, kyc_level, is_verified, is_active, balance_cdf, usd_balance, usdt_balance, cglt_balance');
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const walletUserId = auth.payload.wallet_id;
        const walletRow = auth.wallet;
        const { message, conversation_id } = request.body;
        // Find or create conversation — ALWAYS scoped to this wallet user
        let conversationId = conversation_id;
        if (conversationId) {
            // Verify ownership: conversation must belong to this wallet user
            const { data: conv, error: convError } = await fastify.supabase
                .from('support_conversations')
                .select('id, status, wallet_user_id')
                .eq('id', conversationId)
                .eq('wallet_user_id', walletUserId) // CRITICAL: prevents cross-user access
                .maybeSingle();
            if (convError || !conv) {
                return reply.status(404).send({ error: 'Conversation not found', statusCode: 404 });
            }
            if (conv.status === 'resolved') {
                return reply.status(400).send({ error: 'Conversation is resolved', statusCode: 400 });
            }
        }
        else {
            // Create new conversation
            const { data: newConv, error: createError } = await fastify.supabase
                .from('support_conversations')
                .insert({ wallet_user_id: walletUserId, status: 'open' })
                .select('id')
                .single();
            if (createError || !newConv) {
                fastify.log.error({ err: createError, walletUserId }, '[wallet-support] conversation creation failed');
                return reply.status(500).send({ error: 'Failed to create conversation', statusCode: 500 });
            }
            conversationId = newConv.id;
        }
        // Save wallet user message
        const { error: msgError } = await fastify.supabase
            .from('support_messages')
            .insert({
            conversation_id: conversationId,
            role: 'wallet',
            content: message,
        });
        if (msgError) {
            fastify.log.error({ err: msgError, conversationId }, '[wallet-support] message save failed');
            return reply.status(500).send({ error: 'Failed to save message', statusCode: 500 });
        }
        // Fetch wallet context — ONLY this user's transactions + conversation history
        const [txRes, historyRes] = await Promise.all([
            fastify.supabase
                .from('transactions')
                .select('direction, operator, amount, currency, status, created_at')
                .eq('wallet_user_id', walletUserId) // CRITICAL: only this user's transactions
                .order('created_at', { ascending: false })
                .limit(10),
            fastify.supabase
                .from('support_messages')
                .select('role, content')
                .eq('conversation_id', conversationId)
                .order('created_at', { ascending: true }),
        ]);
        const context = {
            phone: walletRow.phone,
            full_name: walletRow.full_name,
            email: walletRow.email,
            kyc_level: walletRow.kyc_level,
            is_verified: walletRow.is_verified,
            is_active: walletRow.is_active,
            balance_cdf: walletRow.balance_cdf,
            usd_balance: walletRow.usd_balance,
            usdt_balance: walletRow.usdt_balance,
            cglt_balance: walletRow.cglt_balance,
            recent_transactions: (txRes.data ?? []).map((t) => ({
                direction: t.direction,
                operator: t.operator,
                amount: t.amount,
                currency: t.currency,
                status: t.status,
                created_at: t.created_at,
            })),
        };
        const history = (historyRes.data ?? []).map((m) => ({
            role: m.role,
            content: m.content,
        }));
        // Generate bot reply
        const injectionCheck = (0, support_bot_js_1.detectPromptInjection)(message);
        if (injectionCheck.detected) {
            fastify.log.warn({ conversationId, walletUserId, message: message.slice(0, 500), labels: injectionCheck.labels }, '[wallet-support] potential prompt injection detected — message still forwarded to LLM');
        }
        const botReply = await (0, support_bot_js_1.generateWalletBotReply)(history, context);
        // Save bot message
        const { error: botMsgError } = await fastify.supabase
            .from('support_messages')
            .insert({
            conversation_id: conversationId,
            role: 'bot',
            content: botReply.content,
        });
        if (botMsgError) {
            fastify.log.error({ err: botMsgError, conversationId }, '[wallet-support] bot message save failed');
        }
        // Handle escalation / status update
        let conversationStatus = 'open';
        if (botReply.escalated) {
            conversationStatus = 'escalated';
            await fastify.supabase
                .from('support_conversations')
                .update({ status: 'escalated', updated_at: new Date().toISOString() })
                .eq('id', conversationId);
            // Send escalation email if the wallet user has an email
            if (walletRow.email) {
                (0, email_js_1.sendSupportEscalationEmail)(walletRow.full_name ?? walletRow.phone, walletRow.email, conversationId, message.slice(0, 200)).catch((err) => {
                    fastify.log.error({ err, conversationId }, '[wallet-support] escalation email failed');
                });
            }
        }
        else {
            await fastify.supabase
                .from('support_conversations')
                .update({ status: 'open', updated_at: new Date().toISOString() })
                .eq('id', conversationId);
        }
        return reply.send({
            conversation_id: conversationId,
            reply: botReply.content,
            status: conversationStatus,
            escalated: botReply.escalated,
        });
    });
    /* ── GET /v1/wallet/support/conversations ───────────────────── */
    fastify.get('/wallet/support/conversations', async (request, reply) => {
        const auth = await (0, wallet_auth_js_1.requireActiveWallet)(request, fastify.supabase);
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const { data, error } = await fastify.supabase
            .from('support_conversations')
            .select('id, status, created_at, updated_at')
            .eq('wallet_user_id', auth.payload.wallet_id) // CRITICAL: only own conversations
            .order('updated_at', { ascending: false });
        if (error)
            return reply.status(500).send({ error: error.message });
        return reply.send({ data: data ?? [] });
    });
    /* ── GET /v1/wallet/support/conversations/:id/messages ──────── */
    fastify.get('/wallet/support/conversations/:id/messages', async (request, reply) => {
        const auth = await (0, wallet_auth_js_1.requireActiveWallet)(request, fastify.supabase);
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const { id } = request.params;
        // CRITICAL: verify conversation belongs to this wallet user
        const { data: conv, error: convError } = await fastify.supabase
            .from('support_conversations')
            .select('id, wallet_user_id, status')
            .eq('id', id)
            .eq('wallet_user_id', auth.payload.wallet_id) // prevents cross-user access
            .maybeSingle();
        if (convError || !conv) {
            return reply.status(404).send({ error: 'Conversation not found', statusCode: 404 });
        }
        const { data: messages, error: msgError } = await fastify.supabase
            .from('support_messages')
            .select('id, role, content, channel, subject, created_at')
            .eq('conversation_id', id)
            .order('created_at', { ascending: true });
        if (msgError)
            return reply.status(500).send({ error: msgError.message });
        return reply.send({
            conversation: conv,
            messages: messages ?? [],
        });
    });
};
exports.default = walletSupportRoute;
//# sourceMappingURL=support.js.map