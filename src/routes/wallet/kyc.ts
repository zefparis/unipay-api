import type { FastifyPluginAsync } from 'fastify';
import '@fastify/multipart';
import { requireActiveWallet } from '../../lib/wallet-auth';

const walletKycRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/wallet/kyc/submit ─────────────────────────────
     Accepts multipart/form-data:
       Fields : doc_type, full_name, birth_date, doc_number
       Files  : selfie
  ───────────────────────────────────────────────────────────── */
  fastify.post(
    '/wallet/kyc/submit',
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, phone, kyc_level, is_active');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const { payload } = auth;

      const walletId = payload.wallet_id;

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
      if (!files['selfie']) {
        return reply.status(400).send({ error: 'selfie file is required' });
      }

      // Upload images to Supabase Storage (bucket: kyc-docs)
      const uploads: Array<{ path: string; buffer: Buffer }> = [
        { path: `${walletId}/selfie.jpg`, buffer: files['selfie']    },
      ];

      for (const { path, buffer } of uploads) {
        const { error: upErr } = await fastify.supabase.storage
          .from('kyc-docs')
          .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
        if (upErr) {
          fastify.log.error({ err: upErr, walletId, path }, 'KYC storage upload failed');
          return reply.status(500).send({ error: 'Document upload failed' });
        }
      }

      const doc_front_url = null;
      const doc_back_url  = null;
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

      const submissionId = sub.id;

      await fastify.supabase
        .from('wallet_users')
        .update({ kyc_submitted_at: new Date().toISOString() })
        .eq('id', walletId);

      // The external verification provider (PayGuard → Hybrid Vector) has
      // been decommissioned: every submission goes straight to the manual
      // review queue (admin approves → kyc_level 1).
      fastify.log.info({ walletId, submissionId }, '[kyc] submitted — queued for manual review');

      return reply.status(201).send({
        submission_id: submissionId,
        status: 'pending',
        confidence: null,
        auto_approved: false,
      });
    },
  );

  /* ── GET /v1/wallet/kyc/status ──────────────────────────── */
  fastify.get(
    '/wallet/kyc/status',
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, kyc_level, is_verified, kyc_submitted_at');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const { payload } = auth;
      const wallet = auth.wallet as { id: string; kyc_level: number; is_verified: boolean; kyc_submitted_at: string | null };

      const { data: sub } = await fastify.supabase
        .from('kyc_submissions')
        .select('id, status, doc_type, full_name, reviewer_note, submitted_at, reviewed_at')
        .eq('wallet_user_id', payload.wallet_id)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return reply.send({
        submission:  sub ?? null,
        kyc_level:   Number(wallet.kyc_level ?? 0),
        is_verified: Boolean(wallet.is_verified),
      });
    },
  );

  /* ── POST /v1/wallet/kyc/upgrade-cognitive ──────────────────
     DISABLED — the cognitive verification backend (PayGuard → Hybrid
     Vector) has been decommissioned. Kept as an explicit 410 so existing
     clients get a clear "feature unavailable" response instead of a 404.
  ───────────────────────────────────────────────────────────── */
  fastify.post(
    '/wallet/kyc/upgrade-cognitive',
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, kyc_level, is_active');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      return reply.status(410).send({
        success: false,
        error: 'La vérification cognitive (KYC niveau 2) n\'est plus disponible.',
        code: 'FEATURE_DISABLED',
      });
    },
  );

};

export default walletKycRoute;
