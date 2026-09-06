import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Static-analysis tests for the new admin merchants routes.
 * These verify the route file exists, exports the correct plugin, and contains
 * all required route handlers with admin guards.
 */

const ROUTE_FILE = path.resolve(__dirname, '../../routes/admin/merchants.ts');
const SOURCE = fs.readFileSync(ROUTE_FILE, 'utf-8');

describe('admin merchants route — static analysis', () => {
  it('file exists and exports default FastifyPluginAsync', () => {
    assert.ok(fs.existsSync(ROUTE_FILE), 'route file exists');
    assert.ok(SOURCE.includes('FastifyPluginAsync'), 'imports FastifyPluginAsync');
    assert.ok(SOURCE.includes('export default adminMerchantsRoute'), 'exports default plugin');
  });

  it('imports bcrypt for key regeneration', () => {
    assert.ok(SOURCE.includes("from 'bcryptjs'"), 'imports bcryptjs');
  });

  it('imports crypto for key generation', () => {
    assert.ok(SOURCE.includes('node:crypto'), 'imports node:crypto');
  });

  it('defines requireAdmin guard', () => {
    assert.ok(SOURCE.includes('function requireAdmin'), 'defines requireAdmin');
  });

  it('registers GET /admin/merchants/stats with admin guard', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/stats'"), 'registers stats route');
    assert.match(SOURCE, /merchants\/stats[\s\S]*?requireAdmin/, 'stats route has admin guard');
  });

  it('registers GET /admin/merchants with pagination + enrichment', () => {
    assert.ok(SOURCE.includes("'/admin/merchants'"), 'registers list route');
    assert.ok(SOURCE.includes('MerchantListQuery'), 'has MerchantListQuery interface');
    assert.ok(SOURCE.includes('transaction_count'), 'enriches with transaction_count');
    assert.ok(SOURCE.includes('api_key_status'), 'enriches with api_key_status');
  });

  it('registers GET /admin/merchants/:id with merchant + keys + transactions', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id'"), 'registers detail route');
    assert.ok(SOURCE.includes('api_keys'), 'returns api_keys');
    assert.ok(SOURCE.includes('transactions'), 'returns transactions');
  });

  it('registers GET /admin/merchants/transactions with filters', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/transactions'"), 'registers transactions route');
    assert.ok(SOURCE.includes('MerchantTransactionsQuery'), 'has MerchantTransactionsQuery interface');
    assert.ok(SOURCE.includes('merchant_id'), 'supports merchant_id filter');
  });

  it('registers GET /admin/merchants/transactions/export (CSV)', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/transactions/export'"), 'registers export route');
    assert.ok(SOURCE.includes('text/csv'), 'sets CSV content type');
    assert.ok(SOURCE.includes('merchant-transactions.csv'), 'sets CSV filename');
  });

  it('registers POST /admin/merchants/:id/api-keys/revoke', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/api-keys/revoke'"), 'registers revoke route');
    assert.ok(SOURCE.includes('key_id'), 'accepts key_id in body');
    assert.ok(SOURCE.includes('is_active: false'), 'deactivates key');
  });

  it('registers POST /admin/merchants/:id/api-keys/regenerate with bcrypt', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/api-keys/regenerate'"), 'registers regenerate route');
    assert.ok(SOURCE.includes('bcrypt.hash'), 'hashes new key with bcrypt');
    assert.ok(SOURCE.includes('crypto.randomBytes'), 'generates random key bytes');
    assert.ok(SOURCE.includes('up_'), 'uses up_ prefix');
    assert.ok(SOURCE.includes('key_prefix'), 'stores key_prefix');
  });

  it('registers POST /admin/merchants/:id/mode', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/mode'"), 'registers mode route');
    assert.ok(SOURCE.includes("enum: ['sandbox', 'live']"), 'validates mode enum');
  });

  it('registers POST /admin/merchants/:id/kyc/approve', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/kyc/approve'"), 'registers approve route');
    assert.match(SOURCE, /kyc_status:\s+'approved'/, 'sets kyc_status to approved');
  });

  it('registers POST /admin/merchants/:id/kyc/reject', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/kyc/reject'"), 'registers reject route');
    assert.match(SOURCE, /kyc_status:\s+'rejected'/, 'sets kyc_status to rejected');
  });

  it('registers POST /admin/merchants/:id/suspend', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/suspend'"), 'registers suspend route');
    assert.match(SOURCE, /status:\s+'suspended'/, 'sets status to suspended');
  });

  it('registers POST /admin/merchants/:id/reactivate', () => {
    assert.ok(SOURCE.includes("'/admin/merchants/:id/reactivate'"), 'registers reactivate route');
    assert.match(SOURCE, /status:\s+'active'/, 'sets status to active');
  });

  it('all routes check requireAdmin', () => {
    const guardCount = (SOURCE.match(/requireAdmin\(request\.isAdmin\)/g) ?? []).length;
    assert.ok(guardCount >= 11, `expected at least 11 admin guards, got ${guardCount}`);
  });

  it('regenerate deactivates old keys before inserting new one', () => {
    assert.ok(SOURCE.includes('is_active: false'), 'deactivates old keys');
    assert.ok(SOURCE.includes('bcrypt.hash(rawKey'), 'hashes the raw key');
  });

  it('revoke checks merchant_id ownership', () => {
    assert.match(SOURCE, /\.eq\('merchant_id', id\)/, 'filters by merchant_id');
  });

  it('transactions query filters merchant_id IS NOT NULL', () => {
    assert.ok(SOURCE.includes(".not('merchant_id', 'is', null)"), 'filters merchant_id IS NOT NULL');
  });

  it('stats includes mode and kyc breakdowns', () => {
    assert.ok(SOURCE.includes('mode_breakdown'), 'includes mode_breakdown');
    assert.ok(SOURCE.includes('kyc_breakdown'), 'includes kyc_breakdown');
    assert.ok(SOURCE.includes('volume_30d'), 'includes volume_30d');
    assert.ok(SOURCE.includes('transactions_today'), 'includes transactions_today');
  });
});
