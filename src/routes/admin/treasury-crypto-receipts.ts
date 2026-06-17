/**
 * Admin routes — Treasury crypto invoice receipts (v2).
 *
 * Supports the full pending-invoice lifecycle:
 *   pending → received → confirmed
 *   pending / received → rejected | cancelled
 *   rejected → cancelled
 *
 * POST   /v1/admin/treasury/crypto-receipts           — create pending receipt
 * GET    /v1/admin/treasury/crypto-receipts           — list (filterable)
 * GET    /v1/admin/treasury/crypto-receipts/:id       — get single + audit log
 * PATCH  /v1/admin/treasury/crypto-receipts/:id       — update receipt
 * POST   /v1/admin/treasury/crypto-receipts/:id/cancel  — cancel receipt
 * POST   /v1/admin/treasury/crypto-receipts/:id/verify  — optional BSC tx check
 *
 * Auth: x-admin-secret header (hmac plugin → request.isAdmin).
 *
 * IMPORTANT:
 *   Does NOT credit wallet_users.
 *   Does NOT trigger swaps, withdrawals, or bridge calls.
 *   Does NOT store or broadcast private keys.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { SupabaseClient }     from '@supabase/supabase-js';
import { verifyBscTransfer }        from '../../lib/bsc-verify';

/* ── Allowed enum values ─────────────────────────────────────────────── */
const VALID_ASSETS   = ['USDC', 'USDT']                                          as const;
const VALID_NETWORKS = ['BSC', 'ERC20', 'TRC20', 'Polygon', 'Base', 'Arbitrum'] as const;
const VALID_STATUSES = ['pending', 'received', 'confirmed', 'converted', 'rejected', 'cancelled'] as const;

type Asset   = typeof VALID_ASSETS[number];
type Network = typeof VALID_NETWORKS[number];
type Status  = typeof VALID_STATUSES[number];

/* ── Terminal statuses: no further transitions allowed ───────────────── */
const TERMINAL_STATUSES: ReadonlySet<Status> = new Set(['confirmed', 'cancelled']);

/* ── Statuses that require tx_hash ──────────────────────────────────── */
const REQUIRES_TX_HASH: ReadonlySet<Status> = new Set(['received', 'confirmed']);

/* ── EVM-compatible networks ─────────────────────────────────────────── */
const EVM_NETWORKS: ReadonlySet<string> = new Set(['BSC', 'ERC20', 'Polygon', 'Base', 'Arbitrum']);

/* ── Validators ─────────────────────────────────────────────────────── */
const EVM_ADDRESS_RE   = /^0x[0-9a-fA-F]{40}$/;
const TRC20_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_TX_HASH_RE   = /^0x[0-9a-fA-F]{64}$/;
const TRC20_TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

function validateAddress(address: string, network: Network): string | null {
  if (EVM_NETWORKS.has(network)) {
    return EVM_ADDRESS_RE.test(address)
      ? null
      : `Invalid EVM address for ${network} (must be 0x + 40 hex chars)`;
  }
  if (network === 'TRC20') {
    return TRC20_ADDRESS_RE.test(address)
      ? null
      : 'Invalid TRC20 address (must start with T, 34 base58 chars)';
  }
  return null;
}

function validateTxHash(hash: string, network: Network): string | null {
  if (EVM_NETWORKS.has(network)) {
    return EVM_TX_HASH_RE.test(hash)
      ? null
      : `Invalid tx_hash for ${network}: must be 0x followed by 64 hex chars`;
  }
  if (network === 'TRC20') {
    return TRC20_TX_HASH_RE.test(hash)
      ? null
      : 'Invalid TRC20 tx_hash: must be 64 hex chars (no 0x prefix)';
  }
  return null;
}

/* ── Status transition guard ─────────────────────────────────────────── */
const ALLOWED_TRANSITIONS: Record<Status, Status[]> = {
  pending:   ['received', 'confirmed', 'rejected', 'cancelled'],
  received:  ['confirmed', 'rejected', 'cancelled'],
  rejected:  ['cancelled'],
  confirmed: [],
  cancelled: [],
  converted: ['confirmed'],
};

function canTransition(from: Status, to: Status): string | null {
  if (from === to) return null;
  if (TERMINAL_STATUSES.has(from)) {
    return `Cannot change status from '${from}' (terminal)`;
  }
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return `Cannot transition from '${from}' to '${to}'`;
  }
  return null;
}

/* ── Audit log helper ────────────────────────────────────────────────── */
async function auditLog(
  supabase:    SupabaseClient,
  action:      string,
  entityId:    string,
  before:      Record<string, unknown> | null,
  after:       Record<string, unknown> | null,
  actorLabel?: string,
  metadata?:   Record<string, unknown>,
): Promise<void> {
  await supabase.from('treasury_audit_log').insert({
    action,
    entity_type: 'treasury_crypto_receipt',
    entity_id:   entityId,
    actor_label: actorLabel ?? null,
    before:      before     ?? null,
    after:       after      ?? null,
    metadata:    metadata   ?? null,
  });
}

/* ── Plugin ─────────────────────────────────────────────────────────── */
const adminTreasuryCryptoReceiptsRoute: FastifyPluginAsync = async (fastify) => {

  /* ════════════════════════════════════════════════════════════════════
   * POST /v1/admin/treasury/crypto-receipts
   * Create a pending receipt. tx_hash is optional for status=pending.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.post<{
    Body: {
      invoice_id?:        string;
      invoice_reference?: string;
      payer_name?:        string;
      asset:              Asset;
      network:            Network;
      expected_amount:    number;
      receiving_address:  string;
      received_amount?:   number;
      tx_hash?:           string;
      notes?:             string;
      created_by?:        string;
      status?:            Status;
    };
  }>(
    '/admin/treasury/crypto-receipts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['asset', 'network', 'expected_amount', 'receiving_address'],
          additionalProperties: false,
          properties: {
            invoice_id:        { type: 'string', minLength: 1, maxLength: 100 },
            invoice_reference: { type: 'string', minLength: 1, maxLength: 200 },
            payer_name:        { type: 'string', minLength: 1, maxLength: 200 },
            asset:             { type: 'string', enum: [...VALID_ASSETS] },
            network:           { type: 'string', enum: [...VALID_NETWORKS] },
            expected_amount:   { type: 'number', exclusiveMinimum: 0 },
            receiving_address: { type: 'string', minLength: 5, maxLength: 200 },
            received_amount:   { type: 'number', exclusiveMinimum: 0 },
            tx_hash:           { type: 'string', minLength: 5, maxLength: 100 },
            notes:             { type: 'string', maxLength: 1000 },
            created_by:        { type: 'string', maxLength: 200 },
            status:            { type: 'string', enum: [...VALID_STATUSES] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const {
        invoice_id, invoice_reference, payer_name,
        asset, network, expected_amount, receiving_address,
        received_amount, tx_hash, notes, created_by,
        status = 'pending',
      } = request.body;

      /* ── Receiving address validation ──────────────────────────────── */
      const addrErr = validateAddress(receiving_address, network);
      if (addrErr) {
        return reply.status(400).send({ error: 'INVALID_RECEIVING_ADDRESS', message: addrErr });
      }

      /* ── tx_hash validation ────────────────────────────────────────── */
      let cleanHash: string | null = null;
      if (tx_hash) {
        cleanHash = tx_hash.trim();
        const hashErr = validateTxHash(cleanHash, network);
        if (hashErr) {
          return reply.status(400).send({ error: 'INVALID_TX_HASH', message: hashErr });
        }
      }

      /* ── tx_hash required for received/confirmed ───────────────────── */
      if (REQUIRES_TX_HASH.has(status) && !cleanHash) {
        return reply.status(400).send({
          error:   'TX_HASH_REQUIRED',
          message: `tx_hash is required when status is '${status}'`,
        });
      }

      /* ── Uniqueness check ──────────────────────────────────────────── */
      if (cleanHash) {
        const { data: existing } = await fastify.supabase
          .from('treasury_crypto_receipts')
          .select('id')
          .eq('tx_hash', cleanHash)
          .maybeSingle();
        if (existing) {
          return reply.status(409).send({ error: 'DUPLICATE_TX_HASH', message: 'A receipt with this tx_hash already exists' });
        }
      }

      const now = new Date().toISOString();
      const { data: row, error: dbErr } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .insert({
          invoice_id:        invoice_id        ?? null,
          invoice_reference: invoice_reference ?? null,
          payer_name:        payer_name        ?? null,
          asset,
          network,
          amount:            expected_amount,
          expected_amount,
          received_amount:   received_amount   ?? null,
          receiving_address,
          wallet_address:    null,
          tx_hash:           cleanHash,
          status,
          received_at:       REQUIRES_TX_HASH.has(status) ? now : null,
          confirmed_at:      status === 'confirmed'        ? now : null,
          notes:             notes      ?? null,
          created_by:        created_by ?? null,
        })
        .select()
        .single();

      if (dbErr) {
        if ((dbErr as { code?: string }).code === '23505') {
          return reply.status(409).send({ error: 'DUPLICATE_TX_HASH', message: 'tx_hash already exists' });
        }
        fastify.log.error({ err: dbErr }, '[treasury-crypto] insert failed');
        return reply.status(500).send({ error: 'Failed to save receipt' });
      }

      await auditLog(fastify.supabase, 'receipt_created', row.id as string, null, row as Record<string, unknown>, created_by);

      fastify.log.info({ id: row.id, asset, network, expected_amount, invoice_reference }, '[treasury-crypto] receipt created');
      return reply.status(201).send({ success: true, data: row });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * GET /v1/admin/treasury/crypto-receipts
   * List receipts with filters.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.get<{
    Querystring: {
      asset?:             string;
      network?:           string;
      status?:            string;
      invoice_id?:        string;
      invoice_reference?: string;
      payer_name?:        string;
      limit?:             number;
      offset?:            number;
    };
  }>(
    '/admin/treasury/crypto-receipts',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            asset:             { type: 'string', enum: [...VALID_ASSETS] },
            network:           { type: 'string', enum: [...VALID_NETWORKS] },
            status:            { type: 'string', enum: [...VALID_STATUSES] },
            invoice_id:        { type: 'string', maxLength: 100 },
            invoice_reference: { type: 'string', maxLength: 200 },
            payer_name:        { type: 'string', maxLength: 200 },
            limit:             { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset:            { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { asset, network, status, invoice_id, invoice_reference, payer_name, limit = 50, offset = 0 } = request.query;

      let q = fastify.supabase
        .from('treasury_crypto_receipts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (asset)             q = q.eq('asset', asset);
      if (network)           q = q.eq('network', network);
      if (status)            q = q.eq('status', status);
      if (invoice_id)        q = q.eq('invoice_id', invoice_id);
      if (invoice_reference) q = q.ilike('invoice_reference', `%${invoice_reference}%`);
      if (payer_name)        q = q.ilike('payer_name', `%${payer_name}%`);

      const { data, error: dbErr, count } = await q;
      if (dbErr) {
        fastify.log.error({ err: dbErr }, '[treasury-crypto] list failed');
        return reply.status(500).send({ error: 'Failed to fetch receipts' });
      }
      return reply.send({ data: data ?? [], total: count ?? 0 });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * GET /v1/admin/treasury/crypto-receipts/:id
   * Returns receipt + audit log.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.get<{ Params: { id: string } }>(
    '/admin/treasury/crypto-receipts/:id',
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { data, error } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .select('*')
        .eq('id', request.params.id)
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data)  return reply.status(404).send({ error: 'Receipt not found' });

      const { data: auditRows } = await fastify.supabase
        .from('treasury_audit_log')
        .select('id, action, actor_label, before, after, metadata, created_at')
        .eq('entity_id', request.params.id)
        .order('created_at', { ascending: false })
        .limit(50);

      return reply.send({ data, audit_log: auditRows ?? [] });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * PATCH /v1/admin/treasury/crypto-receipts/:id
   * Update receipt fields and / or status.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.patch<{
    Params: { id: string };
    Body: {
      invoice_id?:        string;
      invoice_reference?: string;
      payer_name?:        string;
      receiving_address?: string;
      tx_hash?:           string;
      expected_amount?:   number;
      received_amount?:   number;
      status?:            Status;
      notes?:             string;
      updated_by?:        string;
      override_reason?:   string;
    };
  }>(
    '/admin/treasury/crypto-receipts/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            invoice_id:        { type: 'string', minLength: 1, maxLength: 100 },
            invoice_reference: { type: 'string', minLength: 1, maxLength: 200 },
            payer_name:        { type: 'string', minLength: 1, maxLength: 200 },
            receiving_address: { type: 'string', minLength: 5, maxLength: 200 },
            tx_hash:           { type: 'string', minLength: 5, maxLength: 100 },
            expected_amount:   { type: 'number', exclusiveMinimum: 0 },
            received_amount:   { type: 'number', exclusiveMinimum: 0 },
            status:            { type: 'string', enum: [...VALID_STATUSES] },
            notes:             { type: 'string', maxLength: 1000 },
            updated_by:        { type: 'string', maxLength: 200 },
            override_reason:   { type: 'string', minLength: 5, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { id } = request.params;
      const { data: current, error: fetchErr } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr) return reply.status(500).send({ error: fetchErr.message });
      if (!current)  return reply.status(404).send({ error: 'Receipt not found' });

      const currentStatus = current.status as Status;
      const {
        invoice_id, invoice_reference, payer_name, receiving_address,
        tx_hash, expected_amount, received_amount, status: newStatus,
        notes, updated_by, override_reason,
      } = request.body;

      const updates: Record<string, unknown> = {};
      const auditActions: string[] = [];

      /* ── Status transition ───────────────────────────────────────── */
      if (newStatus && newStatus !== currentStatus) {
        const transErr = canTransition(currentStatus, newStatus);
        if (transErr) {
          return reply.status(400).send({ error: 'INVALID_STATUS_TRANSITION', message: transErr });
        }
        updates.status = newStatus;
        auditActions.push(`status_changed:${currentStatus}→${newStatus}`);
        const now = new Date().toISOString();
        if (newStatus === 'received'  && !current.received_at)  updates.received_at  = now;
        if (newStatus === 'confirmed' && !current.confirmed_at) updates.confirmed_at = now;
      }

      const effectiveStatus = (updates.status as Status | undefined) ?? currentStatus;

      /* ── tx_hash ─────────────────────────────────────────────────── */
      if (tx_hash !== undefined) {
        const cleanHash = tx_hash.trim();
        const hashErr   = validateTxHash(cleanHash, current.network as Network);
        if (hashErr) {
          return reply.status(400).send({ error: 'INVALID_TX_HASH', message: hashErr });
        }
        if (cleanHash !== current.tx_hash) {
          const { data: dup } = await fastify.supabase
            .from('treasury_crypto_receipts')
            .select('id')
            .eq('tx_hash', cleanHash)
            .neq('id', id)
            .maybeSingle();
          if (dup) {
            return reply.status(409).send({ error: 'DUPLICATE_TX_HASH', message: 'tx_hash already exists on another receipt' });
          }
        }
        updates.tx_hash = cleanHash;
        auditActions.push(current.tx_hash ? 'tx_hash_updated' : 'tx_hash_added');
      }

      /* ── tx_hash required check for target status ────────────────── */
      const finalTxHash = (updates.tx_hash as string | undefined) ?? current.tx_hash;
      if (REQUIRES_TX_HASH.has(effectiveStatus) && !finalTxHash) {
        return reply.status(400).send({
          error:   'TX_HASH_REQUIRED',
          message: `tx_hash is required when status is '${effectiveStatus}'`,
        });
      }

      /* ── receiving_address ───────────────────────────────────────── */
      if (receiving_address !== undefined) {
        const addrErr = validateAddress(receiving_address, current.network as Network);
        if (addrErr) {
          return reply.status(400).send({ error: 'INVALID_RECEIVING_ADDRESS', message: addrErr });
        }
        updates.receiving_address = receiving_address;
        auditActions.push(current.receiving_address ? 'receiving_address_changed' : 'receiving_address_set');
      }

      /* ── Other scalar fields ─────────────────────────────────────── */
      if (invoice_id        !== undefined) updates.invoice_id        = invoice_id;
      if (invoice_reference !== undefined) updates.invoice_reference = invoice_reference;
      if (payer_name        !== undefined) updates.payer_name        = payer_name;
      if (expected_amount   !== undefined) { updates.expected_amount = expected_amount; updates.amount = expected_amount; }
      if (received_amount   !== undefined) updates.received_amount   = received_amount;
      if (notes             !== undefined) updates.notes             = notes;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: 'NO_CHANGES', message: 'No updatable fields provided' });
      }

      const { data: updated, error: updateErr } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (updateErr) {
        if ((updateErr as { code?: string }).code === '23505') {
          return reply.status(409).send({ error: 'DUPLICATE_TX_HASH', message: 'tx_hash already exists' });
        }
        fastify.log.error({ err: updateErr }, '[treasury-crypto] update failed');
        return reply.status(500).send({ error: 'Update failed' });
      }

      for (const action of auditActions.length ? auditActions : ['receipt_updated']) {
        await auditLog(
          fastify.supabase, action, id,
          current  as Record<string, unknown>,
          updated  as Record<string, unknown>,
          updated_by,
          override_reason ? { override_reason } : undefined,
        );
      }

      if (updates.status === 'confirmed' && override_reason) {
        fastify.log.warn({ id, override_reason, actor: updated_by }, '[treasury-crypto] forced confirm with override reason');
      }

      fastify.log.info({ id, fields: Object.keys(updates), actor: updated_by }, '[treasury-crypto] receipt updated');
      return reply.send({ success: true, data: updated });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * POST /v1/admin/treasury/crypto-receipts/:id/cancel
   * ════════════════════════════════════════════════════════════════════ */
  fastify.post<{
    Params: { id: string };
    Body:   { reason?: string; updated_by?: string };
  }>(
    '/admin/treasury/crypto-receipts/:id/cancel',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reason:     { type: 'string', maxLength: 500 },
            updated_by: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { id } = request.params;
      const { reason, updated_by } = request.body ?? {};

      const { data: current, error: fetchErr } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .select('id, status, notes')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr) return reply.status(500).send({ error: fetchErr.message });
      if (!current)  return reply.status(404).send({ error: 'Receipt not found' });

      const transErr = canTransition(current.status as Status, 'cancelled');
      if (transErr) {
        return reply.status(400).send({ error: 'INVALID_STATUS_TRANSITION', message: transErr });
      }

      const noteAppend = reason ? `\n[Annulé] ${reason}` : '';
      const { data: updated, error: updateErr } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .update({ status: 'cancelled', notes: ((current.notes as string | null) ?? '') + noteAppend })
        .eq('id', id)
        .select()
        .single();

      if (updateErr) return reply.status(500).send({ error: updateErr.message });

      await auditLog(
        fastify.supabase, 'receipt_cancelled', id,
        current as Record<string, unknown>,
        { status: 'cancelled' },
        updated_by,
        reason ? { reason } : undefined,
      );

      fastify.log.info({ id, actor: updated_by }, '[treasury-crypto] receipt cancelled');
      return reply.send({ success: true, data: updated });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * POST /v1/admin/treasury/crypto-receipts/:id/verify
   * On-chain BSC verification via BSCScan eth_getTransactionReceipt.
   * Parses ERC-20 Transfer logs directly — does NOT use tokentx.
   * Does NOT broadcast any transaction or store private keys.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.post<{ Params: { id: string } }>(
    '/admin/treasury/crypto-receipts/:id/verify',
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { data: receipt } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .select('tx_hash, network, asset, expected_amount, received_amount, receiving_address')
        .eq('id', request.params.id)
        .maybeSingle();

      if (!receipt)         return reply.status(404).send({ error: 'Receipt not found' });
      if (!receipt.tx_hash) return reply.status(400).send({ error: 'NO_TX_HASH', message: 'Receipt has no tx_hash to verify' });
      if (receipt.network !== 'BSC') {
        return reply.status(400).send({
          error:   'UNSUPPORTED_NETWORK_VERIFICATION',
          message: 'On-chain verification is currently supported only for BSC/BEP20 receipts',
        });
      }

      /* ── API key: prefer ETHERSCAN_API_KEY (V2), fall back to BSCSCAN_API_KEY ─ */
      const explorerApiKey = process.env.ETHERSCAN_API_KEY ?? process.env.BSCSCAN_API_KEY;
      if (!explorerApiKey) {
        return reply.status(503).send({
          error:   'EXPLORER_API_KEY_NOT_CONFIGURED',
          message: 'Set ETHERSCAN_API_KEY (or BSCSCAN_API_KEY) to enable on-chain verification',
        });
      }

      try {
        /* ── Etherscan API V2 — BSC mainnet chainid=56 ─────────────── */
        /* Key intentionally excluded from logs to avoid secret leakage. */
        const rpcUrl = `https://api.etherscan.io/v2/api?chainid=56&module=proxy&action=eth_getTransactionReceipt&txhash=${receipt.tx_hash}&apikey=${explorerApiKey}`;
        const rpcRes  = await fetch(rpcUrl);
        const rawJson = await rpcRes.json() as Record<string, unknown>;

        /* ── Debug: always log the raw response shape ─────────────── */
        fastify.log.info({
          id:             request.params.id,
          tx_hash:        receipt.tx_hash,
          outer_status:   rawJson.status,
          outer_message:  rawJson.message,
          result_exists:  rawJson.result !== null && rawJson.result !== undefined,
          result_type:    typeof rawJson.result,
          result_status:  typeof rawJson.result === 'object' && rawJson.result !== null
                            ? (rawJson.result as Record<string, unknown>).status
                            : '(no object)',
          logs_count:     typeof rawJson.result === 'object' && rawJson.result !== null &&
                          Array.isArray((rawJson.result as Record<string, unknown>).logs)
                            ? ((rawJson.result as Record<string, unknown>).logs as unknown[]).length
                            : -1,
        }, '[treasury-crypto] BSCScan raw response');

        /* ── Case A: BSCScan API-level error (non-RPC format) ─────── */
        /* Shape: { status: "0", message: "NOTOK", result: "<string>" } */
        if (typeof rawJson.status === 'string' && rawJson.status === '0') {
          const errDetail = typeof rawJson.result === 'string'
            ? rawJson.result
            : String(rawJson.message ?? 'BSCScan API error');
          fastify.log.error(
            { id: request.params.id, tx_hash: receipt.tx_hash, detail: errDetail },
            '[treasury-crypto] BSCScan API-level error',
          );
          return reply.send({
            verified:         false,
            blocking_reasons: ['BSCSCAN_ERROR'],
            reason:           `BSCScan API error: ${errDetail}`,
          });
        }

        /* ── Case B: result is null / missing (tx not yet indexed) ── */
        /* JSON-RPC format: { jsonrpc, id, result: null }             */
        if (rawJson.result === null || rawJson.result === undefined || typeof rawJson.result !== 'object') {
          const rpcErr = rawJson.error as { message?: string } | undefined;
          fastify.log.warn(
            { id: request.params.id, tx_hash: receipt.tx_hash, rpcErr },
            '[treasury-crypto] tx not indexed or result missing',
          );
          return reply.send({
            verified:         false,
            blocking_reasons: ['TX_NOT_INDEXED'],
            reason:           rpcErr?.message ?? 'Transaction not found or not yet indexed on BSCScan',
          });
        }

        /* ── Case C: valid JSON-RPC receipt object ───────────────── */
        const rpcResult = rawJson.result as {
          logs:   Array<{ address: string; topics: string[]; data: string }>;
          status: string | number;
        };

        /* ── Use received_amount when present, else expected_amount ─ */
        const expectedAmount =
          receipt.received_amount !== null && receipt.received_amount !== undefined
            ? Number(receipt.received_amount)
            : Number(receipt.expected_amount ?? 0);

        const result = verifyBscTransfer(
          rpcResult,
          receipt.asset            as string,
          receipt.receiving_address as string,
          expectedAmount,
        );

        /* ── Debug: blocking summary ─────────────────────────────── */
        fastify.log.info(
          {
            id:              request.params.id,
            tx_hash:         receipt.tx_hash,
            verified:        result.verified,
            blocking:        result.blocking_reasons,
            transferred_amt: result.transferred_amount,
            expected_amt:    result.expected_amount,
          },
          '[treasury-crypto] verification completed',
        );

        /* ── Persist in audit log ────────────────────────────────── */
        await auditLog(
          fastify.supabase,
          result.verified ? 'verify_ok' : 'verify_failed',
          request.params.id,
          null,
          null,
          undefined,
          { verify_result: result },
        );

        return reply.send(result);

      } catch (err) {
        fastify.log.error({ err }, '[treasury-crypto] verify tx failed');
        return reply.status(500).send({ error: 'Verification failed', message: (err as Error).message });
      }
    },
  );
};

export default adminTreasuryCryptoReceiptsRoute;
