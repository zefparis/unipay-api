"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const sandbox_mode_js_1 = require("../sandbox-mode.js");
(0, node_test_1.describe)('isSandboxAllowed', () => {
    (0, node_test_1.it)('ignores a client sandbox header in production', () => {
        strict_1.default.equal((0, sandbox_mode_js_1.isSandboxAllowed)('production', 'sandbox'), false);
    });
    (0, node_test_1.it)('allows sandbox only outside production when explicitly requested', () => {
        strict_1.default.equal((0, sandbox_mode_js_1.isSandboxAllowed)('development', 'sandbox'), true);
        strict_1.default.equal((0, sandbox_mode_js_1.isSandboxAllowed)('test', 'sandbox'), true);
        strict_1.default.equal((0, sandbox_mode_js_1.isSandboxAllowed)('development', undefined), false);
    });
    (0, node_test_1.it)('routes every client sandbox header through the server-side environment guard', () => {
        for (const route of [
            'src/routes/wallet/deposit.ts',
            'src/routes/wallet/withdraw.ts',
            'src/routes/payment/initiate.ts',
        ]) {
            const source = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), route), 'utf8');
            strict_1.default.match(source, /isSandboxAllowed\(env\.NODE_ENV, request\.headers\['x-unipay-mode'\]\)/);
            strict_1.default.doesNotMatch(source, /request\.headers\['x-unipay-mode'\] === 'sandbox'/);
        }
    });
});
//# sourceMappingURL=sandbox-mode.test.js.map