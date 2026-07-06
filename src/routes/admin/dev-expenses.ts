/**
 * Admin routes — Dev Expenses Tracker (v2: generalised creditor/invoice registry)
 *
 * POST   /v1/admin/dev-expenses/pull-automated   — pull Anthropic + Vercel costs (cron)
 * POST   /v1/admin/dev-expenses                  — manual invoice entry with upload
 * PATCH  /v1/admin/dev-expenses/:id/mark-paid    — mark expense as paid
 * POST   /v1/admin/dev-expenses/generate-report  — generate PDF + share token
 * GET    /v1/admin/dev-expenses                  — list (billing_month/status/creditor_id/overdue)
 * GET    /v1/admin/dev-expenses/upcoming         — due within 7 days, status=pending
 * GET    /v1/admin/dev-expenses/history          — paginated monthly history
 *
 * PUBLIC (no admin auth, token-protected):
 * GET    /dev-expenses/report/:token             — read-only report JSON
 *
 * Auth: request.isAdmin (x-admin-secret via HMAC plugin)
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';

/* ── Invoice upload constraints ──────────────────────────── */
const ALLOWED_INVOICE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_INVOICE_BYTES    = 10 * 1024 * 1024; // 10 MB

/* ── Validation patterns ──────────────────────────────────── */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const DATE_RE  = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Zod schemas ──────────────────────────────────────────── */
const pullSchema = z.object({
  month: z.string().regex(MONTH_RE, 'Expected YYYY-MM-01'),
});

const manualSchema = z.object({
  creditor_id:    z.string().uuid().optional(),
  creditor_name:  z.string().min(1).max(200).trim().optional(),
  category:       z.string().min(1).max(200).trim(),
  billing_month:  z.string().regex(MONTH_RE, 'Expected YYYY-MM-01'),
  amount_usd:     z.number().min(0, 'Must be ≥ 0').max(99_999.99, 'Exceeds maximum'),
  project_ref:    z.string().max(200).trim().optional(),
  due_date:       z.string().regex(DATE_RE, 'Expected YYYY-MM-DD').optional(),
  invoice_number: z.string().max(100).trim().optional(),
  notes:          z.string().max(500).optional(),
}).refine(d => d.creditor_id || d.creditor_name, {
  message: 'Either creditor_id or creditor_name is required',
  path: ['creditor_id'],
});

const markPaidSchema = z.object({
  payment_ref: z.string().max(200).trim().optional(),
});

const reportSchema = z.object({
  month: z.string().regex(MONTH_RE, 'Expected YYYY-MM-01'),
});

/* ── DEV_EXPENSES_PUBLIC_ORIGIN ───────────────────────────── */
const PUBLIC_REPORT_ORIGIN = env.DEV_EXPENSES_PUBLIC_ORIGIN;

/* ── Helpers ──────────────────────────────────────────────── */

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.isAdmin) {
    reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    return false;
  }
  return true;
}

function getPreviousMonth(month: string): string {
  const d = new Date(month + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchAnthropicCost(billingMonth: string): Promise<number | null> {
  if (!env.ANTHROPIC_ADMIN_API_KEY) return null;
  try {
    const month = billingMonth.slice(0, 7); // YYYY-MM
    const res = await fetch('https://api.anthropic.com/v1/organizations/usage_costs', {
      headers: {
        'x-api-key': env.ANTHROPIC_ADMIN_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const lineItems = data?.line_items ?? [];
    const match = lineItems.find((item: any) => item.usage_date?.startsWith?.(month));
    if (match) return Number(match.amount) || 0;
    if (Array.isArray(data?.costs)) {
      const total = data.costs
        .filter((c: any) => c.period?.startsWith?.(month))
        .reduce((sum: number, c: any) => sum + Number(c.amount ?? 0), 0);
      return total > 0 ? total : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchVercelCost(billingMonth: string): Promise<number | null> {
  if (!env.VERCEL_API_TOKEN || !env.VERCEL_TEAM_ID) return null;
  try {
    const month = billingMonth.slice(0, 7); // YYYY-MM
    const url = `https://api.vercel.com/v1/teams/${env.VERCEL_TEAM_ID}/billing/usage?month=${month}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.VERCEL_API_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const total = Number(data?.total ?? data?.amount ?? 0);
    return total > 0 ? total / 100 : null; // convert cents → USD
  } catch {
    return null;
  }
}

async function getOrCreateCreditor(
  fastify: any,
  name: string,
  entityType = 'cloud_provider',
  defaultCategory = 'Infra Cloud',
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
    .insert({ name, entity_type: entityType, default_category: defaultCategory, active: true })
    .select('id')
    .single();
  if (error) {
    fastify.log.error({ err: error, name }, '[creditors] getOrCreate failed');
    return null;
  }
  return created?.id ?? null;
}

type PdfExpense = {
  category: string;
  creditor_name: string | null;
  project_ref: string | null;
  amount_usd: number;
  status: string;
  due_date: string | null;
};

async function generatePdf(
  billingMonth: string,
  expenses: PdfExpense[],
  totalUsd: number,
  prevTotal: number | null,
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const promise = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  doc.fontSize(20).font('Helvetica-Bold').text('Dev Expenses Report', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(12).font('Helvetica').text(`Billing Month: ${billingMonth}`, { align: 'center' });
  doc.moveDown(1);

  // Table header
  const colX = [50, 160, 290, 380, 460];
  const tableTop = doc.y;
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('Creditor',          colX[0], tableTop, { width: 105 });
  doc.text('Category / Project', colX[1], tableTop, { width: 125 });
  doc.text('Due Date',           colX[2], tableTop, { width: 85 });
  doc.text('Amount (USD)',        colX[3], tableTop, { width: 75 });
  doc.text('Status',             colX[4], tableTop, { width: 80 });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica');
  for (const exp of expenses) {
    const y = doc.y;
    const label = exp.project_ref ? `${exp.category} — ${exp.project_ref}` : exp.category;
    doc.fontSize(9)
      .text(exp.creditor_name ?? '—', colX[0], y, { width: 105 })
      .text(label,                    colX[1], y, { width: 125 })
      .text(exp.due_date ? exp.due_date.slice(0, 7) : '—', colX[2], y, { width: 85 })
      .text(`$${Number(exp.amount_usd).toFixed(2)}`, colX[3], y, { width: 75 })
      .text(exp.status,               colX[4], y, { width: 80 });
    doc.moveDown(0.5);
  }

  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);
  doc.fontSize(12).font('Helvetica-Bold')
    .text('Total',                    colX[0], doc.y, { width: 105 })
    .text(`$${totalUsd.toFixed(2)}`,  colX[3], doc.y, { width: 75 });

  if (prevTotal !== null && prevTotal > 0) {
    doc.moveDown(0.5);
    const change = ((totalUsd - prevTotal) / prevTotal) * 100;
    const sign = change >= 0 ? '+' : '';
    doc.fontSize(10).font('Helvetica')
      .text(`vs previous month: ${sign}${change.toFixed(1)}% ($${prevTotal.toFixed(2)} → $${totalUsd.toFixed(2)})`);
  }

  doc.moveDown(1);
  doc.fontSize(8).font('Helvetica-Oblique').fillColor('gray')
    .text('Generated by UniPay Dev Expenses Tracker (tekkbridge). Shared via tokenized read-only link.');
  doc.end();

  return promise;
}

/* ── Route plugin ─────────────────────────────────────────── */

const adminDevExpensesRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /admin/dev-expenses/pull-automated ─────────────
   * Called by the Render cron job on the 1st of each month.
   * Auth: x-admin-secret (ADMIN_SECRET). Promise.allSettled ensures
   * a Vercel failure never blocks Anthropic (and vice versa).
   * ──────────────────────────────────────────────────────── */
  fastify.post('/admin/dev-expenses/pull-automated', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = pullSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }
    const { month } = parse.data;

    const [anthropicResult, vercelResult] = await Promise.allSettled([
      (async () => {
        const cost = await fetchAnthropicCost(month);
        if (cost === null) throw new Error('API key missing or endpoint returned no data for this month');

        const creditorId = await getOrCreateCreditor(fastify, 'Anthropic', 'cloud_provider', 'AI API');
        if (!creditorId) throw new Error('Could not get/create Anthropic creditor');

        const { data: existing } = await fastify.supabase
          .from('dev_expenses')
          .select('id')
          .eq('creditor_id', creditorId)
          .eq('billing_month', month)
          .eq('source', 'api_pull')
          .maybeSingle();

        if (existing) {
          const { error } = await fastify.supabase
            .from('dev_expenses')
            .update({ category: 'Anthropic', amount_usd: cost })
            .eq('id', existing.id);
          if (error) throw new Error(`DB update failed: ${error.message}`);
        } else {
          const { error } = await fastify.supabase
            .from('dev_expenses')
            .insert({ creditor_id: creditorId, category: 'Anthropic', billing_month: month, amount_usd: cost, source: 'api_pull', status: 'pending' });
          if (error) throw new Error(`DB insert failed: ${error.message}`);
        }

        return { creditor: 'Anthropic', amount_usd: cost };
      })(),
      (async () => {
        const cost = await fetchVercelCost(month);
        if (cost === null) throw new Error('API token/team_id missing or endpoint returned no data for this month');

        const creditorId = await getOrCreateCreditor(fastify, 'Vercel', 'cloud_provider', 'Infra Cloud');
        if (!creditorId) throw new Error('Could not get/create Vercel creditor');

        const { data: existing } = await fastify.supabase
          .from('dev_expenses')
          .select('id')
          .eq('creditor_id', creditorId)
          .eq('billing_month', month)
          .eq('source', 'api_pull')
          .maybeSingle();

        if (existing) {
          const { error } = await fastify.supabase
            .from('dev_expenses')
            .update({ category: 'Vercel', amount_usd: cost })
            .eq('id', existing.id);
          if (error) throw new Error(`DB update failed: ${error.message}`);
        } else {
          const { error } = await fastify.supabase
            .from('dev_expenses')
            .insert({ creditor_id: creditorId, category: 'Vercel', billing_month: month, amount_usd: cost, source: 'api_pull', status: 'pending' });
          if (error) throw new Error(`DB insert failed: ${error.message}`);
        }

        return { creditor: 'Vercel', amount_usd: cost };
      })(),
    ]);

    const pulled: { creditor: string; amount_usd: number; source: string }[] = [];
    const failed: { creditor: string; reason: string }[] = [];

    if (anthropicResult.status === 'fulfilled') {
      pulled.push({ ...anthropicResult.value, source: 'api_pull' });
    } else {
      failed.push({ creditor: 'Anthropic', reason: String(anthropicResult.reason?.message ?? anthropicResult.reason) });
      fastify.log.warn({ reason: anthropicResult.reason?.message }, '[dev-expenses] anthropic pull failed');
    }
    if (vercelResult.status === 'fulfilled') {
      pulled.push({ ...vercelResult.value, source: 'api_pull' });
    } else {
      failed.push({ creditor: 'Vercel', reason: String(vercelResult.reason?.message ?? vercelResult.reason) });
      fastify.log.warn({ reason: vercelResult.reason?.message }, '[dev-expenses] vercel pull failed');
    }

    return { billing_month: month, pulled, failed };
  });

  /* ── POST /admin/dev-expenses ────────────────────────────
   * Manual invoice entry. Accepts multipart/form-data.
   * creditor_id OR creditor_name required (creates on the fly).
   * ─────────────────────────────────────────────────────── */
  fastify.post('/admin/dev-expenses', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parts = request.parts();
    const fields: Record<string, string> = {};
    let invoiceFile: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    for await (const part of parts) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        invoiceFile = { buffer, filename: part.filename, mimetype: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const parse = manualSchema.safeParse({
      creditor_id:    fields.creditor_id    || undefined,
      creditor_name:  fields.creditor_name  || undefined,
      category:       fields.category       ?? '',
      billing_month:  fields.billing_month  ?? '',
      amount_usd:     parseFloat(fields.amount_usd ?? '0'),
      project_ref:    fields.project_ref    || undefined,
      due_date:       fields.due_date       || undefined,
      invoice_number: fields.invoice_number || undefined,
      notes:          fields.notes          || undefined,
    });

    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    const {
      creditor_id: cid, creditor_name, category, billing_month, amount_usd,
      project_ref, due_date, invoice_number, notes,
    } = parse.data;

    // Resolve or create creditor
    let creditorId = cid;
    if (!creditorId && creditor_name) {
      const resolved = await getOrCreateCreditor(fastify, creditor_name);
      if (!resolved) return reply.status(500).send({ error: 'Could not create creditor' });
      creditorId = resolved;
    }

    // MIME + size validation before storage upload
    if (invoiceFile) {
      if (!ALLOWED_INVOICE_MIME.has(invoiceFile.mimetype)) {
        return reply.status(400).send({ error: 'Invoice must be PDF, PNG, or JPEG', allowed: [...ALLOWED_INVOICE_MIME] });
      }
      if (invoiceFile.buffer.length > MAX_INVOICE_BYTES) {
        return reply.status(400).send({ error: 'Invoice file exceeds 10 MB limit' });
      }
    }

    let invoiceUrl: string | null = null;

    if (invoiceFile) {
      const safeFilename = invoiceFile.filename
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_')
        .slice(0, 100) || 'invoice';
      const safeCategory = category.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40);
      const filePath = `${billing_month}/${safeCategory}-${Date.now()}-${safeFilename}`;
      const { error: upErr } = await fastify.supabase.storage
        .from('dev-expenses-invoices')
        .upload(filePath, invoiceFile.buffer, { contentType: invoiceFile.mimetype });
      if (upErr) {
        fastify.log.error({ err: upErr }, '[dev-expenses] invoice upload failed');
        return reply.status(500).send({ error: 'Invoice upload failed' });
      }
      invoiceUrl = filePath;
    }

    const { data, error } = await fastify.supabase
      .from('dev_expenses')
      .insert({
        creditor_id:    creditorId ?? null,
        category,
        billing_month,
        amount_usd,
        source:         'manual',
        invoice_url:    invoiceUrl,
        project_ref:    project_ref    ?? null,
        due_date:       due_date       ?? null,
        invoice_number: invoice_number ?? null,
        notes:          notes          ?? null,
        status:         'pending',
      })
      .select()
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[dev-expenses] insert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.status(201).send({ expense: data });
  });

  /* ── PATCH /admin/dev-expenses/:id/mark-paid ────────────── */
  fastify.patch<{ Params: { id: string } }>('/admin/dev-expenses/:id/mark-paid', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    const parse = markPaidSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    const { data, error } = await fastify.supabase
      .from('dev_expenses')
      .update({ status: 'paid', paid_at: new Date().toISOString(), payment_ref: parse.data.payment_ref ?? null })
      .eq('id', request.params.id)
      .select()
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[dev-expenses] mark-paid failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    if (!data) return reply.status(404).send({ error: 'Expense not found' });

    return { expense: data };
  });

  /* ── POST /admin/dev-expenses/generate-report ────────────
   * Aggregates all expenses whose billing_month OR due_date falls
   * in the requested month. Generation is never blocked by pending
   * status — pending items produce a warning list in the response.
   * ─────────────────────────────────────────────────────── */
  fastify.post('/admin/dev-expenses/generate-report', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = reportSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }
    const { month } = parse.data;

    // Month date range for due_date filter
    const [year, mon] = month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10); // first of next month

    // Expenses: billing_month = month OR due_date within the month
    const { data: expenses, error: expErr } = await fastify.supabase
      .from('dev_expenses_with_status')
      .select('id, category, creditor_name, project_ref, amount_usd, status, due_date, is_overdue')
      .eq('archived', false)
      .or(`billing_month.eq.${month},and(due_date.gte.${month},due_date.lt.${monthEnd})`);

    if (expErr) {
      fastify.log.error({ err: expErr }, '[dev-expenses] generate-report query failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    if (!expenses || expenses.length === 0) {
      return reply.status(400).send({ error: 'No expenses found for this month' });
    }

    const totalUsd = expenses.reduce((sum, e) => sum + Number(e.amount_usd), 0);

    // Non-blocking warning: list pending invoices
    const pendingWarnings = expenses
      .filter(e => e.status === 'pending')
      .map(e => ({
        category:     e.category,
        creditor_name: e.creditor_name ?? null,
        amount_usd:   Number(e.amount_usd),
        due_date:     e.due_date ?? null,
      }));

    // Previous month for comparison
    const prevMonth = getPreviousMonth(month);
    const { data: prevExpenses } = await fastify.supabase
      .from('dev_expenses')
      .select('amount_usd')
      .eq('billing_month', prevMonth);

    const prevTotal = prevExpenses && prevExpenses.length > 0
      ? prevExpenses.reduce((sum, e) => sum + Number(e.amount_usd), 0)
      : null;

    // Generate PDF
    const pdfBuffer = await generatePdf(
      month,
      expenses.map(e => ({
        category:     e.category,
        creditor_name: e.creditor_name ?? null,
        project_ref:  e.project_ref ?? null,
        amount_usd:   Number(e.amount_usd),
        status:       e.status,
        due_date:     e.due_date ?? null,
      })),
      totalUsd,
      prevTotal,
    );

    const pdfPath = `reports/${month}.pdf`;
    const { error: pdfUpErr } = await fastify.supabase.storage
      .from('dev-expenses-invoices')
      .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (pdfUpErr) {
      fastify.log.error({ err: pdfUpErr }, '[dev-expenses] PDF upload failed');
      return reply.status(500).send({ error: 'PDF upload failed' });
    }

    const { data: report, error: repErr } = await fastify.supabase
      .from('dev_expenses_reports')
      .upsert(
        { billing_month: month, total_usd: totalUsd, report_pdf_url: pdfPath },
        { onConflict: 'billing_month' },
      )
      .select()
      .single();

    if (repErr) {
      fastify.log.error({ err: repErr }, '[dev-expenses] report upsert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return {
      report,
      share_url:            `${PUBLIC_REPORT_ORIGIN}/report/${report.share_token}`,
      total_usd:            totalUsd,
      previous_month_total: prevTotal,
      pending_warnings:     pendingWarnings,
    };
  });

  /* ── GET /admin/dev-expenses ─────────────────────────────
   * Extended filters: billing_month, status, creditor_id, overdue, archived
   * archived=true  → show only archived rows (archive view)
   * archived=false | absent → show only non-archived rows (default)
   * Returns rows from dev_expenses_with_status view.
   * ─────────────────────────────────────────────────────── */
  fastify.get<{
    Querystring: {
      billing_month?: string;
      status?:        string;
      creditor_id?:   string;
      overdue?:       string;
      archived?:      string;
    };
  }>(
    '/admin/dev-expenses',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const { billing_month, status, creditor_id, overdue, archived } = request.query;

      if (billing_month && !MONTH_RE.test(billing_month)) {
        return reply.status(400).send({ error: 'billing_month must be YYYY-MM-01' });
      }
      if (creditor_id && !UUID_RE.test(creditor_id)) {
        return reply.status(400).send({ error: 'creditor_id must be a UUID' });
      }

      let q = fastify.supabase.from('dev_expenses_with_status').select('*');

      if (billing_month) q = q.eq('billing_month', billing_month);
      if (status)        q = q.eq('status', status);
      if (creditor_id)   q = q.eq('creditor_id', creditor_id);
      if (overdue === 'true') q = (q as any).eq('is_overdue', true);
      // archived filter: default excludes archived rows
      if (archived === 'true') {
        q = (q as any).eq('archived', true);
      } else {
        q = (q as any).eq('archived', false);
      }

      const { data, error } = await (q as any).order('due_date', { ascending: true, nullsFirst: false });

      if (error) {
        fastify.log.error({ err: error }, '[dev-expenses] list query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { data: data ?? [] };
    },
  );

  /* ── GET /admin/dev-expenses/upcoming ─────────────────────
   * Returns 3 groups, all excluding archived rows:
   *   overdue:     status=pending, due_date < today
   *   pending:     status=pending, due_date in [today, today+7]
   *   paid_recent: status=paid,    paid_at  in last 7 days
   * ─────────────────────────────────────────────────────── */
  fastify.get(
    '/admin/dev-expenses/upcoming',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr    = today.toISOString().slice(0, 10);
      const in7Str      = new Date(today.getTime() + 7  * 86_400_000).toISOString().slice(0, 10);
      const since7Str   = new Date(today.getTime() - 7  * 86_400_000).toISOString().slice(0, 10);

      const [overdueRes, pendingRes, paidRes] = await Promise.all([
        fastify.supabase
          .from('dev_expenses_with_status')
          .select('*')
          .eq('status', 'pending')
          .eq('archived', false)
          .not('due_date', 'is', null)
          .lt('due_date', todayStr)
          .order('due_date', { ascending: true }),

        fastify.supabase
          .from('dev_expenses_with_status')
          .select('*')
          .eq('status', 'pending')
          .eq('archived', false)
          .not('due_date', 'is', null)
          .gte('due_date', todayStr)
          .lte('due_date', in7Str)
          .order('due_date', { ascending: true }),

        fastify.supabase
          .from('dev_expenses_with_status')
          .select('*')
          .eq('status', 'paid')
          .eq('archived', false)
          .not('paid_at', 'is', null)
          .gte('paid_at', since7Str + 'T00:00:00Z')
          .order('paid_at', { ascending: false }),
      ]);

      if (overdueRes.error || pendingRes.error || paidRes.error) {
        const err = overdueRes.error ?? pendingRes.error ?? paidRes.error;
        fastify.log.error({ err }, '[dev-expenses] upcoming query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return {
        overdue:     overdueRes.data  ?? [],
        pending:     pendingRes.data  ?? [],
        paid_recent: paidRes.data     ?? [],
        as_of:       todayStr,
      };
    },
  );

  /* ── PATCH /admin/dev-expenses/:id/archive ─────────────────
   * Soft-archive an expense. Only paid/reconciled may be archived.
   * ─────────────────────────────────────────────────────── */
  fastify.patch<{ Params: { id: string } }>(
    '/admin/dev-expenses/:id/archive',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
      }

      const { data: existing } = await fastify.supabase
        .from('dev_expenses')
        .select('id, status, archived')
        .eq('id', request.params.id)
        .maybeSingle();

      if (!existing) return reply.status(404).send({ error: 'Expense not found' });
      if (existing.archived) return reply.status(400).send({ error: 'Expense is already archived' });
      if (existing.status === 'pending') {
        return reply.status(400).send({ error: 'Cannot archive a pending expense — mark it as paid first' });
      }

      const { data, error } = await fastify.supabase
        .from('dev_expenses')
        .update({ archived: true, archived_at: new Date().toISOString() })
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) {
        fastify.log.error({ err: error }, '[dev-expenses] archive failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { expense: data };
    },
  );

  /* ── PATCH /admin/dev-expenses/:id/unarchive ────────────────
   * Restore an archived expense to the active set.
   * ─────────────────────────────────────────────────────── */
  fastify.patch<{ Params: { id: string } }>(
    '/admin/dev-expenses/:id/unarchive',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
      }

      const { data: existing } = await fastify.supabase
        .from('dev_expenses')
        .select('id, archived')
        .eq('id', request.params.id)
        .maybeSingle();

      if (!existing) return reply.status(404).send({ error: 'Expense not found' });
      if (!existing.archived) return reply.status(400).send({ error: 'Expense is not archived' });

      const { data, error } = await fastify.supabase
        .from('dev_expenses')
        .update({ archived: false, archived_at: null })
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) {
        fastify.log.error({ err: error }, '[dev-expenses] unarchive failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { expense: data };
    },
  );

  /* ── GET /admin/dev-expenses/history ─────────────────────
   * Paginated monthly history. Replaced "5/5 services" check
   * with invoice_count + creditor_count per month.
   * ─────────────────────────────────────────────────────── */
  fastify.get<{ Querystring: { page?: string; limit?: string; month?: string } }>(
    '/admin/dev-expenses/history',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const page  = Math.max(1, parseInt(request.query.page  ?? '1',  10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit ?? '12', 10) || 12));
      const filterMonth = request.query.month;
      const offset = (page - 1) * limit;

      const { data: allExpenses, error } = await fastify.supabase
        .from('dev_expenses_with_status')
        .select('billing_month, category, creditor_id, creditor_name, amount_usd, status')
        .eq('archived', false)
        .order('billing_month', { ascending: false });

      if (error) {
        fastify.log.error({ err: error }, '[dev-expenses] history query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      // Group by billing_month
      const monthMap = new Map<string, {
        expenses: { category: string; creditor_name: string | null; amount_usd: number; status: string }[];
        creditorIds: Set<string>;
        total: number;
      }>();

      for (const exp of allExpenses ?? []) {
        if (filterMonth && exp.billing_month !== filterMonth) continue;
        if (!monthMap.has(exp.billing_month)) {
          monthMap.set(exp.billing_month, { expenses: [], creditorIds: new Set(), total: 0 });
        }
        const entry = monthMap.get(exp.billing_month)!;
        entry.expenses.push({
          category:     exp.category,
          creditor_name: exp.creditor_name ?? null,
          amount_usd:   Number(exp.amount_usd),
          status:       exp.status,
        });
        if (exp.creditor_id) entry.creditorIds.add(exp.creditor_id);
        entry.total += Number(exp.amount_usd);
      }

      const allMonths = Array.from(monthMap.keys()).sort().reverse();
      const pagedMonths = allMonths.slice(offset, offset + limit);

      const { data: reports } = await fastify.supabase
        .from('dev_expenses_reports')
        .select('billing_month, share_token, total_usd, generated_at')
        .in('billing_month', pagedMonths);

      const reportMap = new Map<string, { share_token: string; total_usd: number; generated_at: string }>();
      for (const r of reports ?? []) {
        reportMap.set(r.billing_month, { share_token: r.share_token, total_usd: Number(r.total_usd), generated_at: r.generated_at });
      }

      const data = pagedMonths.map((m) => {
        const entry  = monthMap.get(m)!;
        const report = reportMap.get(m);
        const anyPending = entry.expenses.some(e => e.status === 'pending');

        return {
          billing_month:  m,
          expenses:       entry.expenses,
          invoice_count:  entry.expenses.length,
          creditor_count: entry.creditorIds.size,
          total_usd:      entry.total,
          global_status:  anyPending ? 'pending' : 'ready',
          share_token:    report?.share_token  ?? null,
          share_url:      report ? `${PUBLIC_REPORT_ORIGIN}/report/${report.share_token}` : null,
          generated_at:   report?.generated_at ?? null,
        };
      });

      return {
        data,
        pagination: { page, limit, total: allMonths.length, pages: Math.ceil(allMonths.length / limit) },
      };
    },
  );

  /* ── GET /dev-expenses/report/:token (PUBLIC) ─────────────
   * Registered without /v1 prefix — no admin auth.
   * Protected by 48-char hex share_token. Rate-limited per IP.
   * Returns creditor, category, project_ref, due_date per expense.
   * ─────────────────────────────────────────────────────── */
  fastify.get<{ Params: { token: string } }>(
    '/dev-expenses/report/:token',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req) => req.ip },
      },
    },
    async (request, reply) => {
      const { token } = request.params;

      if (!/^[0-9a-f]{48}$/.test(token)) {
        return reply.status(404).send({ error: 'Not Found' });
      }

      const { data: report, error } = await fastify.supabase
        .from('dev_expenses_reports')
        .select('id, billing_month, total_usd, report_pdf_url, generated_at')
        .eq('share_token', token)
        .single();

      if (error || !report) return reply.status(404).send({ error: 'Not Found' });

      const { data: expenses, error: expErr } = await fastify.supabase
        .from('dev_expenses_with_status')
        .select('category, creditor_name, project_ref, amount_usd, status, due_date, is_overdue')
        .eq('billing_month', report.billing_month)
        .order('due_date', { ascending: true, nullsFirst: false });

      if (expErr) {
        fastify.log.error({ err: expErr }, '[dev-expenses] public report expenses query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      const prevMonth = getPreviousMonth(report.billing_month);
      const { data: prevExpenses } = await fastify.supabase
        .from('dev_expenses')
        .select('amount_usd')
        .eq('billing_month', prevMonth);

      const prevTotal = prevExpenses && prevExpenses.length > 0
        ? prevExpenses.reduce((sum, e) => sum + Number(e.amount_usd), 0)
        : null;

      const currentTotal  = Number(report.total_usd);
      const variationPct  = prevTotal !== null && prevTotal > 0
        ? ((currentTotal - prevTotal) / prevTotal) * 100
        : null;

      let pdfUrl: string | null = null;
      if (report.report_pdf_url) {
        const { data: signed } = await fastify.supabase.storage
          .from('dev-expenses-invoices')
          .createSignedUrl(report.report_pdf_url, 30 * 24 * 60 * 60);
        pdfUrl = signed?.signedUrl ?? null;
      }

      // Aggregations for the public page
      const byCategory: Record<string, number> = {};
      const byCreditor: Record<string, number> = {};
      for (const e of expenses ?? []) {
        byCategory[e.category] = (byCategory[e.category] ?? 0) + Number(e.amount_usd);
        const cname = e.creditor_name ?? 'Unknown';
        byCreditor[cname] = (byCreditor[cname] ?? 0) + Number(e.amount_usd);
      }

      return {
        billing_month:        report.billing_month,
        total_usd:            currentTotal,
        expenses:             (expenses ?? []).map(e => ({
          category:     e.category,
          creditor_name: e.creditor_name ?? null,
          project_ref:  e.project_ref   ?? null,
          amount_usd:   Number(e.amount_usd),
          status:       e.status,
          due_date:     e.due_date      ?? null,
        })),
        by_category:          byCategory,
        by_creditor:          byCreditor,
        previous_month:       prevMonth,
        previous_month_total: prevTotal,
        variation_pct:        variationPct,
        pdf_url:              pdfUrl,
        generated_at:         report.generated_at,
      };
    },
  );
};

export default adminDevExpensesRoute;
