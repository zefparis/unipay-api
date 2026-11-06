"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Static-analysis tests for the new admin merchants routes.
 * These verify the route file exists, exports the correct plugin, and contains
 * all required route handlers with admin guards.
 */
const ROUTE_FILE = node_path_1.default.resolve(__dirname, '../../routes/admin/merchants.ts');
const SOURCE = node_fs_1.default.readFileSync(ROUTE_FILE, 'utf-8');
(0, node_test_1.describe)('admin merchants route — static analysis', () => {
    (0, node_test_1.it)('file exists and exports default FastifyPluginAsync', () => {
        strict_1.default.ok(node_fs_1.default.existsSync(ROUTE_FILE), 'route file exists');
        strict_1.default.ok(SOURCE.includes('FastifyPluginAsync'), 'imports FastifyPluginAsync');
        strict_1.default.ok(SOURCE.includes('export default adminMerchantsRoute'), 'exports default plugin');
    });
    (0, node_test_1.it)('imports bcrypt for key regeneration', () => {
        strict_1.default.ok(SOURCE.includes("from 'bcryptjs'"), 'imports bcryptjs');
    });
    (0, node_test_1.it)('imports crypto for key generation', () => {
        strict_1.default.ok(SOURCE.includes('node:crypto'), 'imports node:crypto');
    });
    (0, node_test_1.it)('defines requireAdmin guard', () => {
        strict_1.default.ok(SOURCE.includes('function requireAdmin'), 'defines requireAdmin');
    });
    (0, node_test_1.it)('registers GET /admin/merchants/stats with admin guard', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/stats'"), 'registers stats route');
        strict_1.default.match(SOURCE, /merchants\/stats[\s\S]*?requireAdmin/, 'stats route has admin guard');
    });
    (0, node_test_1.it)('registers GET /admin/merchants with pagination + enrichment', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants'"), 'registers list route');
        strict_1.default.ok(SOURCE.includes('MerchantListQuery'), 'has MerchantListQuery interface');
        strict_1.default.ok(SOURCE.includes('transaction_count'), 'enriches with transaction_count');
        strict_1.default.ok(SOURCE.includes('api_key_status'), 'enriches with api_key_status');
    });
    (0, node_test_1.it)('registers GET /admin/merchants/:id with merchant + keys + transactions', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id'"), 'registers detail route');
        strict_1.default.ok(SOURCE.includes('api_keys'), 'returns api_keys');
        strict_1.default.ok(SOURCE.includes('transactions'), 'returns transactions');
    });
    (0, node_test_1.it)('registers GET /admin/merchants/transactions with filters', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/transactions'"), 'registers transactions route');
        strict_1.default.ok(SOURCE.includes('MerchantTransactionsQuery'), 'has MerchantTransactionsQuery interface');
        strict_1.default.ok(SOURCE.includes('merchant_id'), 'supports merchant_id filter');
    });
    (0, node_test_1.it)('registers GET /admin/merchants/transactions/export (CSV)', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/transactions/export'"), 'registers export route');
        strict_1.default.ok(SOURCE.includes('text/csv'), 'sets CSV content type');
        strict_1.default.ok(SOURCE.includes('merchant-transactions.csv'), 'sets CSV filename');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/api-keys/revoke', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/api-keys/revoke'"), 'registers revoke route');
        strict_1.default.ok(SOURCE.includes('key_id'), 'accepts key_id in body');
        strict_1.default.ok(SOURCE.includes('is_active: false'), 'deactivates key');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/api-keys/regenerate with bcrypt', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/api-keys/regenerate'"), 'registers regenerate route');
        strict_1.default.ok(SOURCE.includes('bcrypt.hash'), 'hashes new key with bcrypt');
        strict_1.default.ok(SOURCE.includes('crypto.randomBytes'), 'generates random key bytes');
        strict_1.default.ok(SOURCE.includes('up_'), 'uses up_ prefix');
        strict_1.default.ok(SOURCE.includes('key_prefix'), 'stores key_prefix');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/mode', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/mode'"), 'registers mode route');
        strict_1.default.ok(SOURCE.includes("enum: ['sandbox', 'live']"), 'validates mode enum');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/kyc/approve', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/kyc/approve'"), 'registers approve route');
        strict_1.default.match(SOURCE, /kyc_status:\s+'approved'/, 'sets kyc_status to approved');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/kyc/reject', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/kyc/reject'"), 'registers reject route');
        strict_1.default.match(SOURCE, /kyc_status:\s+'rejected'/, 'sets kyc_status to rejected');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/suspend', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/suspend'"), 'registers suspend route');
        strict_1.default.match(SOURCE, /status:\s+'suspended'/, 'sets status to suspended');
    });
    (0, node_test_1.it)('registers POST /admin/merchants/:id/reactivate', () => {
        strict_1.default.ok(SOURCE.includes("'/admin/merchants/:id/reactivate'"), 'registers reactivate route');
        strict_1.default.match(SOURCE, /status:\s+'active'/, 'sets status to active');
    });
    (0, node_test_1.it)('all routes check requireAdmin', () => {
        const guardCount = (SOURCE.match(/requireAdmin\(request\.isAdmin\)/g) ?? []).length;
        strict_1.default.ok(guardCount >= 11, `expected at least 11 admin guards, got ${guardCount}`);
    });
    (0, node_test_1.it)('regenerate deactivates old keys before inserting new one', () => {
        strict_1.default.ok(SOURCE.includes('is_active: false'), 'deactivates old keys');
        strict_1.default.ok(SOURCE.includes('bcrypt.hash(rawKey'), 'hashes the raw key');
    });
    (0, node_test_1.it)('revoke checks merchant_id ownership', () => {
        strict_1.default.match(SOURCE, /\.eq\('merchant_id', id\)/, 'filters by merchant_id');
    });
    (0, node_test_1.it)('transactions query filters merchant_id IS NOT NULL', () => {
        strict_1.default.ok(SOURCE.includes(".not('merchant_id', 'is', null)"), 'filters merchant_id IS NOT NULL');
    });
    (0, node_test_1.it)('stats includes mode and kyc breakdowns', () => {
        strict_1.default.ok(SOURCE.includes('mode_breakdown'), 'includes mode_breakdown');
        strict_1.default.ok(SOURCE.includes('kyc_breakdown'), 'includes kyc_breakdown');
        strict_1.default.ok(SOURCE.includes('volume_30d'), 'includes volume_30d');
        strict_1.default.ok(SOURCE.includes('transactions_today'), 'includes transactions_today');
    });
});
//# sourceMappingURL=admin-merchants-routes.test.js.map