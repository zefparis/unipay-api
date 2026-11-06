"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("@fastify/multipart");
const env_js_1 = require("../../config/env.js");
const merchant_auth_js_1 = require("../../lib/merchant-auth.js");
const client_ip_js_1 = require("../../lib/client-ip.js");
// Clé rate-limit KYC : par merchant_id (route authentifiée — contexte
// RDC, CGNAT massif : limiter par IP punirait les autres clients du
// même opérateur). Sans JWT valide → repli sur l'IP réelle.
const kycMerchantKey = (req) => {
    const mid = (0, merchant_auth_js_1.merchantIdFromRequest)(req);
    return mid ? `kyc:${mid}` : (0, client_ip_js_1.rateLimitKey)(req);
};
const error_schema_js_1 = require("../../lib/error-schema.js");
const email_js_1 = require("../../services/email.js");
/* ── upload validation ─────────────────────────────────────── */
const BUCKET = 'merchant-kyc-docs';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB (matches server multipart limit)
const ALLOWED_MIME = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
]);
const ALLOWED_EXT = /\.(pdf|jpe?g|png)$/i;
/** Sanitise a user-supplied filename into a safe storage path segment. */
function safeName(filename, fallback) {
    return (filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 100) || fallback);
}
/** Validate one uploaded file; returns an error string or null when valid. */
function validateFile(file, label) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
        return `${label}: type de fichier non autorisé (PDF, JPG ou PNG uniquement).`;
    }
    if (!ALLOWED_EXT.test(file.filename)) {
        return `${label}: extension de fichier non autorisée (.pdf, .jpg, .png).`;
    }
    if (file.buffer.length > MAX_FILE_BYTES) {
        return `${label}: le fichier dépasse la taille maximale de 10 Mo.`;
    }
    return null;
}
const DOC_FIELDS = ['rccm', 'idnat', 'rep_id'];
const FIELD_TO_FILE_COL = {
    rccm: 'rccm_file_url',
    idnat: 'idnat_file_url',
    rep_id: 'rep_id_file_url',
};
const DOC_LABELS = {
    rccm: 'RCCM',
    idnat: 'ID NAT',
    rep_id: 'Pièce d’identité du représentant',
};
const merchantKycRoute = async (fastify) => {
    /** Journalise l'event kyc_submitted + envoie le mail « dossier reçu ». */
    const onKycSubmitted = (merchantId, name) => {
        void fastify.supabase.from('merchant_kyc_events').insert({
            merchant_id: merchantId, event: 'kyc_submitted', actor: 'merchant', details: {},
        }).then(() => { });
        void (async () => {
            try {
                const { data: m } = await fastify.supabase.from('merchants').select('email').eq('id', merchantId).maybeSingle();
                if (m)
                    await (0, email_js_1.sendKycReceivedEmail)(m.email, name);
            }
            catch (e) {
                fastify.log.error({ err: e, merchantId }, '[kyc] received email failed');
            }
        })();
    };
    /* ── POST /v1/merchant/kyc/upload-url ─────────────────────
       Émet une URL signée d'upload direct navigateur → Supabase
       Storage. Le fichier ne transite ni par Vercel ni par x3.
       Body: { field: 'rccm'|'idnat'|'rep_id', filename, size, mime }
    ─────────────────────────────────────────────────────────── */
    fastify.post('/merchant/kyc/upload-url', {
        config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: kycMerchantKey } },
        schema: {
            body: {
                type: 'object',
                required: ['field', 'filename', 'size', 'mime'],
                properties: {
                    field: { type: 'string', enum: [...DOC_FIELDS] },
                    filename: { type: 'string', minLength: 1, maxLength: 200 },
                    size: { type: 'number', minimum: 1 },
                    mime: { type: 'string', maxLength: 100 },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_js_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
        const auth = await (0, merchant_auth_js_1.requireMerchantSession)(request, fastify.supabase);
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const { field, filename, size, mime } = request.body;
        const label = DOC_LABELS[field];
        if (!ALLOWED_MIME.has(mime)) {
            return reply.status(400).send({ error: `${label} : type de fichier non autorisé (PDF, JPG ou PNG uniquement).`, statusCode: 400 });
        }
        if (!ALLOWED_EXT.test(filename)) {
            return reply.status(400).send({ error: `${label} : extension non autorisée (.pdf, .jpg, .png).`, statusCode: 400 });
        }
        if (size > MAX_FILE_BYTES) {
            return reply.status(400).send({ error: `${label} : le fichier dépasse la taille maximale de 10 Mo.`, statusCode: 400 });
        }
        const merchantId = auth.payload.merchant_id;
        const path = `${merchantId}/${field}_file-${Date.now()}-${safeName(filename, field)}`;
        const { data, error } = await fastify.supabase.storage
            .from(BUCKET)
            .createSignedUploadUrl(path);
        if (error || !data) {
            fastify.log.error({ err: error, merchantId, path }, '[merchant/kyc] signed upload url failed');
            return reply.status(500).send({ error: 'Impossible de préparer l’envoi du fichier, réessayez.', statusCode: 500 });
        }
        return reply.send({ path: data.path, token: data.token, upload_url: data.signedUrl });
    });
    /* ── GET /v1/merchant/kyc ───────────────────────────────── */
    fastify.get('/merchant/kyc', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        kyc_status: { type: 'string' },
                        access_status: { type: 'string' },
                        kyc_deadline: { type: ['string', 'null'] },
                        kyc_submitted_at: { type: ['string', 'null'] },
                        kyc_reviewed_at: { type: ['string', 'null'] },
                        kyc_notes: { type: ['string', 'null'] },
                        company_name: { type: ['string', 'null'] },
                        company_rccm: { type: ['string', 'null'] },
                        company_idnat: { type: ['string', 'null'] },
                        rccm_file_url: { type: ['string', 'null'] },
                        idnat_file_url: { type: ['string', 'null'] },
                        rep_id_file_url: { type: ['string', 'null'] },
                    },
                },
                ...error_schema_js_1.errorResponses,
            },
        },
    }, async (request, reply) => {
        if (!env_js_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
        const auth = await (0, merchant_auth_js_1.requireMerchantSession)(request, fastify.supabase);
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const { data } = await fastify.supabase
            .from('merchants')
            .select('kyc_status, access_status, kyc_deadline, kyc_submitted_at, kyc_reviewed_at, kyc_notes, company_name, company_rccm, company_idnat, rccm_file_url, idnat_file_url, rep_id_file_url')
            .eq('id', auth.payload.merchant_id)
            .maybeSingle();
        return reply.send({
            kyc_status: data?.kyc_status ?? 'pending',
            access_status: data?.access_status ?? 'active',
            kyc_deadline: data?.kyc_deadline ?? null,
            kyc_submitted_at: data?.kyc_submitted_at ?? null,
            kyc_reviewed_at: data?.kyc_reviewed_at ?? null,
            kyc_notes: data?.kyc_notes ?? null,
            company_name: data?.company_name ?? null,
            company_rccm: data?.company_rccm ?? null,
            company_idnat: data?.company_idnat ?? null,
            rccm_file_url: data?.rccm_file_url ?? null,
            idnat_file_url: data?.idnat_file_url ?? null,
            rep_id_file_url: data?.rep_id_file_url ?? null,
        });
    });
    /* ── POST /v1/merchant/kyc ────────────────────────────────
       Accepts multipart/form-data:
         Fields : company_name (required), company_rccm, company_idnat
         Files  : rccm_file, idnat_file, rep_id_file (PDF/JPG/PNG, ≤10 MB)
       Uploads files to Supabase Storage (bucket: merchant-kyc-docs),
       updates merchant row, and sets kyc_status = 'submitted'.
    ─────────────────────────────────────────────────────────── */
    fastify.post('/merchant/kyc', {
        config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: kycMerchantKey } },
    }, async (request, reply) => {
        if (!env_js_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
        const auth = await (0, merchant_auth_js_1.requireMerchantSession)(request, fastify.supabase);
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const merchantId = auth.payload.merchant_id;
        // Already approved? Lock submissions.
        const { data: existing } = await fastify.supabase
            .from('merchants')
            .select('kyc_status, rccm_file_url, idnat_file_url, rep_id_file_url')
            .eq('id', merchantId)
            .maybeSingle();
        if (existing?.kyc_status === 'approved') {
            return reply.status(409).send({ error: 'KYC déjà approuvé', statusCode: 409 });
        }
        // ── JSON path (URL signée) ────────────────────────────
        // Le navigateur a uploadé chaque fichier directement vers
        // Supabase Storage. On reçoit les chemins, on vérifie qu'ils
        // appartiennent au marchand, que l'objet existe, sa taille et
        // son MIME, puis on met à jour la fiche.
        const contentType = request.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
            const body = request.body;
            if (!body)
                return reply.status(400).send({ error: 'Corps JSON invalide', statusCode: 400 });
            const company_name = String(body.company_name ?? '').trim();
            if (company_name.length < 2 || company_name.length > 256) {
                return reply.status(400).send({ error: 'La raison sociale est requise (2 à 256 caractères).', statusCode: 400 });
            }
            const company_rccm = String(body.company_rccm ?? '').trim().slice(0, 128);
            const company_idnat = String(body.company_idnat ?? '').trim().slice(0, 128);
            // Chemins fournis : 'rccm_path', 'idnat_path', 'rep_id_path'
            const paths = { rccm: null, idnat: null, rep_id: null };
            for (const f of DOC_FIELDS) {
                const raw = body[`${f}_path`];
                if (raw === undefined || raw === null)
                    continue;
                const p = String(raw);
                if (!p.startsWith(`${merchantId}/`) || p.includes('..')) {
                    return reply.status(400).send({ error: `${DOC_LABELS[f]} : chemin de fichier invalide.`, statusCode: 400 });
                }
                paths[f] = p;
            }
            // Vérifier l'existence + métadonnées de chaque objet uploadé
            for (const f of DOC_FIELDS) {
                const p = paths[f];
                if (!p)
                    continue;
                const dir = p.slice(0, p.lastIndexOf('/'));
                const name = p.slice(p.lastIndexOf('/') + 1);
                const { data: listing, error: listErr } = await fastify.supabase.storage
                    .from(BUCKET)
                    .list(dir, { search: name, limit: 1 });
                const obj = listing?.find((o) => o.name === name);
                if (listErr || !obj) {
                    return reply.status(400).send({ error: `${DOC_LABELS[f]} : fichier introuvable, renvoyez-le.`, statusCode: 400 });
                }
                const meta = obj.metadata ?? {};
                if ((meta.size ?? 0) > MAX_FILE_BYTES) {
                    return reply.status(400).send({ error: `${DOC_LABELS[f]} : le fichier dépasse la taille maximale de 10 Mo.`, statusCode: 400 });
                }
                if (meta.mimetype && !ALLOWED_MIME.has(meta.mimetype)) {
                    return reply.status(400).send({ error: `${DOC_LABELS[f]} : type de fichier non autorisé (PDF, JPG ou PNG uniquement).`, statusCode: 400 });
                }
            }
            // Les 3 pièces sont obligatoires : nouveau chemin OU pièce déjà enregistrée
            const missing = DOC_FIELDS.filter((f) => !paths[f] && !(existing?.[FIELD_TO_FILE_COL[f]]));
            if (missing.length > 0) {
                return reply.status(400).send({
                    error: `Documents manquants : ${missing.map((f) => DOC_LABELS[f]).join(', ')}.`,
                    statusCode: 400,
                });
            }
            const { error } = await fastify.supabase
                .from('merchants')
                .update({
                company_name,
                company_rccm: company_rccm || null,
                company_idnat: company_idnat || null,
                rccm_file_url: paths.rccm ?? existing?.rccm_file_url,
                idnat_file_url: paths.idnat ?? existing?.idnat_file_url,
                rep_id_file_url: paths.rep_id ?? existing?.rep_id_file_url,
                kyc_status: 'submitted',
                kyc_submitted_at: new Date().toISOString(),
                kyc_notes: null,
            })
                .eq('id', merchantId);
            if (error) {
                fastify.log.error({ err: error, merchantId }, 'KYC submit failed');
                return reply.status(500).send({ error: 'KYC submission failed', statusCode: 500 });
            }
            fastify.log.info({ merchantId, company_name }, 'KYC submitted (signed urls)');
            onKycSubmitted(merchantId, company_name);
            return reply.send({ ok: true, kyc_status: 'submitted' });
        }
        // Parse multipart
        let company_name = '';
        let company_rccm = '';
        let company_idnat = '';
        const files = {};
        try {
            const parts = request.parts();
            for await (const part of parts) {
                if (part.type === 'field') {
                    const val = String(part.value ?? '');
                    if (part.fieldname === 'company_name')
                        company_name = val;
                    if (part.fieldname === 'company_rccm')
                        company_rccm = val;
                    if (part.fieldname === 'company_idnat')
                        company_idnat = val;
                }
                else {
                    // file part
                    const key = part.fieldname;
                    if (!['rccm_file', 'idnat_file', 'rep_id_file'].includes(key)) {
                        // skip unexpected file fields
                        for await (const _chunk of part.file) { /* drain */
                            void _chunk;
                        }
                        continue;
                    }
                    const chunks = [];
                    for await (const chunk of part.file)
                        chunks.push(Buffer.from(chunk));
                    files[key] = {
                        buffer: Buffer.concat(chunks),
                        filename: part.filename ?? String(key),
                        mimetype: part.mimetype ?? 'application/octet-stream',
                    };
                }
            }
        }
        catch (err) {
            if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
                return reply.status(413).send({ error: 'Fichier trop volumineux (10 Mo maximum par fichier).', statusCode: 413 });
            }
            return reply.status(400).send({ error: 'Envoi du formulaire invalide, réessayez.', statusCode: 400 });
        }
        // Validate text fields
        company_name = company_name.trim();
        if (company_name.length < 2 || company_name.length > 256) {
            return reply.status(400).send({ error: 'La raison sociale est requise (2 à 256 caractères).', statusCode: 400 });
        }
        company_rccm = company_rccm.trim().slice(0, 128);
        company_idnat = company_idnat.trim().slice(0, 128);
        // Validate files
        const fileLabels = {
            rccm_file: 'RCCM',
            idnat_file: 'ID NAT',
            rep_id_file: 'Pièce d’identité du représentant',
        };
        for (const key of Object.keys(files)) {
            const f = files[key];
            if (!f)
                continue;
            const err = validateFile(f, fileLabels[key]);
            if (err)
                return reply.status(400).send({ error: err, statusCode: 400 });
        }
        // Les 3 pièces sont obligatoires : nouveau fichier OU pièce déjà enregistrée
        {
            const miss = [];
            if (!files.rccm_file && !existing?.rccm_file_url)
                miss.push('RCCM');
            if (!files.idnat_file && !existing?.idnat_file_url)
                miss.push('ID NAT');
            if (!files.rep_id_file && !existing?.rep_id_file_url)
                miss.push('Pièce d’identité du représentant');
            if (miss.length > 0) {
                return reply.status(400).send({ error: `Documents manquants : ${miss.join(', ')}.`, statusCode: 400 });
            }
        }
        // Upload files to Supabase Storage
        const stamp = Date.now();
        const uploadOne = async (key) => {
            const f = files[key];
            if (!f)
                return null;
            const path = `${merchantId}/${key}-${stamp}-${safeName(f.filename, String(key))}`;
            const { error: upErr } = await fastify.supabase.storage
                .from(BUCKET)
                .upload(path, f.buffer, { contentType: f.mimetype, upsert: true });
            if (upErr) {
                fastify.log.error({ err: upErr, merchantId, path }, '[merchant/kyc] file upload failed');
                throw new Error(`Échec de l’upload du document ${fileLabels[key]}.`);
            }
            return path;
        };
        let rccmFileUrl = null;
        let idnatFileUrl = null;
        let repIdFileUrl = null;
        try {
            [rccmFileUrl, idnatFileUrl, repIdFileUrl] = await Promise.all([
                uploadOne('rccm_file'),
                uploadOne('idnat_file'),
                uploadOne('rep_id_file'),
            ]);
        }
        catch (err) {
            return reply.status(500).send({ error: err.message, statusCode: 500 });
        }
        // Persist
        const { error } = await fastify.supabase
            .from('merchants')
            .update({
            company_name,
            company_rccm: company_rccm || null,
            company_idnat: company_idnat || null,
            rccm_file_url: rccmFileUrl ?? existing?.rccm_file_url,
            idnat_file_url: idnatFileUrl ?? existing?.idnat_file_url,
            rep_id_file_url: repIdFileUrl ?? existing?.rep_id_file_url,
            kyc_status: 'submitted',
            kyc_submitted_at: new Date().toISOString(),
            kyc_notes: null,
        })
            .eq('id', merchantId);
        if (error) {
            fastify.log.error({ err: error, merchantId }, 'KYC submit failed');
            return reply.status(500).send({ error: 'KYC submission failed', statusCode: 500 });
        }
        fastify.log.info({ merchantId, company_name }, 'KYC submitted');
        onKycSubmitted(merchantId, company_name);
        return reply.send({ ok: true, kyc_status: 'submitted' });
    });
};
exports.default = merchantKycRoute;
//# sourceMappingURL=kyc.js.map