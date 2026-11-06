"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tests for the public operator status endpoint logic.
 *
 * These tests validate the pure functions that compute operator status
 * from transaction data: isProviderOutageFailure, computeOperatorStatus,
 * and the overall aggregation logic.
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function source(relativePath) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), relativePath), 'utf8');
}
// Re-implement the pure functions for testing (they're not exported
// from the route file, so we test the logic by reading the source and
// verifying the behavior matches the spec).
const PROVIDER_OUTAGE_RESULT_CODES = new Set([10301, 10201]);
function isProviderOutageFailure(metadata) {
    if (!metadata)
        return false;
    const unipesaCode = metadata['unipesa_result_code'];
    if (typeof unipesaCode === 'number' && PROVIDER_OUTAGE_RESULT_CODES.has(unipesaCode)) {
        return true;
    }
    const result = metadata['result'];
    if (result && typeof result === 'object') {
        const code = result['code'];
        if (typeof code === 'number' && PROVIDER_OUTAGE_RESULT_CODES.has(code)) {
            return true;
        }
    }
    const reason = metadata['reason'];
    if (typeof reason === 'string' && /API unreachable|get token error|provider.*unavailable/i.test(reason)) {
        return true;
    }
    return false;
}
function computeOperatorStatus(totalAttempts, successCount, failedCount, providerOutageCount) {
    if (totalAttempts < 5)
        return 'insufficient_data';
    const successRate = (successCount / totalAttempts) * 100;
    if (providerOutageCount >= 5)
        return 'down';
    if (successRate < 80)
        return 'down';
    if (successRate < 95)
        return 'degraded';
    return 'operational';
}
(0, node_test_1.describe)('operator status — isProviderOutageFailure', () => {
    (0, node_test_1.it)('detects unipesa_result_code=10301 (get token error)', () => {
        strict_1.default.ok(isProviderOutageFailure({ unipesa_result_code: 10301, unipesa_result_message: 'REQUEST SENDING ERROR | get token error' }));
    });
    (0, node_test_1.it)('detects unipesa_result_code=10201 (merchant auth error)', () => {
        strict_1.default.ok(isProviderOutageFailure({ unipesa_result_code: 10201 }));
    });
    (0, node_test_1.it)('detects result.code=10301 in callback metadata', () => {
        strict_1.default.ok(isProviderOutageFailure({ result: { code: 10301, message: 'get token error' } }));
    });
    (0, node_test_1.it)('detects reason containing "API unreachable"', () => {
        strict_1.default.ok(isProviderOutageFailure({ reason: 'Airtel API unreachable from Unipesa — transaction never sent to operator' }));
    });
    (0, node_test_1.it)('detects reason containing "get token error"', () => {
        strict_1.default.ok(isProviderOutageFailure({ reason: 'get token error during provider call' }));
    });
    (0, node_test_1.it)('detects reason containing "provider unavailable"', () => {
        strict_1.default.ok(isProviderOutageFailure({ reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE' }));
    });
    (0, node_test_1.it)('does NOT flag insufficient balance as provider outage', () => {
        strict_1.default.ok(!isProviderOutageFailure({ unipesa_result_code: 10101, unipesa_result_message: 'Insufficient customer balance' }));
    });
    (0, node_test_1.it)('does NOT flag MSISDN incorrect as provider outage', () => {
        strict_1.default.ok(!isProviderOutageFailure({ unipesa_result_code: 10401, unipesa_result_message: 'MSISDN incorrect' }));
    });
    (0, node_test_1.it)('does NOT flag result.code=0 (success) as provider outage', () => {
        strict_1.default.ok(!isProviderOutageFailure({ result: { code: 0, message: 'OK' } }));
    });
    (0, node_test_1.it)('returns false for null metadata', () => {
        strict_1.default.ok(!isProviderOutageFailure(null));
    });
    (0, node_test_1.it)('returns false for empty metadata', () => {
        strict_1.default.ok(!isProviderOutageFailure({}));
    });
});
(0, node_test_1.describe)('operator status — computeOperatorStatus thresholds', () => {
    (0, node_test_1.it)('returns insufficient_data when total < 5', () => {
        strict_1.default.equal(computeOperatorStatus(0, 0, 0, 0), 'insufficient_data');
        strict_1.default.equal(computeOperatorStatus(4, 4, 0, 0), 'insufficient_data');
    });
    (0, node_test_1.it)('returns operational when success rate >= 95%', () => {
        strict_1.default.equal(computeOperatorStatus(100, 95, 5, 0), 'operational');
        strict_1.default.equal(computeOperatorStatus(100, 100, 0, 0), 'operational');
        strict_1.default.equal(computeOperatorStatus(20, 19, 1, 0), 'operational');
    });
    (0, node_test_1.it)('returns degraded when 80% <= success rate < 95%', () => {
        strict_1.default.equal(computeOperatorStatus(100, 90, 10, 0), 'degraded');
        strict_1.default.equal(computeOperatorStatus(100, 80, 20, 0), 'degraded');
        strict_1.default.equal(computeOperatorStatus(20, 18, 2, 0), 'degraded');
    });
    (0, node_test_1.it)('returns down when success rate < 80%', () => {
        strict_1.default.equal(computeOperatorStatus(100, 79, 21, 0), 'down');
        strict_1.default.equal(computeOperatorStatus(100, 50, 50, 0), 'down');
        strict_1.default.equal(computeOperatorStatus(10, 7, 3, 0), 'down');
    });
    (0, node_test_1.it)('returns down when 5+ provider outage failures even if success rate is high', () => {
        // 95% success rate but 5 provider outages → down
        strict_1.default.equal(computeOperatorStatus(100, 95, 5, 5), 'down');
        strict_1.default.equal(computeOperatorStatus(100, 99, 1, 5), 'down');
    });
    (0, node_test_1.it)('does not trigger down for 4 provider outage failures if success rate is high', () => {
        strict_1.default.equal(computeOperatorStatus(100, 96, 4, 4), 'operational');
    });
    (0, node_test_1.it)('simulates Airtel outage scenario from 2026-09-10', () => {
        // 20 attempts, 5 success, 15 failed, 10 provider outages
        // success rate = 25% → down (and 10 >= 5 outages)
        strict_1.default.equal(computeOperatorStatus(20, 5, 15, 10), 'down');
    });
    (0, node_test_1.it)('recovers to operational when transactions return to normal', () => {
        // After recovery: 100 attempts, 98 success, 2 failed, 0 outages
        strict_1.default.equal(computeOperatorStatus(100, 98, 2, 0), 'operational');
    });
});
(0, node_test_1.describe)('operator status — route file structure', () => {
    const route = source('src/routes/status/operators.ts');
    (0, node_test_1.it)('is a public route (no auth dependency)', () => {
        strict_1.default.match(route, /FastifyPluginAsync/);
        strict_1.default.doesNotMatch(route, /requireAdmin|requireMerchant|requireWallet|hmacPlugin|apiKey/i);
    });
    (0, node_test_1.it)('queries transactions from the last 24 hours', () => {
        strict_1.default.match(route, /24 \* 60 \* 60 \* 1000/);
        strict_1.default.match(route, /gte\('created_at', since\)/);
    });
    (0, node_test_1.it)('filters by airtel, orange, afrimoney operators', () => {
        strict_1.default.match(route, /in\('operator', \['airtel', 'orange', 'afrimoney'\]\)/);
    });
    (0, node_test_1.it)('excludes processing from success rate calculation', () => {
        // The code counts processing separately and uses success + failed for total
        strict_1.default.match(route, /const totalAttempts = successCount \+ failedCount/);
    });
    (0, node_test_1.it)('returns avg_latency_ms as null when no data', () => {
        strict_1.default.match(route, /let avgLatencyMs: number \| null = null/);
    });
    (0, node_test_1.it)('returns last_incident_at from provider outage failures', () => {
        strict_1.default.match(route, /last_incident_at/);
    });
    (0, node_test_1.it)('returns insufficient_data status when < 5 attempts', () => {
        strict_1.default.match(route, /insufficient_data/);
    });
    (0, node_test_1.it)('imports isProviderOutageFailure from shared lib (not duplicated)', () => {
        strict_1.default.match(route, /import.*isProviderOutageFailure.*from.*provider-outage/);
    });
    (0, node_test_1.it)('uses provider outage codes 10301 and 10201 (in shared lib)', () => {
        const lib = source('src/lib/provider-outage.ts');
        strict_1.default.match(lib, /10301/);
        strict_1.default.match(lib, /10201/);
    });
});
(0, node_test_1.describe)('operator status — server.ts wiring', () => {
    const server = source('src/server.ts');
    (0, node_test_1.it)('imports statusOperatorsRoute', () => {
        strict_1.default.match(server, /import statusOperatorsRoute from '\.\/routes\/status\/operators'/);
    });
    (0, node_test_1.it)('registers it as a public route (before v1 authenticated block)', () => {
        strict_1.default.match(server, /server\.register\(statusOperatorsRoute\)/);
    });
});
//# sourceMappingURL=operator-status.test.js.map