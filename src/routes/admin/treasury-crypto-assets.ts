/**
 * Admin — Treasury Crypto Assets
 *
 * Endpoints:
 *   GET  /admin/treasury/crypto-assets          On-chain balances + accounting totals
 *   GET  /admin/treasury/crypto-wallets         List registered treasury wallets
 *   POST /admin/treasury/crypto-wallets         Register a new treasury wallet
 *   PATCH /admin/treasury/crypto-wallets/:id    Update / deactivate a wallet
 *
 * READ-ONLY blockchain access.  No private keys.  No signing.  No withdrawals.
 * No user wallet credits.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { SupabaseClient }     from '@supabase/supabase-js';

/* ── Supported token contracts on BSC (other networks: on-chain verify not supported) ── */
const BSC_TOKENS: Record<string, { contract: string; decimals: number }> = {
  USDC: { contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  USDT: { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
};

const SUPPORTED_ASSETS   = ['USDC', 'USDT'] as const;
const SUPPORTED_NETWORKS = ['BSC', 'ERC20', 'TRC20', 'Polygon', 'Base', 'Arbitrum'] as const;

/* ── ERC-20 balanceOf(address) function selector ────────────────────────── */
const BALANCE_OF_SELECTOR = '0x70a08231';

/* ── Audit log helper for wallet lifecycle events ───────────────────────── */
async function auditWalletLog(
  supabase:      SupabaseClient,
  action:        string,
  wallet:        Record<string, unknown>,
  receiptsCount: number,
): Promise<void> {
  await supabase.from('treasury_audit_log').insert({
    action,
    entity_type: 'treasury_wallet',
    entity_id:   wallet.id as string,
    actor_label: null,
    before:      wallet,
    after:       null,
    metadata: {
      wallet_id:              wallet.id,
      label:                  wallet.label,
      asset:                  wallet.asset,
      network:                wallet.network,
      address:                wallet.address,
      used_by_receipts_count: receiptsCount,
    },
  });
}

/* ── Resolve token contract + decimals from asset/network ─────────────── */
function resolveToken(asset: string, network: string): { contract: string; decimals: number } | null {
  if (network === 'BSC') return BSC_TOKENS[asset] ?? null;
  return null;
}

/* ── Fetch ERC-20 balance via JSON-RPC eth_call ─────────────────────────── */
async function fetchOnChainBalance(
  rpcUrl:    string,
  contract:  string,
  address:   string,
  decimals:  number,
): Promise<number | null> {
  const paddedAddr = '000000000000000000000000' + address.toLowerCase().replace(/^0x/, '');
  const callData   = BALANCE_OF_SELECTOR + paddedAddr;

  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'eth_call',
      params:  [{ to: contract, data: callData }, 'latest'],
      id:      1,
    }),
  });

  const json = await res.json() as { result?: string; error?: { message: string } };
  if (!json.result || json.result === '0x') return 0;

  const raw      = BigInt(json.result);
  const divisor  = BigInt(10) ** BigInt(decimals);
  const whole    = raw / divisor;
  const fraction = raw % divisor;
  return Number(whole) + Number(fraction) / 10 ** decimals;
}

/* ── Validate EVM address ──────────────────────────────────────────────── */
function isEvmAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Plugin
 * ═══════════════════════════════════════════════════════════════════════════ */
const adminTreasuryCryptoAssetsRoute: FastifyPluginAsync = async (fastify) => {

  /* ════════════════════════════════════════════════════════════════════
   * GET /admin/treasury/crypto-assets
   * Returns each active treasury wallet with:
   *   - on-chain ERC-20 balance (via BSC_RPC_URL)
   *   - confirmed_receipts_total from treasury_crypto_receipts
   *   - difference = onchain_balance - confirmed_receipts_total
   * ════════════════════════════════════════════════════════════════════ */
  fastify.get('/admin/treasury/crypto-assets', async (request, reply) => {
    if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

    const { data: wallets, error: walletsErr } = await fastify.supabase
      .from('treasury_wallets')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (walletsErr) return reply.status(500).send({ error: walletsErr.message });
    if (!wallets?.length) return reply.send({ data: [] });

    const bscRpcUrl = process.env.BSC_RPC_URL;
    const lastCheckedAt = new Date().toISOString();

    const results = await Promise.all(
      wallets.map(async (w) => {
        /* ── 1. On-chain balance ─────────────────────────────────── */
        let onchainBalance: number | null = null;
        let onchainError:   string | null = null;

        const token = resolveToken(w.asset, w.network);
        if (!token) {
          onchainError = `On-chain balance not supported for ${w.network} yet`;
        } else if (!bscRpcUrl) {
          onchainError = 'BSC_RPC_URL not configured';
        } else {
          try {
            onchainBalance = await fetchOnChainBalance(bscRpcUrl, token.contract, w.address, token.decimals);
          } catch (err) {
            onchainError = (err as Error).message;
            fastify.log.error({ wallet_id: w.id, address: w.address, err }, '[treasury-assets] balanceOf failed');
          }
        }

        /* ── 2. Confirmed receipts total ─────────────────────────── */
        const { data: receipts } = await fastify.supabase
          .from('treasury_crypto_receipts')
          .select('received_amount, expected_amount')
          .eq('status', 'confirmed')
          .eq('asset', w.asset)
          .eq('network', w.network)
          .ilike('receiving_address', w.address);

        const confirmedTotal = (receipts ?? []).reduce((sum, r) => {
          const amt = Number(r.received_amount ?? r.expected_amount ?? 0);
          return sum + amt;
        }, 0);

        /* ── 3. Difference ───────────────────────────────────────── */
        const difference =
          onchainBalance !== null ? onchainBalance - confirmedTotal : null;

        /* ── 4. Status ───────────────────────────────────────────── */
        let status: 'ok' | 'warning' | 'alert' | 'unknown' = 'unknown';
        if (difference !== null) {
          if (difference === 0)  status = 'ok';
          else if (difference > 0) status = 'warning';   // more on-chain than accounted
          else                     status = 'alert';      // accounting > on-chain (inconsistency)
        }

        return {
          wallet_id:               w.id,
          label:                   w.label,
          asset:                   w.asset,
          network:                 w.network,
          address:                 w.address,
          token_contract:          w.token_contract,
          onchain_balance:         onchainBalance,
          onchain_error:           onchainError,
          confirmed_receipts_total: confirmedTotal,
          difference,
          status,
          last_checked_at:         lastCheckedAt,
          explorer_url:            `https://bscscan.com/address/${w.address}`,
          notes:                   w.notes,
        };
      }),
    );

    fastify.log.info({ count: results.length }, '[treasury-assets] balances fetched');
    return reply.send({ data: results, last_checked_at: lastCheckedAt });
  });

  /* ════════════════════════════════════════════════════════════════════
   * GET /admin/treasury/crypto-wallets
   * List all treasury wallets (without on-chain fetch) — for UI forms.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.get<{ Querystring: { active_only?: string } }>('/admin/treasury/crypto-wallets', async (request, reply) => {
    if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

    let query = fastify.supabase
      .from('treasury_wallets')
      .select('*')
      .order('created_at', { ascending: true });

    if (request.query.active_only === 'true') {
      query = query.eq('is_active', true) as typeof query;
    }

    const { data, error } = await query;

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send({ data: data ?? [] });
  });

  /* ════════════════════════════════════════════════════════════════════
   * POST /admin/treasury/crypto-wallets
   * Register a new treasury wallet.
   * token_contract and decimals are auto-resolved from asset+network
   * if not explicitly provided.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.post<{
    Body: {
      label:           string;
      asset:           string;
      network:         string;
      address:         string;
      notes?:          string;
      token_contract?: string;
      decimals?:       number;
    };
  }>(
    '/admin/treasury/crypto-wallets',
    {
      schema: {
        body: {
          type: 'object',
          required: ['label', 'asset', 'network', 'address'],
          additionalProperties: false,
          properties: {
            label:           { type: 'string', minLength: 2, maxLength: 200 },
            asset:           { type: 'string', enum: [...SUPPORTED_ASSETS] },
            network:         { type: 'string', enum: [...SUPPORTED_NETWORKS] },
            address:         { type: 'string', minLength: 10, maxLength: 200 },
            notes:           { type: 'string', maxLength: 1000 },
            token_contract:  { type: 'string', minLength: 10, maxLength: 200 },
            decimals:        { type: 'number', minimum: 0, maximum: 36 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { label, asset, network, address, notes, token_contract, decimals } = request.body;

      /* ── Address validation ──────────────────────────────────── */
      if (['BSC', 'ERC20', 'Polygon', 'Base', 'Arbitrum'].includes(network)) {
        if (!isEvmAddress(address)) {
          return reply.status(400).send({
            error:   'INVALID_ADDRESS',
            message: `${network} requires a valid EVM address (0x + 40 hex chars)`,
          });
        }
      }

      /* ── Auto-resolve token contract ─────────────────────────── */
      const resolved = resolveToken(asset, network);
      const finalContract = token_contract ?? resolved?.contract;
      const finalDecimals = decimals       ?? resolved?.decimals ?? 18;

      if (!finalContract) {
        return reply.status(400).send({
          error:   'UNSUPPORTED_ASSET_NETWORK',
          message: `No known token contract for ${asset} on ${network}. Provide token_contract manually.`,
        });
      }

      const { data: created, error: insertErr } = await fastify.supabase
        .from('treasury_wallets')
        .insert({
          label,
          asset,
          network,
          address,
          token_contract: finalContract,
          decimals:       finalDecimals,
          notes,
        })
        .select()
        .single();

      if (insertErr) {
        fastify.log.error({ err: insertErr }, '[treasury-assets] wallet insert failed');
        return reply.status(500).send({ error: insertErr.message });
      }

      fastify.log.info({ id: created.id, label, asset, network }, '[treasury-assets] wallet created');
      return reply.status(201).send({ success: true, data: created });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * DELETE /admin/treasury/crypto-wallets/:id
   * If wallet address is unused by any receipt → hard delete.
   * If used by receipts → soft deactivate (is_active = false).
   * If already inactive → idempotent success.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.delete<{ Params: { id: string } }>(
    '/admin/treasury/crypto-wallets/:id',
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { data: wallet, error: fetchErr } = await fastify.supabase
        .from('treasury_wallets')
        .select('*')
        .eq('id', request.params.id)
        .maybeSingle();

      if (fetchErr) return reply.status(500).send({ error: fetchErr.message });
      if (!wallet)  return reply.status(404).send({ error: 'Wallet not found' });

      if (!wallet.is_active) {
        return reply.send({ deleted: false, deactivated: false, already_inactive: true });
      }

      /* ── Count linked receipts ───────────────────────────────────── */
      const { count } = await fastify.supabase
        .from('treasury_crypto_receipts')
        .select('id', { count: 'exact', head: true })
        .ilike('receiving_address', wallet.address);

      const usedCount = count ?? 0;

      if (usedCount === 0) {
        /* ── Hard delete ────────────────────────────────────────── */
        const { error: delErr } = await fastify.supabase
          .from('treasury_wallets')
          .delete()
          .eq('id', request.params.id);

        if (delErr) return reply.status(500).send({ error: delErr.message });

        await auditWalletLog(fastify.supabase, 'treasury_wallet_deleted',
          wallet as Record<string, unknown>, usedCount);

        fastify.log.info(
          { id: wallet.id, label: wallet.label, asset: wallet.asset, network: wallet.network },
          '[treasury-assets] wallet hard-deleted',
        );
        return reply.send({ deleted: true, deactivated: false, used_by_receipts_count: 0 });
      }

      /* ── Soft deactivate ──────────────────────────────────────── */
      const { error: updErr } = await fastify.supabase
        .from('treasury_wallets')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', request.params.id);

      if (updErr) return reply.status(500).send({ error: updErr.message });

      await auditWalletLog(fastify.supabase, 'treasury_wallet_deactivated',
        wallet as Record<string, unknown>, usedCount);

      fastify.log.info(
        { id: wallet.id, label: wallet.label, receipts: usedCount },
        '[treasury-assets] wallet deactivated',
      );
      return reply.send({ deleted: false, deactivated: true, used_by_receipts_count: usedCount });
    },
  );

  /* ════════════════════════════════════════════════════════════════════
   * PATCH /admin/treasury/crypto-wallets/:id
   * Update label, notes, or deactivate a wallet.
   * ════════════════════════════════════════════════════════════════════ */
  fastify.patch<{
    Params: { id: string };
    Body:   { label?: string; notes?: string; is_active?: boolean };
  }>(
    '/admin/treasury/crypto-wallets/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label:     { type: 'string', minLength: 2, maxLength: 200 },
            notes:     { type: 'string', maxLength: 1000 },
            is_active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const { label, notes, is_active } = request.body;
      if (label     !== undefined) updates.label     = label;
      if (notes     !== undefined) updates.notes     = notes;
      if (is_active !== undefined) updates.is_active = is_active;

      const { data: updated, error } = await fastify.supabase
        .from('treasury_wallets')
        .update(updates)
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) return reply.status(500).send({ error: error.message });
      if (!updated) return reply.status(404).send({ error: 'Wallet not found' });

      fastify.log.info({ id: request.params.id, updates: Object.keys(updates) }, '[treasury-assets] wallet updated');
      return reply.send({ success: true, data: updated });
    },
  );
};

export default adminTreasuryCryptoAssetsRoute;
