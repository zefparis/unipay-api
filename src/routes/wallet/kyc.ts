import type { FastifyPluginAsync } from 'fastify';
import '@fastify/multipart';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { enrollPayGuard, type CognitiveBaseline } from '../../services/payguard';
import { fetchImageAsBase64 } from '../../utils/storage';

const walletKycRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/wallet/kyc/submit ─────────────────────────────
     Accepts multipart/form-data:
       Fields : doc_type, full_name, birth_date, doc_number
       Files  : selfie
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
      let cognitiveData: CognitiveBaseline | null = null;
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
            if (part.fieldname === 'cognitive_data') {
              try { cognitiveData = JSON.parse(val) as CognitiveBaseline; } catch { /* ignore invalid */ }
            }
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

      const walletUserId = walletId;
      const submissionId = sub.id;

      await fastify.supabase
        .from('wallet_users')
        .update({ kyc_submitted_at: new Date().toISOString() })
        .eq('id', walletId);

      let payguardResult: { student_id: string; confidence: number } | null = null;
      try {
        const { data: signed, error: signedErr } = await fastify.supabase.storage
          .from('kyc-docs')
          .createSignedUrl(selfie_url, 300);

        if (signedErr || !signed?.signedUrl) {
          throw signedErr ?? new Error('Selfie signed URL failed');
        }

        const selfieBuffer = await fetchImageAsBase64(signed.signedUrl);
        const [firstName, ...lastNameParts] = full_name.trim().split(/\s+/);
        const lastName = lastNameParts.join(' ') || full_name;

        payguardResult = await enrollPayGuard({
          selfie_b64: selfieBuffer,
          first_name: firstName,
          last_name: lastName,
          cognitive_baseline: cognitiveData ?? undefined,
        });

        if (payguardResult.confidence >= 85) {
          const kycLevel = cognitiveData ? 2 : 1;
          await fastify.supabase
            .from('wallet_users')
            .update({
              kyc_level: kycLevel,
              is_verified: true,
              payguard_student_id: payguardResult.student_id,
            })
            .eq('id', walletUserId);

          await fastify.supabase
            .from('kyc_submissions')
            .update({
              status: 'approved',
              payguard_confidence: payguardResult.confidence,
              payguard_decision: cognitiveData ? 'auto_approved_cognitive' : 'auto_approved',
              reviewed_at: new Date().toISOString(),
            })
            .eq('id', submissionId);

          request.log.info({ walletUserId, confidence: payguardResult.confidence, kycLevel: cognitiveData ? 2 : 1 }, '[kyc] auto-approved by PayGuard');
        } else {
          await fastify.supabase
            .from('kyc_submissions')
            .update({
              payguard_confidence: payguardResult.confidence,
              payguard_decision: 'manual_review',
            })
            .eq('id', submissionId);
          request.log.info({ walletUserId, confidence: payguardResult.confidence }, '[kyc] queued for manual review');
        }
      } catch (err) {
        request.log.warn({ err }, '[kyc] PayGuard enroll failed, queuing for manual review');
      }

      fastify.log.info({ walletId, submissionId }, '[kyc] submitted');

      const confidence = payguardResult?.confidence ?? null;
      const kycLevel = (confidence ?? 0) >= 85 && cognitiveData ? 2 : (confidence ?? 0) >= 85 ? 1 : undefined;

      return reply.status(201).send({
        submission_id: submissionId,
        status: (confidence ?? 0) >= 85 ? 'approved' : 'pending',
        confidence,
        auto_approved: (confidence ?? 0) >= 85,
        kyc_level: kycLevel,
      });
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

  /* ── POST /v1/wallet/kyc/upgrade-cognitive ──────────────────
     Upgrades a level-1 user to level 2 using cognitive test results.
     Reuses the selfie already stored from the initial KYC submission.
     Body: { cognitive_data: CognitiveBaseline }
  ───────────────────────────────────────────────────────────── */
  fastify.post(
    '/wallet/kyc/upgrade-cognitive',
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });
      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const walletId = wp.wallet_id;

      const { data: user } = await fastify.supabase
        .from('wallet_users')
        .select('kyc_level, is_verified')
        .eq('id', walletId)
        .maybeSingle();

      if (!user) return reply.status(404).send({ error: 'User not found' });
      if (user.kyc_level !== 1) {
        return reply.status(409).send({ error: 'Cognitive upgrade is only available for KYC level 1 users' });
      }

      const body = request.body as { cognitive_data?: CognitiveBaseline };
      if (!body?.cognitive_data) {
        return reply.status(400).send({ error: 'cognitive_data is required' });
      }

      const { data: sub } = await fastify.supabase
        .from('kyc_submissions')
        .select('selfie_url, full_name')
        .eq('wallet_user_id', walletId)
        .eq('status', 'approved')
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!sub?.selfie_url || !sub?.full_name) {
        return reply.status(409).send({ error: 'No approved KYC submission found. Please complete KYC level 1 first.' });
      }

      try {
        const { data: signed, error: signedErr } = await fastify.supabase.storage
          .from('kyc-docs')
          .createSignedUrl(sub.selfie_url, 300);

        if (signedErr || !signed?.signedUrl) {
          throw signedErr ?? new Error('Selfie signed URL failed');
        }

        const selfieB64 = await fetchImageAsBase64(signed.signedUrl);
        const [firstName, ...lastNameParts] = sub.full_name.trim().split(/\s+/);
        const lastName = lastNameParts.join(' ') || sub.full_name;

        const payguardResult = await enrollPayGuard({
          selfie_b64: selfieB64,
          first_name: firstName,
          last_name: lastName,
          cognitive_baseline: body.cognitive_data,
        });

        if (payguardResult.confidence >= 85) {
          await fastify.supabase
            .from('wallet_users')
            .update({
              kyc_level: 2,
              payguard_student_id: payguardResult.student_id,
            })
            .eq('id', walletId);

          request.log.info({ walletId, confidence: payguardResult.confidence }, '[kyc] cognitive upgrade approved → level 2');

          return reply.send({
            success: true,
            kyc_level: 2,
            confidence: payguardResult.confidence,
          });
        } else {
          request.log.info({ walletId, confidence: payguardResult.confidence }, '[kyc] cognitive upgrade rejected (confidence too low)');
          return reply.status(422).send({
            success: false,
            error: `Confiance insuffisante (${payguardResult.confidence}%). Niveau 2 non attribué.`,
            confidence: payguardResult.confidence,
          });
        }
      } catch (err) {
        request.log.error({ err, walletId }, '[kyc] cognitive upgrade failed');
        return reply.status(500).send({ error: 'Upgrade failed. Please try again.' });
      }
    },
  );

};

export default walletKycRoute;
