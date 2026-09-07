import type { FastifyPluginAsync } from 'fastify';
import { generateWalletBotReply, type WalletContext } from '../../services/support-bot.js';
import { sendSupportEscalationEmail } from '../../services/email.js';
import { requireActiveWallet, walletIdFromRequest } from '../../lib/wallet-auth.js';

interface MessageBody {
  conversation_id?: string;
  message: string;
}

const walletSupportRoute: FastifyPluginAsync = async (fastify) => {
  /* ── POST /v1/wallet/support/message ────────────────────────── */
  fastify.post<{ Body: MessageBody }>(
    '/wallet/support/message',
    {
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          properties: {
            conversation_id: { type: 'string', format: 'uuid' },
            message:         { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
          keyGenerator: (req) => walletIdFromRequest(req) || req.ip,
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, phone, full_name, email, kyc_level, is_verified, is_active, balance_cdf, usd_balance, usdt_balance, cglt_balance');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const walletUserId = auth.payload.wallet_id;
      const walletRow = auth.wallet as {
        phone: string; full_name: string | null; email: string | null;
        kyc_level: number; is_verified: boolean; is_active: boolean;
        balance_cdf: number | string; usd_balance: number | string;
        usdt_balance: number | string; cglt_balance: number | string;
      };
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
      } else {
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

      const context: WalletContext = {
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
          direction: (t as { direction: string }).direction,
          operator: (t as { operator: string }).operator,
          amount: (t as { amount: string | number }).amount,
          currency: (t as { currency: string }).currency,
          status: (t as { status: string }).status,
          created_at: (t as { created_at: string }).created_at,
        })),
      };

      const history = (historyRes.data ?? []).map((m) => ({
        role: (m as { role: 'wallet' | 'bot' | 'admin' }).role,
        content: (m as { content: string }).content,
      }));

      // Generate bot reply
      const botReply = await generateWalletBotReply(history, context);

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
          .eq('id', conversationId!);

        // Send escalation email if the wallet user has an email
        if (walletRow.email) {
          sendSupportEscalationEmail(
            walletRow.full_name ?? walletRow.phone,
            walletRow.email,
            conversationId!,
            message.slice(0, 200),
          ).catch((err: unknown) => {
            fastify.log.error({ err, conversationId }, '[wallet-support] escalation email failed');
          });
        }
      } else {
        await fastify.supabase
          .from('support_conversations')
          .update({ status: 'open', updated_at: new Date().toISOString() })
          .eq('id', conversationId!);
      }

      return reply.send({
        conversation_id: conversationId,
        reply: botReply.content,
        status: conversationStatus,
        escalated: botReply.escalated,
      });
    },
  );

  /* ── GET /v1/wallet/support/conversations ───────────────────── */
  fastify.get('/wallet/support/conversations', async (request, reply) => {
    const auth = await requireActiveWallet(request, fastify.supabase);
    if (!auth.ok) return reply.status(auth.status).send(auth.error);

    const { data, error } = await fastify.supabase
      .from('support_conversations')
      .select('id, status, created_at, updated_at')
      .eq('wallet_user_id', auth.payload.wallet_id) // CRITICAL: only own conversations
      .order('updated_at', { ascending: false });

    if (error) return reply.status(500).send({ error: error.message });

    return reply.send({ data: data ?? [] });
  });

  /* ── GET /v1/wallet/support/conversations/:id/messages ──────── */
  fastify.get<{ Params: { id: string } }>(
    '/wallet/support/conversations/:id/messages',
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

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

      if (msgError) return reply.status(500).send({ error: msgError.message });

      return reply.send({
        conversation: conv,
        messages: messages ?? [],
      });
    },
  );
};

export default walletSupportRoute;
