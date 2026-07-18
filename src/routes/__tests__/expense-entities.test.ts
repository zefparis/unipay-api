/**
 * Tests for expense-entities Zod schema validation
 * Run with: npx tsx --test src/routes/__tests__/expense-entities.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/* Replicate the createSchema from the route for testing */
const createSchema = z.object({
  code: z.string().min(1).max(100).trim(),
  display_name: z.string().min(1).max(200).trim(),
  entity_type: z.enum(['person', 'company', 'partner_group', 'project', 'other']),
  legal_name: z.string().max(200).optional(),
  trade_name: z.string().max(200).optional(),
  country_code: z.string().max(10).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  tax_id: z.string().max(100).optional(),
  registration_number: z.string().max(100).optional(),
  vat_number: z.string().max(100).optional(),
  address_line_1: z.string().max(500).optional(),
  address_line_2: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  contact_name: z.string().max(200).optional(),
  billing_email: z.string().max(200).optional(),
  contact_email: z.string().max(200).optional(),
  website: z.string().max(500).optional(),
  legal_notes: z.string().max(2000).optional(),
  can_incur_expenses: z.boolean().default(true),
  can_receive_invoices: z.boolean().default(true),
  can_pay_expenses: z.boolean().default(true),
  can_cover_expenses: z.boolean().default(true),
  can_receive_reimbursements: z.boolean().default(true),
  bank_details: z.record(z.unknown()).default({}),
  active: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
}).strict();

describe('Expense entity createSchema', () => {
  it('accepts a valid entity with all fields', () => {
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
    assert.equal(result.success, true);
  });

  it('accepts a minimal entity with only required fields', () => {
    const result = createSchema.safeParse({
      code: 'test_entity',
      display_name: 'Test Entity',
      entity_type: 'company',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.can_incur_expenses, true);
      assert.equal(result.data.active, true);
      assert.deepEqual(result.data.bank_details, {});
    }
  });

  it('rejects empty code', () => {
    const result = createSchema.safeParse({
      code: '',
      display_name: 'Test',
      entity_type: 'company',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty display_name', () => {
    const result = createSchema.safeParse({
      code: 'test',
      display_name: '',
      entity_type: 'company',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid entity_type', () => {
    const result = createSchema.safeParse({
      code: 'test',
      display_name: 'Test',
      entity_type: 'association',
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = createSchema.safeParse({
      code: 'test',
      display_name: 'Test',
      entity_type: 'company',
      unknown_field: 'value',
    });
    assert.equal(result.success, false);
  });

  it('accepts numeric code like 001', () => {
    const result = createSchema.safeParse({
      code: '001',
      display_name: 'Test',
      entity_type: 'company',
    });
    assert.equal(result.success, true);
  });

  it('trims whitespace from code and display_name', () => {
    const result = createSchema.safeParse({
      code: '  test  ',
      display_name: '  Test  ',
      entity_type: 'company',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.code, 'test');
      assert.equal(result.data.display_name, 'Test');
    }
  });

  it('accepts all valid entity_type values', () => {
    for (const type of ['person', 'company', 'partner_group', 'project', 'other']) {
      const result = createSchema.safeParse({
        code: 'test',
        display_name: 'Test',
        entity_type: type,
      });
      assert.equal(result.success, true, `entity_type=${type} should be valid`);
    }
  });

  it('applies defaults for booleans when not provided', () => {
    const result = createSchema.safeParse({
      code: 'test',
      display_name: 'Test',
      entity_type: 'company',
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.can_incur_expenses, true);
      assert.equal(result.data.can_receive_invoices, true);
      assert.equal(result.data.can_pay_expenses, true);
      assert.equal(result.data.can_cover_expenses, true);
      assert.equal(result.data.can_receive_reimbursements, true);
      assert.equal(result.data.active, true);
    }
  });

  it('accepts explicit boolean false for role flags', () => {
    const result = createSchema.safeParse({
      code: 'test',
      display_name: 'Test',
      entity_type: 'company',
      can_incur_expenses: false,
      active: false,
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.can_incur_expenses, false);
      assert.equal(result.data.active, false);
    }
  });

  it('rejects code exceeding 100 chars', () => {
    const result = createSchema.safeParse({
      code: 'a'.repeat(101),
      display_name: 'Test',
      entity_type: 'company',
    });
    assert.equal(result.success, false);
  });

  it('rejects display_name exceeding 200 chars', () => {
    const result = createSchema.safeParse({
      code: 'test',
      display_name: 'a'.repeat(201),
      entity_type: 'company',
    });
    assert.equal(result.success, false);
  });
});
