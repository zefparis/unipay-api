import type { FastifyPluginAsync } from 'fastify';
import '@fastify/multipart';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

interface RejectBody { reviewer_note: string }

const walletKycRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/wallet/kyc/submit ─────────────────────────────
     Accepts multipart/form-data:
       Fields : doc_type, full_name, birth_date, doc_number
       Files  : doc_front, doc_back, selfie
  ───────────────────────────────────────────────────────────── */
  fastify.post(
    '/wallet/kyc/submit',
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });
      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const walletId = wp.wallet_id;

      // Check if already approved
      const { data: existing } = await fastify.supabase
        .from('kyc_submissions')
        .select('id, status')
        .eq('wallet_user_id', walletId)
        .eq('status', 'approved')
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'KYC already approved' });
      }

      let doc_type = '', full_name = '', birth_date = '', doc_number = '';
      const files: Record<string, Buffer> = {};

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'field') {
            const val = String(part.value ?? '');
            if (part.fieldname === 'doc_type')   doc_type   = val;
            if (part.fieldname === 'full_name')  full_name  = val;
            if (part.fieldname === 'birth_date') birth_date = val;
            if (part.fieldname === 'doc_number') doc_number = val;
          } else {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
            files[part.fieldname] = Buffer.concat(chunks);
          }
        }
      } catch {
        return reply.status(400).send({ error: 'Invalid multipart payload' });
      }

      if (!doc_type || !full_name) {
        return reply.status(400).send({ error: 'doc_type and full_name are required' });
      }
      if (!files['doc_front'] || !files['selfie']) {
        return reply.status(400).send({ error: 'doc_front and selfie files are required' });
      }

      // Upload images to Supabase Storage (bucket: kyc-docs)
      const uploads: Array<{ path: string; buffer: Buffer }> = [
        { path: `${walletId}/front.jpg`,  buffer: files['doc_front'] },
        { path: `${walletId}/selfie.jpg`, buffer: files['selfie']    },
      ];
      if (files['doc_back']) {
        uploads.push({ path: `${walletId}/back.jpg`, buffer: files['doc_back'] });
      }

      for (const { path, buffer } of uploads) {
        const { error: upErr } = await fastify.supabase.storage
          .from('kyc-docs')
          .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
        if (upErr) {
          fastify.log.error({ err: upErr, walletId, path }, 'KYC storage upload failed');
          return reply.status(500).send({ error: 'Document upload failed' });
        }
      }

      const doc_front_url = `${walletId}/front.jpg`;
      const doc_back_url  = files['doc_back'] ? `${walletId}/back.jpg` : null;
      const selfie_url    = `${walletId}/selfie.jpg`;

      // Insert submission (upsert pending — replace rejected)
      await fastify.supabase
        .from('kyc_submissions')
        .delete()
        .eq('wallet_user_id', walletId)
        .eq('status', 'rejected');

      const { data: sub, error: insertErr } = await fastify.supabase
        .from('kyc_submissions')
        .insert({
          wallet_user_id: walletId,
          status:         'pending',
          doc_type,
          doc_front_url,
          doc_back_url,
          selfie_url,
          full_name,
          birth_date:  birth_date || null,
          doc_number:  doc_number || null,
          submitted_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (insertErr || !sub) {
        fastify.log.error({ err: insertErr, walletId }, 'KYC submission insert failed');
        return reply.status(500).send({ error: 'Submission failed' });
      }

      await fastify.supabase
        .from('wallet_users')
        .update({ kyc_submitted_at: new Date().toISOString() })
        .eq('id', walletId);

      fastify.log.info({ walletId, submissionId: sub.id }, '[kyc] submitted');

      return reply.status(201).send({ submission_id: sub.id, status: 'pending' });
    },
  );

  /* ── GET /v1/wallet/kyc/status ──────────────────────────── */
  fastify.get(
    '/wallet/kyc/status',
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });
      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const { data: sub } = await fastify.supabase
        .from('kyc_submissions')
        .select('id, status, doc_type, full_name, reviewer_note, submitted_at, reviewed_at')
        .eq('wallet_user_id', wp.wallet_id)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: user } = await fastify.supabase
        .from('wallet_users')
        .select('kyc_level, is_verified')
        .eq('id', wp.wallet_id)
        .maybeSingle();

      return reply.send({
        submission:  sub ?? null,
        kyc_level:   Number(user?.kyc_level ?? 0),
        is_verified: Boolean(user?.is_verified),
      });
    },
  );

  /* ── GET /v1/admin/wallet/kyc ──────────────────────────── */
  fastify.get<{ Querystring: { status?: string; page?: number; limit?: number } }>(
    '/admin/wallet/kyc',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
            page:   { type: 'integer', minimum: 1, default: 1 },
            limit:  { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { status = 'pending', page = 1, limit = 20 } = request.query;
      const offset = (page - 1) * limit;

      let q = fastify.supabase
        .from('kyc_submissions')
        .select('*, wallet_users(phone, full_name, balance_cdf)', { count: 'exact' })
        .order('submitted_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (status) q = q.eq('status', status);

      const { data, error, count } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      return reply.send({ data: data ?? [], total: count ?? 0 });
    },
  );

  /* ── POST /v1/admin/wallet/kyc/:id/approve ─────────────── */
  fastify.post<{ Params: { id: string } }>(
    '/admin/wallet/kyc/:id/approve',
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { id } = request.params;

      const { data: sub, error: fetchErr } = await fastify.supabase
        .from('kyc_submissions')
        .select('id, wallet_user_id, status')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr || !sub) return reply.status(404).send({ error: 'Submission not found' });

      const now = new Date().toISOString();

      const { error: subErr } = await fastify.supabase
        .from('kyc_submissions')
        .update({ status: 'approved', reviewed_at: now })
        .eq('id', id);
      if (subErr) return reply.status(500).send({ error: subErr.message });

      const { error: userErr } = await fastify.supabase
        .from('wallet_users')
        .update({ kyc_level: 1, is_verified: true })
        .eq('id', sub.wallet_user_id);
      if (userErr) return reply.status(500).send({ error: userErr.message });

      fastify.log.info({ id, walletUserId: sub.wallet_user_id }, '[kyc-approved]');
      return reply.send({ ok: true, status: 'approved' });
    },
  );

  /* ── POST /v1/admin/wallet/kyc/:id/reject ──────────────── */
  fastify.post<{ Params: { id: string }; Body: RejectBody }>(
    '/admin/wallet/kyc/:id/reject',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reviewer_note'],
          properties: {
            reviewer_note: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { id } = request.params;
      const { reviewer_note } = request.body;

      const { data: sub } = await fastify.supabase
        .from('kyc_submissions')
        .select('id')
        .eq('id', id)
        .maybeSingle();

      if (!sub) return reply.status(404).send({ error: 'Submission not found' });

      const { error } = await fastify.supabase
        .from('kyc_submissions')
        .update({ status: 'rejected', reviewer_note, reviewed_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return reply.status(500).send({ error: error.message });

      fastify.log.info({ id }, '[kyc-rejected]');
      return reply.send({ ok: true, status: 'rejected' });
    },
  );
};

export default walletKycRoute;
