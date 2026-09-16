import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M10 remediation tests — pagination on bsc-addresses dump.
 *
 * The original GET /v1/internal/bsc-addresses returned ALL phone
 * numbers + blockchain addresses in a single unbounded response,
 * protected by a single shared key (no scope, no individual rotation).
 *
 * Fix:
 *   - limit (max 500) and offset are mandatory query parameters
 *   - If absent → 400 PAGINATION_REQUIRED
 *   - If limit > 500 → 400 LIMIT_EXCEEDED
 *   - Response: { data, total, has_more } instead of a bare array
 *   - Distinct application log for each call (monitor 400s after deploy)
 *
 * Tests verify the code changes (static analysis, no DB needed).
 */

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const INTERNAL = fs.readFileSync(path.resolve(SRC, 'routes/wallet/internal.ts'), 'utf-8');

describe('M10 — pagination on bsc-addresses', () => {
  it('requires limit and offset query parameters', () => {
    assert.match(INTERNAL, /limit.*offset|offset.*limit/i);
    assert.match(INTERNAL, /PAGINATION_REQUIRED/);
  });

  it('returns 400 when pagination params are missing', () => {
    assert.match(INTERNAL, /PAGINATION_REQUIRED[\s\S]*?400/);
  });

  it('enforces limit max 500', () => {
    assert.match(INTERNAL, /500/);
    assert.match(INTERNAL, /LIMIT_EXCEEDED/);
  });

  it('returns 400 when limit > 500', () => {
    assert.match(INTERNAL, /LIMIT_EXCEEDED[\s\S]*?400/);
  });

  it('validates limit >= 1 and offset >= 0', () => {
    assert.match(INTERNAL, /INVALID_PAGINATION/);
    assert.match(INTERNAL, /limit must be >= 1/);
    assert.match(INTERNAL, /offset must be >= 0/);
  });

  it('uses .range() for pagination (Supabase range query)', () => {
    assert.match(INTERNAL, /\.range\(offset,\s*offset\s*\+\s*limit\s*-\s*1\)/);
  });

  it('requests count: exact for total', () => {
    assert.match(INTERNAL, /count:\s*'exact'/);
  });

  it('returns { data, total, has_more } structure (not bare array)', () => {
    assert.match(INTERNAL, /data:\s*normalized/);
    assert.match(INTERNAL, /total/);
    assert.match(INTERNAL, /has_more/);
  });

  it('computes has_more correctly (offset + limit < total)', () => {
    assert.match(INTERNAL, /offset\s*\+\s*limit\s*<\s*total/);
  });

  it('does NOT return a bare array (old behavior)', () => {
    // The old code did: return reply.send(normalized)
    // The new code should return an object with data/total/has_more
    // Check that the send call includes 'data:' property
    assert.match(INTERNAL, /reply\.send\(\s*\{\s*data:/);
  });

  it('logs each call with IP and params (monitor 400s after deploy)', () => {
    assert.match(INTERNAL, /\[internal\/bsc-addresses\]/);
    assert.match(INTERNAL, /paginated query/);
    assert.match(INTERNAL, /request\.ip/);
  });

  it('logs 400s with IP and user-agent', () => {
    assert.match(INTERNAL, /400 — missing pagination params/);
    assert.match(INTERNAL, /userAgent/);
  });

  it('preserves the blockchain_address lowercase normalization', () => {
    assert.match(INTERNAL, /blockchain_address\?\.toLowerCase\(\)/);
  });

  it('preserves the rate limit (30 per minute)', () => {
    assert.match(INTERNAL, /max:\s*30/);
  });

  it('preserves the bridge inbound key auth', () => {
    assert.match(INTERNAL, /requireBridgeInboundKey/);
  });
});
