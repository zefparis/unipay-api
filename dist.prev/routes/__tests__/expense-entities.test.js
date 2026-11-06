"use strict";
/**
 * Tests for expense-entities Zod schema validation
 * Run with: npx tsx --test src/routes/__tests__/expense-entities.test.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const zod_1 = require("zod");
/* Replicate the createSchema from the route for testing */
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
    can_incur_expenses: zod_1.z.boolean().default(true),
    can_receive_invoices: zod_1.z.boolean().default(true),
    can_pay_expenses: zod_1.z.boolean().default(true),
    can_cover_expenses: zod_1.z.boolean().default(true),
    can_receive_reimbursements: zod_1.z.boolean().default(true),
    bank_details: zod_1.z.record(zod_1.z.unknown()).default({}),
    active: zod_1.z.boolean().default(true),
    metadata: zod_1.z.record(zod_1.z.unknown()).default({}),
}).strict();
(0, node_test_1.describe)('Expense entity createSchema', () => {
    (0, node_test_1.it)('accepts a valid entity with all fields', () => {
        const result = createSchema.safeParse({
            code: 'ia_solution',
            display_name: 'IA-Solution',
            entity_type: 'company',
            legal_name: 'IA SOLUTION',
            trade_name: 'UnipayCongo',
            country_code: 'FR',
            address_line_1: '2 rue du sabotier',
            postal_code: '30350',
            city: 'Saint Benezet',
            region: 'Gard',
            billing_email: 'contact@ia-solution.fr',
            contact_email: 'contact@ia-solution.fr',
            phone: '0758060556',
            website: 'https://www.ia-solution.fr',
            registration_number: 'RCCM',
            tax_id: 'NIF',
        });
        strict_1.default.equal(result.success, true);
    });
    (0, node_test_1.it)('accepts a minimal entity with only required fields', () => {
        const result = createSchema.safeParse({
            code: 'test_entity',
            display_name: 'Test Entity',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, true);
        if (result.success) {
            strict_1.default.equal(result.data.can_incur_expenses, true);
            strict_1.default.equal(result.data.active, true);
            strict_1.default.deepEqual(result.data.bank_details, {});
        }
    });
    (0, node_test_1.it)('rejects empty code', () => {
        const result = createSchema.safeParse({
            code: '',
            display_name: 'Test',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, false);
    });
    (0, node_test_1.it)('rejects empty display_name', () => {
        const result = createSchema.safeParse({
            code: 'test',
            display_name: '',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, false);
    });
    (0, node_test_1.it)('rejects invalid entity_type', () => {
        const result = createSchema.safeParse({
            code: 'test',
            display_name: 'Test',
            entity_type: 'association',
        });
        strict_1.default.equal(result.success, false);
    });
    (0, node_test_1.it)('rejects unknown fields (strict mode)', () => {
        const result = createSchema.safeParse({
            code: 'test',
            display_name: 'Test',
            entity_type: 'company',
            unknown_field: 'value',
        });
        strict_1.default.equal(result.success, false);
    });
    (0, node_test_1.it)('accepts numeric code like 001', () => {
        const result = createSchema.safeParse({
            code: '001',
            display_name: 'Test',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, true);
    });
    (0, node_test_1.it)('trims whitespace from code and display_name', () => {
        const result = createSchema.safeParse({
            code: '  test  ',
            display_name: '  Test  ',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, true);
        if (result.success) {
            strict_1.default.equal(result.data.code, 'test');
            strict_1.default.equal(result.data.display_name, 'Test');
        }
    });
    (0, node_test_1.it)('accepts all valid entity_type values', () => {
        for (const type of ['person', 'company', 'partner_group', 'project', 'other']) {
            const result = createSchema.safeParse({
                code: 'test',
                display_name: 'Test',
                entity_type: type,
            });
            strict_1.default.equal(result.success, true, `entity_type=${type} should be valid`);
        }
    });
    (0, node_test_1.it)('applies defaults for booleans when not provided', () => {
        const result = createSchema.safeParse({
            code: 'test',
            display_name: 'Test',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, true);
        if (result.success) {
            strict_1.default.equal(result.data.can_incur_expenses, true);
            strict_1.default.equal(result.data.can_receive_invoices, true);
            strict_1.default.equal(result.data.can_pay_expenses, true);
            strict_1.default.equal(result.data.can_cover_expenses, true);
            strict_1.default.equal(result.data.can_receive_reimbursements, true);
            strict_1.default.equal(result.data.active, true);
        }
    });
    (0, node_test_1.it)('accepts explicit boolean false for role flags', () => {
        const result = createSchema.safeParse({
            code: 'test',
            display_name: 'Test',
            entity_type: 'company',
            can_incur_expenses: false,
            active: false,
        });
        strict_1.default.equal(result.success, true);
        if (result.success) {
            strict_1.default.equal(result.data.can_incur_expenses, false);
            strict_1.default.equal(result.data.active, false);
        }
    });
    (0, node_test_1.it)('rejects code exceeding 100 chars', () => {
        const result = createSchema.safeParse({
            code: 'a'.repeat(101),
            display_name: 'Test',
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, false);
    });
    (0, node_test_1.it)('rejects display_name exceeding 200 chars', () => {
        const result = createSchema.safeParse({
            code: 'test',
            display_name: 'a'.repeat(201),
            entity_type: 'company',
        });
        strict_1.default.equal(result.success, false);
    });
});
//# sourceMappingURL=expense-entities.test.js.map