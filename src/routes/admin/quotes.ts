/**
 * Admin routes — Quotes (devis)
 *
 * POST   /v1/admin/quotes               — créer un devis (multipart avec fichier optionnel)
 * GET    /v1/admin/quotes               — liste filtrable (status, creditor_id)
 * PATCH  /v1/admin/quotes/:id           — éditer (montant, statut, validité, notes)
 * POST   /v1/admin/quotes/:id/accept    — accepter → crée automatiquement une dev_expense
 * POST   /v1/admin/quotes/:id/reject    — rejeter
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 * Storage: bucket dev-expenses-invoices, sous-dossier quotes/
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

/* ── File upload constraints ──────────────────────────────── */
const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_BYTES    = 10 * 1024 * 1024; // 10 MB

/* ── Validation patterns ──────────────────────────────────── */
const DATE_RE  = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Zod schemas ──────────────────────────────────────────── */
const createSchema = z.object({
  creditor_id:   z.string().uuid().optional(),
  creditor_name: z.string().min(1).max(200).trim().optional(),
  project_ref:   z.string().min(1).max(200).trim(),
  category:      z.string().max(200).trim().optional(),
  amount_usd:    z.number().min(0).max(99_999.99),
  description:   z.string().max(1000).optional(),
  valid_until:   z.string().regex(DATE_RE, 'Expected YYYY-MM-DD').optional(),
  notes:         z.string().max(500).optional(),
}).refine(d => d.creditor_id || d.creditor_name, {
  message: 'Either creditor_id or creditor_name is required',
  path: ['creditor_id'],
});

const patchSchema = z.object({
  amount_usd:  z.number().min(0).max(99_999.99).optional(),
  status:      z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).optional(),
  valid_until: z.string().regex(DATE_RE).optional(),
  description: z.string().max(1000).optional(),
  notes:       z.string().max(500).optional(),
});

const acceptSchema = z.object({
  due_date:       z.string().regex(DATE_RE, 'Expected YYYY-MM-DD'),
  billing_month:  z.string().regex(MONTH_RE, 'Expected YYYY-MM-01').optional(),
  invoice_number: z.string().max(100).optional(),
});

/* ── Helpers ──────────────────────────────────────────────── */
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.isAdmin) {
    reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    return false;
  }
  return true;
}

async function getOrCreateCreditor(
  fastify: any,
  name: string,
  entityType = 'company',
  defaultCategory?: string,
): Promise<string | null> {
  const { data: existing } = await fastify.supabase
    .from('creditors')
    .select('id')
    .ilike('name', name)
    .eq('active', true)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await fastify.supabase
    .from('creditors')
    .insert({ name, entity_type: entityType, default_category: defaultCategory ?? null, active: true })
    .select('id')
    .single();
  if (error) {
    fastify.log.error({ err: error, name }, '[quotes] getOrCreateCreditor failed');
    return null;
  }
  return created?.id ?? null;
}

/* ── Route plugin ─────────────────────────────────────────── */
const adminQuotesRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /admin/quotes ──────────────────────────────────── */
  fastify.post('/admin/quotes', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parts = request.parts();
    const fields: Record<string, string> = {};
    let quoteFile: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    for await (const part of parts) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        quoteFile = { buffer, filename: part.filename, mimetype: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const parse = createSchema.safeParse({
      creditor_id:   fields.creditor_id   || undefined,
      creditor_name: fields.creditor_name || undefined,
      project_ref:   fields.project_ref   ?? '',
      category:      fields.category      || undefined,
      amount_usd:    parseFloat(fields.amount_usd ?? '0'),
      description:   fields.description   || undefined,
      valid_until:   fields.valid_until   || undefined,
      notes:         fields.notes         || undefined,
    });

    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    const { creditor_id: cid, creditor_name, project_ref, category, amount_usd, description, valid_until, notes } = parse.data;

    // Validate file
    if (quoteFile) {
      if (!ALLOWED_MIME.has(quoteFile.mimetype)) {
        return reply.status(400).send({ error: 'Quote file must be PDF, PNG, or JPEG' });
      }
      if (quoteFile.buffer.length > MAX_BYTES) {
        return reply.status(400).send({ error: 'Quote file exceeds 10 MB limit' });
      }
    }

    // Resolve / create creditor
    let creditorId = cid;
    if (!creditorId && creditor_name) {
      const resolved = await getOrCreateCreditor(fastify, creditor_name, 'company', category);
      if (!resolved) return reply.status(500).send({ error: 'Could not create creditor' });
      creditorId = resolved;
    }

    // Upload quote file under quotes/ subfolder
    let quoteFileUrl: string | null = null;
    if (quoteFile) {
      const safeName = quoteFile.filename
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_')
        .slice(0, 100) || 'quote';
      const filePath = `quotes/${Date.now()}-${safeName}`;
      const { error: upErr } = await fastify.supabase.storage
        .from('dev-expenses-invoices')
        .upload(filePath, quoteFile.buffer, { contentType: quoteFile.mimetype });
      if (upErr) {
        fastify.log.error({ err: upErr }, '[quotes] file upload failed');
        return reply.status(500).send({ error: 'Quote file upload failed' });
      }
      quoteFileUrl = filePath;
    }

    const { data, error } = await fastify.supabase
      .from('quotes')
      .insert({
        creditor_id:    creditorId    ?? null,
        creditor_name:  creditorId ? null : (creditor_name ?? null),
        project_ref,
        category:       category      ?? null,
        amount_usd,
        description:    description   ?? null,
        valid_until:    valid_until   ?? null,
        quote_file_url: quoteFileUrl,
        notes:          notes         ?? null,
        status:         'draft',
      })
      .select()
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[quotes] insert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.status(201).send({ quote: data });
  });

  /* ── GET /admin/quotes ───────────────────────────────────── */
  fastify.get<{ Querystring: { status?: string; creditor_id?: string } }>(
    '/admin/quotes',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const { status, creditor_id } = request.query;
      if (creditor_id && !UUID_RE.test(creditor_id)) {
        return reply.status(400).send({ error: 'creditor_id must be a UUID' });
      }

      let q = fastify.supabase
        .from('quotes')
        .select('*, creditors ( id, name, entity_type )')
        .order('created_at', { ascending: false });

      if (status)      q = q.eq('status', status);
      if (creditor_id) q = q.eq('creditor_id', creditor_id);

      const { data, error } = await q;
      if (error) {
        fastify.log.error({ err: error }, '[quotes] list failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { data: data ?? [] };
    },
  );

  /* ── PATCH /admin/quotes/:id ─────────────────────────────── */
  fastify.patch<{ Params: { id: string } }>(
    '/admin/quotes/:id',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid quote id (expected UUID)' });
      }

      const parse = patchSchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
      }

      const { data: existing } = await fastify.supabase
        .from('quotes')
        .select('id, status')
        .eq('id', request.params.id)
        .maybeSingle();

      if (!existing) return reply.status(404).send({ error: 'Quote not found' });
      if (existing.status === 'accepted') {
        return reply.status(400).send({ error: 'Accepted quotes cannot be modified' });
      }

      const { data, error } = await fastify.supabase
        .from('quotes')
        .update({ ...parse.data, updated_at: new Date().toISOString() })
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) {
        fastify.log.error({ err: error }, '[quotes] patch failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { quote: data };
    },
  );

  /* ── POST /admin/quotes/:id/accept ──────────────────────────
   * Crée une dev_expense à partir du devis et marque le devis accepted.
   * converted_expense_id est renseigné pour permettre le lien "→ voir dans À payer".
   * ─────────────────────────────────────────────────────────── */
  fastify.post<{ Params: { id: string } }>(
    '/admin/quotes/:id/accept',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid quote id (expected UUID)' });
      }

      const parse = acceptSchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
      }

      const { due_date, billing_month, invoice_number } = parse.data;

      const { data: quote, error: qErr } = await fastify.supabase
        .from('quotes')
        .select('*')
        .eq('id', request.params.id)
        .maybeSingle();

      if (qErr || !quote) return reply.status(404).send({ error: 'Quote not found' });
      if (quote.status === 'accepted') {
        return reply.status(400).send({ error: 'Quote already accepted' });
      }
      if (quote.status === 'rejected') {
        return reply.status(400).send({ error: 'Cannot accept a rejected quote' });
      }

      // Derive billing_month from due_date if not provided
      const effectiveBillingMonth = billing_month ?? (due_date.slice(0, 7) + '-01');

      // Create the dev_expense
      const { data: expense, error: expErr } = await fastify.supabase
        .from('dev_expenses')
        .insert({
          creditor_id:    quote.creditor_id ?? null,
          category:       quote.category    ?? quote.project_ref,
          billing_month:  effectiveBillingMonth,
          amount_usd:     quote.amount_usd,
          source:         'quote',
          status:         'pending',
          project_ref:    quote.project_ref,
          due_date,
          invoice_number: invoice_number ?? null,
          notes:          quote.notes    ?? null,
        })
        .select()
        .single();

      if (expErr) {
        fastify.log.error({ err: expErr }, '[quotes] accept: expense insert failed');
        return reply.status(500).send({ error: 'Could not create expense from quote' });
      }

      // Update quote: mark accepted, set converted_expense_id
      const { data: updatedQuote, error: upErr } = await fastify.supabase
        .from('quotes')
        .update({
          status:               'accepted',
          converted_expense_id: expense.id,
          updated_at:           new Date().toISOString(),
        })
        .eq('id', request.params.id)
        .select()
        .single();

      if (upErr) {
        fastify.log.error({ err: upErr }, '[quotes] accept: quote update failed');
        return reply.status(500).send({ error: 'Expense created but quote update failed' });
      }

      fastify.log.info({ quoteId: request.params.id, expenseId: expense.id }, '[quotes] accepted → expense created');
      return { quote: updatedQuote, expense };
    },
  );

  /* ── POST /admin/quotes/:id/reject ──────────────────────────── */
  fastify.post<{ Params: { id: string } }>(
    '/admin/quotes/:id/reject',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid quote id (expected UUID)' });
      }

      const { data: quote } = await fastify.supabase
        .from('quotes')
        .select('id, status')
        .eq('id', request.params.id)
        .maybeSingle();

      if (!quote) return reply.status(404).send({ error: 'Quote not found' });
      if (quote.status === 'accepted') {
        return reply.status(400).send({ error: 'Cannot reject an already accepted quote' });
      }

      const { data, error } = await fastify.supabase
        .from('quotes')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) {
        fastify.log.error({ err: error }, '[quotes] reject failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { quote: data };
    },
  );
};

export default adminQuotesRoute;
