"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("@fastify/multipart");
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
const payguard_1 = require("../../services/payguard");
const storage_1 = require("../../utils/storage");
const walletKycRoute = async (fastify) => {
    /* ── POST /v1/wallet/kyc/submit ─────────────────────────────
       Accepts multipart/form-data:
         Fields : doc_type, full_name, birth_date, doc_number
         Files  : selfie
    ───────────────────────────────────────────────────────────── */
    fastify.post('/wallet/kyc/submit', async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth service not configured' });
        const wp = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!wp)
            return reply.status(401).send({ error: 'Unauthorized' });
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
        const files = {};
        try {
            const parts = request.parts();
            for await (const part of parts) {
                if (part.type === 'field') {
                    const val = String(part.value ?? '');
                    if (part.fieldname === 'doc_type')
                        doc_type = val;
                    if (part.fieldname === 'full_name')
                        full_name = val;
                    if (part.fieldname === 'birth_date')
                        birth_date = val;
                    if (part.fieldname === 'doc_number')
                        doc_number = val;
                }
                else {
                    const chunks = [];
                    for await (const chunk of part.file)
                        chunks.push(Buffer.from(chunk));
                    files[part.fieldname] = Buffer.concat(chunks);
                }
            }
        }
        catch {
            return reply.status(400).send({ error: 'Invalid multipart payload' });
        }
        if (!doc_type || !full_name) {
            return reply.status(400).send({ error: 'doc_type and full_name are required' });
        }
        if (!files['selfie']) {
            return reply.status(400).send({ error: 'selfie file is required' });
        }
        // Upload images to Supabase Storage (bucket: kyc-docs)
        const uploads = [
            { path: `${walletId}/selfie.jpg`, buffer: files['selfie'] },
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
        const doc_back_url = null;
        const selfie_url = `${walletId}/selfie.jpg`;
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
            status: 'pending',
            doc_type,
            doc_front_url,
            doc_back_url,
            selfie_url,
            full_name,
            birth_date: birth_date || null,
            doc_number: doc_number || null,
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
        let payguardResult = null;
        try {
            const { data: signed, error: signedErr } = await fastify.supabase.storage
                .from('kyc-docs')
                .createSignedUrl(selfie_url, 300);
            if (signedErr || !signed?.signedUrl) {
                throw signedErr ?? new Error('Selfie signed URL failed');
            }
            const selfieBuffer = await (0, storage_1.fetchImageAsBase64)(signed.signedUrl);
            const [firstName, ...lastNameParts] = full_name.trim().split(/\s+/);
            const lastName = lastNameParts.join(' ') || full_name;
            payguardResult = await (0, payguard_1.enrollPayGuard)({
                selfie_b64: selfieBuffer,
                first_name: firstName,
                last_name: lastName,
            });
            if (payguardResult.confidence >= 85) {
                await fastify.supabase
                    .from('wallet_users')
                    .update({
                    kyc_level: 1,
                    is_verified: true,
                    payguard_student_id: payguardResult.student_id,
                })
                    .eq('id', walletUserId);
                await fastify.supabase
                    .from('kyc_submissions')
                    .update({
                    status: 'approved',
                    payguard_confidence: payguardResult.confidence,
                    payguard_decision: 'auto_approved',
                    reviewed_at: new Date().toISOString(),
                })
                    .eq('id', submissionId);
                request.log.info({ walletUserId, confidence: payguardResult.confidence }, '[kyc] auto-approved by PayGuard');
            }
            else {
                await fastify.supabase
                    .from('kyc_submissions')
                    .update({
                    payguard_confidence: payguardResult.confidence,
                    payguard_decision: 'manual_review',
                })
                    .eq('id', submissionId);
                request.log.info({ walletUserId, confidence: payguardResult.confidence }, '[kyc] queued for manual review');
            }
        }
        catch (err) {
            request.log.warn({ err }, '[kyc] PayGuard enroll failed, queuing for manual review');
        }
        fastify.log.info({ walletId, submissionId }, '[kyc] submitted');
        const confidence = payguardResult?.confidence ?? null;
        return reply.status(201).send({
            submission_id: submissionId,
            status: (confidence ?? 0) >= 85 ? 'approved' : 'pending',
            confidence,
            auto_approved: (confidence ?? 0) >= 85,
        });
    });
    /* ── GET /v1/wallet/kyc/status ──────────────────────────── */
    fastify.get('/wallet/kyc/status', async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth service not configured' });
        const wp = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!wp)
            return reply.status(401).send({ error: 'Unauthorized' });
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
            submission: sub ?? null,
            kyc_level: Number(user?.kyc_level ?? 0),
            is_verified: Boolean(user?.is_verified),
        });
    });
};
exports.default = walletKycRoute;
//# sourceMappingURL=kyc.js.map