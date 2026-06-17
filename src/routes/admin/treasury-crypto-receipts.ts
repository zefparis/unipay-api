/**
 * Admin routes — Treasury crypto receipts.
 *
 * Records marketing / corporate invoice payments received in crypto.
 * Does NOT credit wallet_users.
 * Does NOT trigger swaps, withdrawals, or bridge calls.
 *
 * POST /v1/admin/treasury/crypto-receipts  — record a new receipt
 * GET  /v1/admin/treasury/crypto-receipts  — list receipts (filterable)
 *
 * Auth: x-admin-secret header (set by hmac plugin → request.isAdmin).
 */

import type { FastifyPluginAsync } from 'fastify';

/* ── Allowed values (kept in sync with DB CHECK constraints) ────────── */
const VALID_ASSETS   = ['USDC', 'USDT'] as const;
const VALID_NETWORKS = ['BSC', 'ERC20', 'TRC20'] as const;
const VALID_STATUSES = ['pending', 'received', 'confirmed', 'converted', 'rejected'] as const;

type Asset   = typeof VALID_ASSETS[number];
type Network = typeof VALID_NETWORKS[number];
type Status  = typeof VALID_STATUSES[number];

/* ── tx_hash: 64 hex chars, optional 0x prefix ─────────────────────── */
const TX_HASH_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/* ── Interfaces ─────────────────────────────────────────────────────── */
interface CreateBody {
  invoice_id?:        string;
  invoice_reference?: string;
  payer_name?:        string;
  payer_email?:       string;
  asset:              Asset;
  network:            Network;
  amount:             number;
  wallet_address?:    string;
  tx_hash:            string;
  binance_account?:   string;
  notes?:             string;
  created_by?:        string;
}

interface ListQuery {
  asset?:      string;
  network?:    string;
  status?:     string;
  invoice_id?: string;
  limit?:      number;
  offset?:     number;
}

/* ── Plugin ─────────────────────────────────────────────────────────── */
const adminTreasuryCryptoReceiptsRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/admin/treasury/crypto-receipts ──────────────────────── */
  fastify.post<{ Body: CreateBody }>(
    '/admin/treasury/crypto-receipts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['asset', 'network', 'amount', 'tx_hash'],
          additionalProperties: false,
          properties: {
            invoice_id:        { type: 'string', minLength: 1, maxLength: 100 },
            invoice_reference: { type: 'string', minLength: 1, maxLength: 200 },
            payer_name:        { type: 'string', minLength: 1, maxLength: 200 },
            payer_email:       { type: 'string', maxLength: 200 },
            asset:             { type: 'string', enum: [...VALID_ASSETS] },
            network:           { type: 'string', enum: [...VALID_NETWORKS] },
            amount:            { type: 'number', exclusiveMinimum: 0 },
            wallet_address:    { type: 'string', minLength: 10, maxLength: 100 },
            tx_hash:           { type: 'string', minLength: 10, maxLength: 100 },
            binance_account:   { type: 'string', minLength: 1, maxLength: 200 },
            notes:             { type: 'string', maxLength: 1000 },
            created_by:        { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const {
        invoice_id, invoice_reference, payer_name, payer_email,
        asset, network, amount, wallet_address, tx_hash,
        binance_account, notes, created_by,
      } = request.body;

      /* ── tx_hash syntactic validation ─────────────────────────────── */
      const cleanHash = tx_hash.trim();
      if (!TX_HASH_RE.test(cleanHash)) {
        return reply.status(400).send({
          error:   'INVALID_TX_HASH',
          message: 'tx_hash must be a 64-char hex string (with or without 0x prefix)',
        });
      }

      /* ── Uniqueness check ─────────────────────────────────────────── */
      const { data: existing } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .select('id')
        .eq('tx_hash', cleanHash)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({
          error:   'DUPLICATE_TX_HASH',
          message: 'A receipt with this tx_hash already exists',
        });
      }

      /* ── Insert ───────────────────────────────────────────────────── */
      const { data: row, error: dbErr } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .insert({
          invoice_id:        invoice_id        ?? null,
          invoice_reference: invoice_reference ?? null,
          payer_name:        payer_name        ?? null,
          payer_email:       payer_email       ?? null,
          asset,
          network,
          amount,
          wallet_address:    wallet_address  ?? null,
          tx_hash:           cleanHash,
          binance_account:   binance_account ?? null,
          status:            'received',
          notes:             notes           ?? null,
          created_by:        created_by      ?? null,
        })
        .select()
        .single();

      if (dbErr) {
        /* ── Postgres 23505 unique_violation (race condition on tx_hash) ── */
        const isUniqueViolation =
          (dbErr as { code?: string }).code === '23505' ||
          (dbErr.message ?? '').includes('duplicate key value violates unique constraint');

        if (isUniqueViolation) {
          fastify.log.warn(
            { tx_hash: cleanHash, asset, network },
            '[treasury-crypto] duplicate tx_hash rejected (race condition)',
          );
          return reply.status(409).send({
            success: false,
            error:   'DUPLICATE_TX_HASH',
            message: 'A treasury crypto receipt already exists for this tx_hash',
          });
        }

        fastify.log.error({ err: dbErr }, '[treasury-crypto] insert failed');
        return reply.status(500).send({ error: 'Failed to save receipt' });
      }

      fastify.log.info(
        {
          asset:             row.asset,
          network:           row.network,
          amount:            row.amount,
          tx_hash:           row.tx_hash,
          invoice_reference: row.invoice_reference ?? null,
        },
        '[treasury-crypto] receipt recorded',
      );

      return reply.status(201).send({ success: true, data: row });
    },
  );

  /* ── GET /v1/admin/treasury/crypto-receipts ───────────────────────── */
  fastify.get<{ Querystring: ListQuery }>(
    '/admin/treasury/crypto-receipts',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            asset:      { type: 'string', enum: [...VALID_ASSETS] },
            network:    { type: 'string', enum: [...VALID_NETWORKS] },
            status:     { type: 'string', enum: [...VALID_STATUSES] },
            invoice_id: { type: 'string', maxLength: 100 },
            limit:      { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset:     { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { asset, network, status, invoice_id, limit = 50, offset = 0 } = request.query;

      let q = fastify.supabase
        .from('treasury_crypto_receipts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (asset)      q = q.eq('asset', asset);
      if (network)    q = q.eq('network', network);
      if (status)     q = q.eq('status', status);
      if (invoice_id) q = q.eq('invoice_id', invoice_id);

      const { data, error: dbErr, count } = await q;

      if (dbErr) {
        fastify.log.error({ err: dbErr }, '[treasury-crypto] list failed');
        return reply.status(500).send({ error: 'Failed to fetch receipts' });
      }

      return reply.send({ data: data ?? [], total: count ?? 0 });
    },
  );
};

export default adminTreasuryCryptoReceiptsRoute;
