/**
 * Admin routes — Dev Expenses Tracker
 *
 * POST   /v1/admin/dev-expenses/pull-automated     — pull Anthropic + Vercel costs
 * POST   /v1/admin/dev-expenses                    — manual entry with invoice upload
 * PATCH  /v1/admin/dev-expenses/:id/mark-paid      — mark expense as paid
 * POST   /v1/admin/dev-expenses/generate-report    — generate PDF + share token
 * GET    /v1/admin/dev-expenses/history            — paginated monthly history
 *
 * PUBLIC (no admin auth, token-protected):
 * GET    /v1/dev-expenses/report/:token            — read-only report JSON
 *
 * Auth: request.isAdmin (x-admin-secret middleware)
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';

const SERVICES = ['render', 'vercel', 'supabase', 'cloudflare', 'anthropic'] as const;
type Service = typeof SERVICES[number];

const MANUAL_SERVICES: Service[] = ['render', 'supabase', 'cloudflare'];

/* ── Invoice upload constraints ──────────────────────────── */
const ALLOWED_INVOICE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_INVOICE_BYTES    = 10 * 1024 * 1024; // 10 MB

/* ── Validation patterns ──────────────────────────────────── */
// YYYY-MM-01 — only first-of-month dates accepted as billing_month
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Zod schemas (400 before hitting Postgres) ────────────── */
const pullSchema = z.object({
  month: z.string().regex(MONTH_RE, 'Expected YYYY-MM-01'),
});

// Used after multipart parsing — fields arrive as strings
const manualSchema = z.object({
  service:       z.enum(['render', 'vercel', 'supabase', 'cloudflare', 'anthropic']),
  billing_month: z.string().regex(MONTH_RE, 'Expected YYYY-MM-01'),
  amount_usd:    z.number().min(0, 'Must be ≥ 0').max(99_999.99, 'Exceeds maximum of 99999.99'),
  notes:         z.string().max(500).optional(),
});

const markPaidSchema = z.object({
  payment_ref: z.string().max(200).trim().optional(),
});

const reportSchema = z.object({
  month: z.string().regex(MONTH_RE, 'Expected YYYY-MM-01'),
});

/* ── DEV_EXPENSES_PUBLIC_ORIGIN — explicit URL, no wildcard ──
 * env.ts provides a typed default ('https://dev-expenses.netlify.app').
 * This constant is used both for CORS (server.ts scoped registration)
 * and for building share URLs in generate-report. */
const PUBLIC_REPORT_ORIGIN = env.DEV_EXPENSES_PUBLIC_ORIGIN;

/* ── Helpers ──────────────────────────────────────────────── */

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.isAdmin) {
    reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    return false;
  }
  return true;
}

function isValidBillingMonth(s: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(s);
}

function getPreviousMonth(month: string): string {
  const d = new Date(month + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchAnthropicCost(billingMonth: string): Promise<number | null> {
  if (!env.ANTHROPIC_ADMIN_API_KEY) return null;
  try {
    // Anthropic Console API — fetch usage cost for the billing month
    const month = billingMonth.slice(0, 7); // YYYY-MM
    const res = await fetch('https://api.anthropic.com/v1/organizations/usage_costs', {
      headers: {
        'x-api-key': env.ANTHROPIC_ADMIN_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    // Find the line item matching the month
    const lineItems = data?.line_items ?? [];
    const match = lineItems.find((item: any) => item.usage_date?.startsWith?.(month));
    if (match) return Number(match.amount) || 0;
    // Fallback: sum all amounts if single-period response
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
    // Vercel returns total cost in cents or dollars depending on endpoint
    const total = Number(data?.total ?? data?.amount ?? 0);
    return total > 0 ? total / 100 : null; // convert cents to USD
  } catch {
    return null;
  }
}

async function generatePdf(
  billingMonth: string,
  expenses: { service: string; amount_usd: number; status: string }[],
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

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('Dev Expenses Report', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(12).font('Helvetica').text(`Billing Month: ${billingMonth}`, { align: 'center' });
  doc.moveDown(1);

  // Table header
  const tableTop = doc.y;
  const colX = [50, 200, 320, 420];
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('Service', colX[0], tableTop);
  doc.text('Amount (USD)', colX[1], tableTop);
  doc.text('Status', colX[2], tableTop);
  doc.moveDown(0.5);

  // Draw line under header
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);

  // Rows
  doc.font('Helvetica');
  for (const exp of expenses) {
    doc.fontSize(10)
      .text(exp.service, colX[0], doc.y)
      .text(`$${Number(exp.amount_usd).toFixed(2)}`, colX[1], doc.y)
      .text(exp.status, colX[2], doc.y);
    doc.moveDown(0.3);
  }

  // Total
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);
  doc.fontSize(12).font('Helvetica-Bold')
    .text('Total', colX[0], doc.y)
    .text(`$${totalUsd.toFixed(2)}`, colX[1], doc.y);

  // Comparison
  if (prevTotal !== null && prevTotal > 0) {
    doc.moveDown(0.5);
    const change = ((totalUsd - prevTotal) / prevTotal) * 100;
    const sign = change >= 0 ? '+' : '';
    doc.fontSize(10).font('Helvetica')
      .text(`vs previous month: ${sign}${change.toFixed(1)}% ($${prevTotal.toFixed(2)} → $${totalUsd.toFixed(2)})`);
  }

  doc.moveDown(1);
  doc.fontSize(8).font('Helvetica-Oblique').fillColor('gray')
    .text('Generated by UniPay Dev Expenses Tracker. This report is shared via a tokenized read-only link.');
  doc.end();

  return promise;
}

/* ── Route plugin ─────────────────────────────────────────── */

const adminDevExpensesRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /admin/dev-expenses/pull-automated ────────────── */
  /* Auth: x-admin-secret header (same as all other admin routes).
   * Called by the Render cron job with ADMIN_SECRET — no separate
   * CRON_SECRET needed because ADMIN_SECRET IS the shared server secret. */
  fastify.post('/admin/dev-expenses/pull-automated', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = pullSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }
    const { month } = parse.data;

    // Both API fetches + DB upserts run concurrently.
    // Promise.allSettled ensures a Vercel failure never blocks an Anthropic
    // success (and vice versa). Each service's result is independently tracked.
    const [anthropicResult, vercelResult] = await Promise.allSettled([
      (async () => {
        const cost = await fetchAnthropicCost(month);
        if (cost === null) throw new Error('API key missing or endpoint returned no data for this month');
        const { error } = await fastify.supabase
          .from('dev_expenses')
          .upsert(
            { service: 'anthropic', billing_month: month, amount_usd: cost, source: 'api_pull', status: 'pending' },
            { onConflict: 'service,billing_month' },
          );
        if (error) throw new Error(`DB upsert failed: ${error.message}`);
        return { service: 'anthropic' as const, amount_usd: cost };
      })(),
      (async () => {
        const cost = await fetchVercelCost(month);
        if (cost === null) throw new Error('API token/team_id missing or endpoint returned no data for this month');
        const { error } = await fastify.supabase
          .from('dev_expenses')
          .upsert(
            { service: 'vercel', billing_month: month, amount_usd: cost, source: 'api_pull', status: 'pending' },
            { onConflict: 'service,billing_month' },
          );
        if (error) throw new Error(`DB upsert failed: ${error.message}`);
        return { service: 'vercel' as const, amount_usd: cost };
      })(),
    ]);

    const pulled: { service: string; amount_usd: number; source: string }[] = [];
    const failed: { service: string; reason: string }[] = [];

    if (anthropicResult.status === 'fulfilled') {
      pulled.push({ ...anthropicResult.value, source: 'api_pull' });
    } else {
      failed.push({ service: 'anthropic', reason: String(anthropicResult.reason?.message ?? anthropicResult.reason) });
      fastify.log.warn({ reason: anthropicResult.reason?.message }, '[dev-expenses] anthropic pull failed');
    }
    if (vercelResult.status === 'fulfilled') {
      pulled.push({ ...vercelResult.value, source: 'api_pull' });
    } else {
      failed.push({ service: 'vercel', reason: String(vercelResult.reason?.message ?? vercelResult.reason) });
      fastify.log.warn({ reason: vercelResult.reason?.message }, '[dev-expenses] vercel pull failed');
    }

    return {
      billing_month: month,
      pulled,
      manual_required: MANUAL_SERVICES.map((s) => ({
        service: s,
        reason: 'Manual entry required (no automated API pull)',
      })),
      failed,
    };
  });

  /* ── POST /admin/dev-expenses (manual + invoice upload) ─── */
  fastify.post('/admin/dev-expenses', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parts = request.parts();
    let service = '';
    let billingMonth = '';
    let amountUsd = '';
    let notes = '';
    let invoiceFile: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    for await (const part of parts) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        invoiceFile = { buffer, filename: part.filename, mimetype: part.mimetype };
      } else {
        switch (part.fieldname) {
          case 'service': service = String(part.value); break;
          case 'billing_month': billingMonth = String(part.value); break;
          case 'amount_usd': amountUsd = String(part.value); break;
          case 'notes': notes = String(part.value); break;
        }
      }
    }

    // Validate all text fields with zod (amount_usd parsed from string first)
    const parse = manualSchema.safeParse({
      service,
      billing_month: billingMonth,
      amount_usd: parseFloat(amountUsd),
      notes: notes || undefined,
    });
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }
    const { amount_usd: amount, notes: validNotes } = parse.data;

    // Validate invoice MIME type + size BEFORE uploading to storage
    if (invoiceFile) {
      if (!ALLOWED_INVOICE_MIME.has(invoiceFile.mimetype)) {
        return reply.status(400).send({
          error: 'Invoice must be PDF, PNG, or JPEG',
          allowed: [...ALLOWED_INVOICE_MIME],
        });
      }
      if (invoiceFile.buffer.length > MAX_INVOICE_BYTES) {
        return reply.status(400).send({ error: 'Invoice file exceeds 10 MB limit' });
      }
    }

    let invoiceUrl: string | null = null;

    if (invoiceFile) {
      // Sanitize filename: strip path traversal chars, limit length
      const safeFilename = invoiceFile.filename
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_')
        .slice(0, 100) || 'invoice';
      const filePath = `${billingMonth}/${service}-${Date.now()}-${safeFilename}`;
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
      .upsert(
        {
          service,
          billing_month: billingMonth,
          amount_usd: amount,
          source: 'manual',
          invoice_url: invoiceUrl,
          notes: validNotes ?? null,
          status: 'pending',
        },
        { onConflict: 'service,billing_month' },
      )
      .select()
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[dev-expenses] insert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return { expense: data };
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
    const paymentRef = parse.data.payment_ref ?? null;

    const { data, error } = await fastify.supabase
      .from('dev_expenses')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        payment_ref: paymentRef,
      })
      .eq('id', request.params.id)
      .select()
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[dev-expenses] mark-paid failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    if (!data) {
      return reply.status(404).send({ error: 'Expense not found' });
    }

    return { expense: data };
  });

  /* ── POST /admin/dev-expenses/generate-report ───────────── */
  fastify.post('/admin/dev-expenses/generate-report', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = reportSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }
    const { month } = parse.data;

    // Fetch all expenses for the month
    const { data: expenses, error: expErr } = await fastify.supabase
      .from('dev_expenses')
      .select('id, service, amount_usd, status')
      .eq('billing_month', month);

    if (expErr) {
      fastify.log.error({ err: expErr }, '[dev-expenses] generate-report query failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    // Two distinct checks (point 6):
    // - missingServices: services with NO row for this exact month (never entered)
    // - pendingServices: services that have a row but status === 'pending' (not marked paid)
    // Both must be empty before a report can be generated.
    const presentServices = new Set((expenses ?? []).map((e) => e.service));
    const missingServices = SERVICES.filter((s) => !presentServices.has(s));
    const pendingServices = (expenses ?? []).filter((e) => e.status === 'pending').map((e) => e.service);

    if (missingServices.length > 0 || pendingServices.length > 0) {
      const incomplete = [...missingServices, ...pendingServices];
      return reply.status(400).send({
        error: 'Cannot generate report: some services are missing or pending',
        missing: missingServices,
        pending: pendingServices,
        incomplete,
      });
    }

    const totalUsd = (expenses ?? []).reduce((sum, e) => sum + Number(e.amount_usd), 0);

    // Fetch previous month total for comparison
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
      (expenses ?? []).map((e) => ({ service: e.service, amount_usd: Number(e.amount_usd), status: e.status })),
      totalUsd,
      prevTotal,
    );

    // Upload PDF to storage
    const pdfPath = `reports/${month}.pdf`;
    const { error: pdfUpErr } = await fastify.supabase.storage
      .from('dev-expenses-invoices')
      .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (pdfUpErr) {
      fastify.log.error({ err: pdfUpErr }, '[dev-expenses] PDF upload failed');
      return reply.status(500).send({ error: 'PDF upload failed' });
    }

    // Upsert report row
    const { data: report, error: repErr } = await fastify.supabase
      .from('dev_expenses_reports')
      .upsert(
        {
          billing_month: month,
          total_usd: totalUsd,
          report_pdf_url: pdfPath,
        },
        { onConflict: 'billing_month' },
      )
      .select()
      .single();

    if (repErr) {
      fastify.log.error({ err: repErr }, '[dev-expenses] report insert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    const shareUrl = `${PUBLIC_REPORT_ORIGIN}/report/${report.share_token}`;

    return {
      report,
      share_url: shareUrl,
      total_usd: totalUsd,
      previous_month_total: prevTotal,
    };
  });

  /* ── GET /admin/dev-expenses?billing_month= ─────────────── */
  /* Returns full expense rows with real UUIDs for a given month.
   * Used by the admin UI to get actual IDs for mark-paid operations. */
  fastify.get<{ Querystring: { billing_month?: string } }>(
    '/admin/dev-expenses',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const billingMonth = request.query.billing_month;
      if (!billingMonth || !MONTH_RE.test(billingMonth)) {
        return reply.status(400).send({ error: 'billing_month is required (YYYY-MM-01)' });
      }

      const { data, error } = await fastify.supabase
        .from('dev_expenses')
        .select('id, service, billing_month, amount_usd, source, invoice_url, status, paid_at, payment_ref, notes')
        .eq('billing_month', billingMonth)
        .order('service');

      if (error) {
        fastify.log.error({ err: error }, '[dev-expenses] month detail query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { data: data ?? [] };
    },
  );

  /* ── GET /admin/dev-expenses/history ────────────────────── */
  fastify.get<{ Querystring: { page?: string; limit?: string; month?: string } }>(
    '/admin/dev-expenses/history',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const page = Math.max(1, parseInt(request.query.page ?? '1', 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(request.query.limit ?? '12', 10) || 12));
      const filterMonth = request.query.month;
      const offset = (page - 1) * limit;

      // Get distinct billing months with expenses
      let query = fastify.supabase
        .from('dev_expenses')
        .select('billing_month, service, amount_usd, status', { count: 'exact' });

      if (filterMonth) {
        query = query.eq('billing_month', filterMonth);
      }

      // We need to group by billing_month — fetch all and aggregate in JS
      // For pagination, fetch distinct months first
      const { data: allExpenses, error } = await fastify.supabase
        .from('dev_expenses')
        .select('billing_month, service, amount_usd, status')
        .order('billing_month', { ascending: false });

      if (error) {
        fastify.log.error({ err: error }, '[dev-expenses] history query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      // Group by month
      const monthMap = new Map<string, { services: { service: string; amount_usd: number; status: string }[]; total: number }>();
      for (const exp of allExpenses ?? []) {
        if (filterMonth && exp.billing_month !== filterMonth) continue;
        if (!monthMap.has(exp.billing_month)) {
          monthMap.set(exp.billing_month, { services: [], total: 0 });
        }
        const entry = monthMap.get(exp.billing_month)!;
        entry.services.push({ service: exp.service, amount_usd: Number(exp.amount_usd), status: exp.status });
        entry.total += Number(exp.amount_usd);
      }

      const allMonths = Array.from(monthMap.keys()).sort().reverse();
      const total = allMonths.length;
      const pagedMonths = allMonths.slice(offset, offset + limit);

      // Fetch reports for these months
      const { data: reports } = await fastify.supabase
        .from('dev_expenses_reports')
        .select('billing_month, share_token, total_usd, generated_at')
        .in('billing_month', pagedMonths);

      const reportMap = new Map<string, { share_token: string; total_usd: number; generated_at: string }>();
      for (const r of reports ?? []) {
        reportMap.set(r.billing_month, { share_token: r.share_token, total_usd: Number(r.total_usd), generated_at: r.generated_at });
      }

      const data = pagedMonths.map((m) => {
        const entry = monthMap.get(m)!;
        const report = reportMap.get(m);
        const allFilled = SERVICES.every((s) => entry.services.some((sv) => sv.service === s));
        const anyPending = entry.services.some((sv) => sv.status === 'pending');
        const globalStatus = !allFilled ? 'incomplete' : anyPending ? 'pending' : 'ready';

        return {
          billing_month: m,
          services: entry.services,
          total_usd: entry.total,
          global_status: globalStatus,
          share_token: report?.share_token ?? null,
          share_url: report ? `${PUBLIC_REPORT_ORIGIN}/report/${report.share_token}` : null,
          generated_at: report?.generated_at ?? null,
        };
      });

      return {
        data,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    },
  );

  /* ── GET /dev-expenses/report/:token (PUBLIC) ───────────── */
  /* Registered outside /v1 prefix — no admin auth required.
   * Protected solely by the share_token. Rate-limited per IP. */
  fastify.get<{ Params: { token: string } }>(
    '/dev-expenses/report/:token',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (request, reply) => {
      const token = request.params.token;

      // Validate token format (hex string, 48 chars from gen_random_bytes(24))
      if (!/^[0-9a-f]{48}$/.test(token)) {
        return reply.status(404).send({ error: 'Not Found' });
      }

      // Find report by token
      const { data: report, error } = await fastify.supabase
        .from('dev_expenses_reports')
        .select('id, billing_month, total_usd, report_pdf_url, generated_at')
        .eq('share_token', token)
        .single();

      if (error || !report) {
        // Generic 404 — don't reveal if month exists
        return reply.status(404).send({ error: 'Not Found' });
      }

      // Fetch expenses for this month
      const { data: expenses, error: expErr } = await fastify.supabase
        .from('dev_expenses')
        .select('service, amount_usd, status')
        .eq('billing_month', report.billing_month)
        .order('service');

      if (expErr) {
        fastify.log.error({ err: expErr }, '[dev-expenses] public report expenses query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      // Fetch previous month for comparison
      const prevMonth = getPreviousMonth(report.billing_month);
      const { data: prevExpenses } = await fastify.supabase
        .from('dev_expenses')
        .select('amount_usd')
        .eq('billing_month', prevMonth);

      const prevTotal = prevExpenses && prevExpenses.length > 0
        ? prevExpenses.reduce((sum, e) => sum + Number(e.amount_usd), 0)
        : null;

      const currentTotal = Number(report.total_usd);
      const variationPct = prevTotal !== null && prevTotal > 0
        ? ((currentTotal - prevTotal) / prevTotal) * 100
        : null;

      // Generate signed PDF URL (30-day expiry)
      let pdfUrl: string | null = null;
      if (report.report_pdf_url) {
        const { data: signedUrl } = await fastify.supabase.storage
          .from('dev-expenses-invoices')
          .createSignedUrl(report.report_pdf_url, 30 * 24 * 60 * 60);
        pdfUrl = signedUrl?.signedUrl ?? null;
      }

      return {
        billing_month: report.billing_month,
        total_usd: currentTotal,
        services: (expenses ?? []).map((e) => ({
          service: e.service,
          amount_usd: Number(e.amount_usd),
          status: e.status,
        })),
        previous_month: prevMonth,
        previous_month_total: prevTotal,
        variation_pct: variationPct,
        pdf_url: pdfUrl,
        generated_at: report.generated_at,
      };
    },
  );
};

export default adminDevExpensesRoute;
