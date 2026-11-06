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
 * C3 unlock-pin admin route tests.
 *
 * Verifies the admin unlock-pin route exists, is admin-protected,
 * resets the 3 lockout columns, logs the action, and handles the
 * ALREADY_UNLOCKED + not-found cases.
 */
const ROOT = node_path_1.default.resolve(__dirname, '../..');
const ADMIN_WALLET = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'routes/admin/wallet.ts'), 'utf-8');
(0, node_test_1.describe)('C3-unlock — POST /v1/admin/wallet/users/:id/unlock-pin', () => {
    (0, node_test_1.it)('route is registered', () => {
        strict_1.default.match(ADMIN_WALLET, /\/admin\/wallet\/users\/:id\/unlock-pin/, 'must register the unlock-pin route');
    });
    (0, node_test_1.it)('is protected by requireAdmin(request.isAdmin)', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
        strict_1.default.ok(section, 'must find unlock-pin route body');
        strict_1.default.match(section[0], /requireAdmin\(request\.isAdmin\)/);
        strict_1.default.match(section[0], /403/);
        strict_1.default.match(section[0], /Admin access required/);
    });
    (0, node_test_1.it)('returns 404 when wallet_id does not exist', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /404/);
        strict_1.default.match(section[0], /Wallet user not found/);
    });
    (0, node_test_1.it)('returns ALREADY_UNLOCKED when not currently locked', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /ALREADY_UNLOCKED/);
        strict_1.default.match(section[0], /was_locked:\s*false/);
    });
    (0, node_test_1.it)('resets the 3 lockout columns (failed_pin_attempts, locked_until, pin_lockout_count)', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /failed_pin_attempts:\s*0/);
        strict_1.default.match(section[0], /locked_until:\s*null/);
        strict_1.default.match(section[0], /pin_lockout_count:\s*0/);
    });
    (0, node_test_1.it)('logs the action via logAdminAction with action wallet_user.unlock_pin', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /logAdminAction/);
        strict_1.default.match(section[0], /wallet_user\.unlock_pin/);
        strict_1.default.match(section[0], /wallet_user/);
        // Must capture previous state for forensics
        strict_1.default.match(section[0], /previous_failed_pin_attempts/);
        strict_1.default.match(section[0], /previous_pin_lockout_count/);
        strict_1.default.match(section[0], /previous_locked_until/);
    });
});
(0, node_test_1.describe)('C3-unlock — GET /v1/admin/wallet/users/:id/lockout-status', () => {
    (0, node_test_1.it)('route is registered', () => {
        strict_1.default.match(ADMIN_WALLET, /\/admin\/wallet\/users\/:id\/lockout-status/, 'must register the lockout-status route');
    });
    (0, node_test_1.it)('is admin-protected', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/lockout-status[\s\S]*?return reply\.send\(\{[\s\S]*?\}\s*\)/);
        strict_1.default.ok(section, 'must find lockout-status route body');
        strict_1.default.match(section[0], /requireAdmin\(request\.isAdmin\)/);
    });
    (0, node_test_1.it)('returns 404 when wallet not found', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/lockout-status[\s\S]*?(?=\/\*|$)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /404/);
    });
    (0, node_test_1.it)('returns is_locked, is_permanent, and lockout fields', () => {
        const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/lockout-status[\s\S]*?(?=\/\*|$)/);
        strict_1.default.ok(section);
        strict_1.default.match(section[0], /is_locked/);
        strict_1.default.match(section[0], /is_permanent/);
        strict_1.default.match(section[0], /failed_pin_attempts/);
        strict_1.default.match(section[0], /locked_until/);
        strict_1.default.match(section[0], /pin_lockout_count/);
    });
});
(0, node_test_1.describe)('C3-unlock — list and detail routes expose lockout columns', () => {
    (0, node_test_1.it)('GET /admin/wallet/users list selects locked_until', () => {
        // The list route section spans from the route declaration to the next route
        const listSection = ADMIN_WALLET.match(/\/admin\/wallet\/users'[\s\S]*?\/admin\/wallet\/users\/:id/);
        strict_1.default.ok(listSection, 'must find list route section');
        strict_1.default.match(listSection[0], /locked_until/);
        strict_1.default.match(listSection[0], /pin_lockout_count/);
    });
    (0, node_test_1.it)('GET /admin/wallet/users/:id detail selects locked_until', () => {
        // The detail route section spans from the route declaration to the next route (block)
        const detailSection = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id'[\s\S]*?\/admin\/wallet\/users\/:id\/block/);
        strict_1.default.ok(detailSection, 'must find detail route section');
        strict_1.default.match(detailSection[0], /locked_until/);
        strict_1.default.match(detailSection[0], /pin_lockout_count/);
    });
});
//# sourceMappingURL=c3-unlock-pin.test.js.map