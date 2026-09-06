import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { verifyToken, type JwtPayload } from '../../utils/jwt.js';
import { generateBotReply, type MerchantContext } from '../../services/support-bot.js';
import { sendSupportEscalationEmail } from '../../services/email.js';

interface MessageBody {
  conversation_id?: string;
  message: string;
}

function requireMerchantAuth(request: { headers: Record<string, string | string[] | undefined> }): JwtPayload | null {
  if (!env.JWT_SECRET) return null;
  const auth = request.headers.authorization;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7), env.JWT_SECRET);
}

const merchantSupportRoute: FastifyPluginAsync = async (fastify) => {
  /* ── POST /v1/merchant/support/message ─────────────────────── */
  fastify.post<{ Body: MessageBody }>(
    '/merchant/support/message',
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
    },
    async (request, reply) => {
      const payload = requireMerchantAuth(request);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const merchantId = payload.merchant_id;
      const { message, conversation_id } = request.body;

      // Find or create conversation — ALWAYS scoped to this merchant
      let conversationId = conversation_id;
      if (conversationId) {
        // Verify ownership: conversation must belong to this merchant
        const { data: conv, error: convError } = await fastify.supabase
          .from('support_conversations')
          .select('id, status, merchant_id')
          .eq('id', conversationId)
          .eq('merchant_id', merchantId) // CRITICAL: prevents cross-merchant access
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
          .insert({ merchant_id: merchantId, status: 'open' })
          .select('id')
          .single();

        if (createError || !newConv) {
          fastify.log.error({ err: createError, merchantId }, '[support] conversation creation failed');
          return reply.status(500).send({ error: 'Failed to create conversation', statusCode: 500 });
        }
        conversationId = newConv.id;
      }

      // Save merchant message
      const { error: msgError } = await fastify.supabase
        .from('support_messages')
        .insert({
          conversation_id: conversationId,
          role: 'merchant',
          content: message,
        });

      if (msgError) {
        fastify.log.error({ err: msgError, conversationId }, '[support] message save failed');
        return reply.status(500).send({ error: 'Failed to save message', statusCode: 500 });
      }

      // Fetch merchant context — ONLY this merchant's data
      const [merchantRes, keysRes, txRes, historyRes] = await Promise.all([
        fastify.supabase
          .from('merchants')
          .select('id, name, email, kyc_status, mode, status, company_name')
          .eq('id', merchantId)
          .maybeSingle(),
        fastify.supabase
          .from('api_keys')
          .select('is_active')
          .eq('merchant_id', merchantId)
          .eq('is_active', true)
          .limit(1),
        fastify.supabase
          .from('transactions')
          .select('direction, operator, amount, currency, status, created_at')
          .eq('merchant_id', merchantId) // CRITICAL: only this merchant's transactions
          .order('created_at', { ascending: false })
          .limit(10),
        fastify.supabase
          .from('support_messages')
          .select('role, content')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true }),
      ]);

      if (merchantRes.error || !merchantRes.data) {
        return reply.status(500).send({ error: 'Merchant context fetch failed', statusCode: 500 });
      }

      const merchant = merchantRes.data as {
        name: string; email: string; kyc_status: string; mode: string;
        status: string; company_name: string | null;
      };

      const context: MerchantContext = {
        name: merchant.name,
        email: merchant.email,
        kyc_status: merchant.kyc_status,
        mode: merchant.mode,
        status: merchant.status,
        company_name: merchant.company_name,
        api_key_active: (keysRes.data?.length ?? 0) > 0,
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
        role: (m as { role: 'merchant' | 'bot' | 'admin' }).role,
        content: (m as { content: string }).content,
      }));

      // Generate bot reply
      const botReply = await generateBotReply(history, context);

      // Save bot message
      const { error: botMsgError } = await fastify.supabase
        .from('support_messages')
        .insert({
          conversation_id: conversationId,
          role: 'bot',
          content: botReply.content,
        });

      if (botMsgError) {
        fastify.log.error({ err: botMsgError, conversationId }, '[support] bot message save failed');
      }

      // Handle escalation
      let conversationStatus = 'open';
      if (botReply.escalated) {
        conversationStatus = 'escalated';
        await fastify.supabase
          .from('support_conversations')
          .update({ status: 'escalated', updated_at: new Date().toISOString() })
          .eq('id', conversationId!);

        // Send escalation email (non-blocking)
        sendSupportEscalationEmail(
          merchant.name,
          merchant.email,
          conversationId!,
          message.slice(0, 200),
        ).catch((err: unknown) => {
          fastify.log.error({ err, conversationId }, '[support] escalation email failed');
        });
      }

      return reply.send({
        conversation_id: conversationId,
        reply: botReply.content,
        status: conversationStatus,
        escalated: botReply.escalated,
      });
    },
  );

  /* ── GET /v1/merchant/support/conversations ────────────────── */
  fastify.get('/merchant/support/conversations', async (request, reply) => {
    const payload = requireMerchantAuth(request);
    if (!payload) {
      return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
    }

    const { data, error } = await fastify.supabase
      .from('support_conversations')
      .select('id, status, created_at, updated_at')
      .eq('merchant_id', payload.merchant_id) // CRITICAL: only own conversations
      .order('updated_at', { ascending: false });

    if (error) return reply.status(500).send({ error: error.message });

    return reply.send({ data: data ?? [] });
  });

  /* ── GET /v1/merchant/support/conversations/:id/messages ──── */
  fastify.get<{ Params: { id: string } }>(
    '/merchant/support/conversations/:id/messages',
    async (request, reply) => {
      const payload = requireMerchantAuth(request);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { id } = request.params;

      // CRITICAL: verify conversation belongs to this merchant
      const { data: conv, error: convError } = await fastify.supabase
        .from('support_conversations')
        .select('id, merchant_id, status')
        .eq('id', id)
        .eq('merchant_id', payload.merchant_id) // prevents cross-merchant access
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

export default merchantSupportRoute;
