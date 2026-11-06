"use strict";
/**
 * Admin routes — Expense Entities (V4)
 *
 * GET    /v1/admin/expense-entities       — list (filterable: active, entity_type)
 * POST   /v1/admin/expense-entities       — create entity
 * PATCH  /v1/admin/expense-entities/:id   — update entity
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 * No DELETE: entities referenced by financial data cannot be physically deleted.
 * Soft-delete via active=false is supported through PATCH.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const dev_expenses_v4_1 = require("../../services/dev-expenses-v4");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const createSchema = zod_1.z.object({
    code: zod_1.z.string().min(1).max(100).trim(),
    display_name: zod_1.z.string().min(1).max(200).trim(),
    entity_type: zod_1.z.enum(['person', 'company', 'partner_group', 'project', 'other']),
    legal_name: zod_1.z.string().max(200).optional(),
    trade_name: zod_1.z.string().max(200).optional(),
    country_code: zod_1.z.string().max(10).optional(),
    email: zod_1.z.string().max(200).optional(),
    phone: zod_1.z.string().max(50).optional(),
    address: zod_1.z.string().max(500).optional(),
    city: zod_1.z.string().max(100).optional(),
    postal_code: zod_1.z.string().max(20).optional(),
    tax_id: zod_1.z.string().max(100).optional(),
    // New legal profile fields
    registration_number: zod_1.z.string().max(100).optional(),
    vat_number: zod_1.z.string().max(100).optional(),
    address_line_1: zod_1.z.string().max(500).optional(),
    address_line_2: zod_1.z.string().max(500).optional(),
    region: zod_1.z.string().max(100).optional(),
    contact_name: zod_1.z.string().max(200).optional(),
    billing_email: zod_1.z.string().max(200).optional(),
    contact_email: zod_1.z.string().max(200).optional(),
    website: zod_1.z.string().max(500).optional(),
    legal_notes: zod_1.z.string().max(2000).optional(),
    // Role capabilities
    can_incur_expenses: zod_1.z.boolean().default(true),
    can_receive_invoices: zod_1.z.boolean().default(true),
    can_pay_expenses: zod_1.z.boolean().default(true),
    can_cover_expenses: zod_1.z.boolean().default(true),
    can_receive_reimbursements: zod_1.z.boolean().default(true),
    // Sensitive
    bank_details: zod_1.z.record(zod_1.z.unknown()).default({}),
    active: zod_1.z.boolean().default(true),
    metadata: zod_1.z.record(zod_1.z.unknown()).default({}),
}).strict();
const patchSchema = zod_1.z.object({
    display_name: zod_1.z.string().min(1).max(200).trim().optional(),
    entity_type: zod_1.z.enum(['person', 'company', 'partner_group', 'project', 'other']).optional(),
    legal_name: zod_1.z.string().max(200).nullable().optional(),
    trade_name: zod_1.z.string().max(200).nullable().optional(),
    country_code: zod_1.z.string().max(10).nullable().optional(),
    email: zod_1.z.string().max(200).nullable().optional(),
    phone: zod_1.z.string().max(50).nullable().optional(),
    address: zod_1.z.string().max(500).nullable().optional(),
    city: zod_1.z.string().max(100).nullable().optional(),
    postal_code: zod_1.z.string().max(20).nullable().optional(),
    tax_id: zod_1.z.string().max(100).nullable().optional(),
    // New legal profile fields
    registration_number: zod_1.z.string().max(100).nullable().optional(),
    vat_number: zod_1.z.string().max(100).nullable().optional(),
    address_line_1: zod_1.z.string().max(500).nullable().optional(),
    address_line_2: zod_1.z.string().max(500).nullable().optional(),
    region: zod_1.z.string().max(100).nullable().optional(),
    contact_name: zod_1.z.string().max(200).nullable().optional(),
    billing_email: zod_1.z.string().max(200).nullable().optional(),
    contact_email: zod_1.z.string().max(200).nullable().optional(),
    website: zod_1.z.string().max(500).nullable().optional(),
    legal_notes: zod_1.z.string().max(2000).nullable().optional(),
    // Role capabilities
    can_incur_expenses: zod_1.z.boolean().optional(),
    can_receive_invoices: zod_1.z.boolean().optional(),
    can_pay_expenses: zod_1.z.boolean().optional(),
    can_cover_expenses: zod_1.z.boolean().optional(),
    can_receive_reimbursements: zod_1.z.boolean().optional(),
    // Sensitive
    bank_details: zod_1.z.record(zod_1.z.unknown()).nullable().optional(),
    active: zod_1.z.boolean().optional(),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
}).strict();
function requireAdmin(request, reply) {
    if (!request.isAdmin) {
        reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        return false;
    }
    return true;
}
const adminExpenseEntitiesRoute = async (fastify) => {
    /* ── GET /admin/expense-entities ───────────────────────── */
    fastify.get('/admin/expense-entities', async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        // Exclude bank_details from list responses
        let q = fastify.supabase.from('expense_entities').select(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS);
        if (request.query.active !== undefined) {
            q = q.eq('active', request.query.active !== 'false');
        }
        if (request.query.entity_type) {
            q = q.eq('entity_type', request.query.entity_type);
        }
        if (request.query.can_incur_expenses !== undefined) {
            q = q.eq('can_incur_expenses', request.query.can_incur_expenses === 'true');
        }
        if (request.query.can_receive_invoices !== undefined) {
            q = q.eq('can_receive_invoices', request.query.can_receive_invoices === 'true');
        }
        if (request.query.can_pay_expenses !== undefined) {
            q = q.eq('can_pay_expenses', request.query.can_pay_expenses === 'true');
        }
        if (request.query.can_cover_expenses !== undefined) {
            q = q.eq('can_cover_expenses', request.query.can_cover_expenses === 'true');
        }
        if (request.query.can_receive_reimbursements !== undefined) {
            q = q.eq('can_receive_reimbursements', request.query.can_receive_reimbursements === 'true');
        }
        if (request.query.country_code) {
            q = q.eq('country_code', request.query.country_code);
        }
        if (request.query.search) {
            const s = request.query.search.trim();
            q = q.or(`display_name.ilike.%${s}%,legal_name.ilike.%${s}%,trade_name.ilike.%${s}%,registration_number.ilike.%${s}%,tax_id.ilike.%${s}%,vat_number.ilike.%${s}%,billing_email.ilike.%${s}%,city.ilike.%${s}%`);
        }
        const { data, error } = await q.order('display_name');
        if (error) {
            fastify.log.error({ err: error }, '[expense-entities] list failed');
            return reply.status(500).send({ error: 'Internal Server Error' });
        }
        return { items: data ?? [] };
    });
    /* ── POST /admin/expense-entities ──────────────────────── */
    fastify.post('/admin/expense-entities', async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const parse = createSchema.safeParse(request.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
        }
        const { data, error } = await fastify.supabase
            .from('expense_entities')
            .insert(parse.data)
            .select(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS)
            .single();
        if (error) {
            if (error.code === '23505') {
                return reply.status(409).send({ error: 'Entity code already exists', code: 'ENTITY_CODE_CONFLICT' });
            }
            fastify.log.error({ err: error }, '[expense-entities] insert failed');
            return reply.status(500).send({ error: 'Internal Server Error' });
        }
        return reply.status(201).send({ entity: data });
    });
    /* ── PATCH /admin/expense-entities/:id ─────────────────── */
    fastify.patch('/admin/expense-entities/:id', async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        if (!UUID_RE.test(request.params.id)) {
            return reply.status(400).send({ error: 'Invalid entity id (expected UUID)' });
        }
        const parse = patchSchema.safeParse(request.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
        }
        if (Object.keys(parse.data).length === 0) {
            return reply.status(400).send({ error: 'No fields to update' });
        }
        const { data, error } = await fastify.supabase
            .from('expense_entities')
            .update(parse.data)
            .eq('id', request.params.id)
            .select(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS)
            .single();
        if (error) {
            fastify.log.error({ err: error }, '[expense-entities] patch failed');
            return reply.status(500).send({ error: 'Internal Server Error' });
        }
        if (!data)
            return reply.status(404).send({ error: 'Entity not found' });
        return { entity: data };
    });
};
exports.default = adminExpenseEntitiesRoute;
//# sourceMappingURL=expense-entities.js.map