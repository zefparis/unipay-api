"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const avada_js_1 = require("../../services/avada.js");
const phone_normalization_js_1 = require("../../lib/phone-normalization.js");
const settlement_rpc_helpers_js_1 = require("../merchant/settlement-rpc-helpers.js");
const admin_action_log_js_1 = require("../../lib/admin-action-log.js");
function requireAdmin(isAdmin) {
    return isAdmin;
}
const adminSettlementRoute = async (fastify) => {
    /* ── GET /v1/admin/settlements/pending-review ──────────────── */
    fastify.get('/admin/settlements/pending-review', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireAdmin(request.isAdmin)) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        const page = request.query.page ?? 1;
        const limit = request.query.limit ?? 50;
        const offset = (page - 1) * limit;
        const { data: requests, error, count } = await fastify.supabase
            .from('merchant_settlement_requests')
            .select('id, merchant_id, amount, phone, status, created_at, updated_at, merchants(name, email)', { count: 'exact' })
            .eq('status', 'pending_admin_review')
            .order('created_at', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) {
            fastify.log.error({ err: error }, '[admin/settlements] pending-review query failed');
            return reply.status(500).send({ error: 'Internal server error', statusCode: 500 });
        }
        return reply.send({
            requests: requests ?? [],
            total: count ?? 0,
            page,
            limit,
        });
    });
    /* ── POST /v1/admin/settlements/:id/approve ────────────────── */
    fastify.post('/admin/settlements/:id/approve', {
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                },
            },
            body: {
                type: 'object',
                properties: {
                    operator: { type: 'string', enum: ['orange', 'airtel', 'afrimoney'] },
                },
                additionalProperties: false,
            },
        },
    }, async (request, reply) => {
        if (!requireAdmin(request.isAdmin)) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        const { id } = request.params;
        // Fetch the settlement request
        const { data: settlement, error: fetchErr } = await fastify.supabase
            .from('merchant_settlement_requests')
            .select('id, merchant_id, amount, phone, status')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr || !settlement) {
            return reply.status(404).send({ error: 'Settlement request not found', statusCode: 404 });
        }
        if (settlement.status !== 'pending_admin_review') {
            return reply.status(409).send({
                error: 'SETTLEMENT_NOT_REVIEWABLE',
                message: `Settlement status is '${settlement.status}', expected 'pending_admin_review'.`,
                statusCode: 409,
            });
        }
        // Validate phone
        if (!(0, phone_normalization_js_1.isValidDrcPhone)(settlement.phone)) {
            return reply.status(400).send({
                error: 'INVALID_SETTLEMENT_PHONE',
                message: 'Le numéro de règlement est invalide.',
                statusCode: 400,
            });
        }
        // Operator: explicit admin choice, otherwise detected from the phone
        // prefix. No implicit 'orange' default — a wrong operator is rejected
        // by the provider (701 MSISDN2 INCORRECT) and strands the settlement.
        const explicitOperator = request.body?.operator;
        const operator = (explicitOperator ?? (0, phone_normalization_js_1.detectOperatorFromPhone)(settlement.phone));
        if (!operator) {
            return reply.status(400).send({
                error: 'OPERATOR_UNDETECTABLE',
                message: 'Impossible de déterminer l\'opérateur du numéro de règlement. Passez operator explicitement.',
                statusCode: 400,
            });
        }
        if (explicitOperator) {
            const match = (0, phone_normalization_js_1.validatePhoneOperatorMatch)(settlement.phone, explicitOperator);
            if (!match.ok) {
                return reply.status(400).send({
                    error: 'OPERATOR_PHONE_MISMATCH',
                    message: match.message,
                    detected_operator: match.detected,
                    statusCode: 400,
                });
            }
        }
        const normalizedPhone = (0, phone_normalization_js_1.normalizePhoneForOperator)(settlement.phone, operator);
        // Mark as processing
        await fastify.supabase
            .from('merchant_settlement_requests')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', id);
        try {
            fastify.log.info({ requestId: id, merchantId: settlement.merchant_id, amount: settlement.amount, phone: normalizedPhone, operator }, '[admin/settlements] approve — triggering B2C payout');
            const payoutRes = await (0, avada_js_1.initiatePayout)(operator, normalizedPhone, Number(settlement.amount), `STL-${id.slice(0, 8).toUpperCase()}`, 'CDF');
            // Create a transactions row linked to the settlement request so
            // the callback can find it and propagate the terminal status.
            const settlementRef = `STL-${id.slice(0, 8).toUpperCase()}`;
            const { error: txInsertErr } = await fastify.supabase
                .from('transactions')
                .insert({
                id: node_crypto_1.default.randomUUID(),
                merchant_id: settlement.merchant_id,
                operator,
                phone: normalizedPhone,
                amount: Number(settlement.amount),
                fee: 0,
                net_amount: Number(settlement.amount),
                currency: 'CDF',
                reference: settlementRef,
                avada_transaction_id: payoutRes.avada_transaction_id,
                status: 'processing',
                direction: 'payout',
                metadata: { source: 'admin_settlement_approve' },
                settlement_request_id: id,
            });
            if (txInsertErr) {
                fastify.log.error({ err: txInsertErr, requestId: id }, '[admin/settlements] transactions insert failed — settlement will not receive callback');
            }
            // Mark settlement as processing (NOT success) — the callback
            // will call mark_settlement_success/failed via the RPC.
            await (0, settlement_rpc_helpers_js_1.markSettlementProcessing)(fastify.supabase, id, payoutRes.avada_transaction_id);
            void (0, admin_action_log_js_1.logAdminAction)(fastify.supabase, 'settlement.approve', 'settlement', id, { merchant_id: settlement.merchant_id, amount: settlement.amount, operator, phone: normalizedPhone }, fastify.log);
            return reply.send({
                approved: true,
                request_id: id,
                provider_ref: payoutRes.avada_transaction_id,
                status: 'processing',
            });
        }
        catch (err) {
            fastify.log.error({ err: err?.message, requestId: id }, '[admin/settlements] approve — payout failed');
            await (0, settlement_rpc_helpers_js_1.markSettlementFailed)(fastify.supabase, id, `Payout failed: ${err?.message ?? 'unknown'}`);
            return reply.status(502).send({
                error: 'PAYOUT_FAILED',
                message: 'Le payout a échoué. Le solde a été recrédité au marchand.',
                request_id: id,
                statusCode: 502,
            });
        }
    });
    /* ── POST /v1/admin/settlements/:id/reject ─────────────────── */
    fastify.post('/admin/settlements/:id/reject', {
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                },
            },
            body: {
                type: 'object',
                required: ['reason'],
                properties: {
                    reason: { type: 'string', minLength: 1, maxLength: 500 },
                },
                additionalProperties: false,
            },
        },
    }, async (request, reply) => {
        if (!requireAdmin(request.isAdmin)) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        const { id } = request.params;
        const { reason } = request.body;
        try {
            const result = await (0, settlement_rpc_helpers_js_1.rejectSettlement)(fastify.supabase, id, reason);
            void (0, admin_action_log_js_1.logAdminAction)(fastify.supabase, 'settlement.reject', 'settlement', id, { reason }, fastify.log);
            return reply.send({
                rejected: true,
                request_id: id,
                recredited: result.recredited,
                balance_after: result.balance_after,
            });
        }
        catch (err) {
            const msg = err?.message ?? '';
            if (msg.includes('SETTLEMENT_NOT_FOUND')) {
                return reply.status(404).send({ error: 'Settlement request not found', statusCode: 404 });
            }
            if (msg.includes('SETTLEMENT_ALREADY_TERMINAL')) {
                return reply.status(409).send({
                    error: 'SETTLEMENT_ALREADY_TERMINAL',
                    message: 'Ce règlement est déjà dans un état terminal.',
                    statusCode: 409,
                });
            }
            fastify.log.error({ err, requestId: id }, '[admin/settlements] reject failed');
            return reply.status(500).send({ error: 'Rejection failed', statusCode: 500 });
        }
    });
};
exports.default = adminSettlementRoute;
//# sourceMappingURL=settlements.js.map