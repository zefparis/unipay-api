"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const webhook_delivery_1 = require("../webhook-delivery");
function mockLogger() {
    const calls = [];
    return {
        info: (obj, msg) => calls.push({ level: 'info', obj, msg }),
        warn: (obj, msg) => calls.push({ level: 'warn', obj, msg }),
        error: (obj, msg) => calls.push({ level: 'error', obj, msg }),
        calls,
    };
}
function mockResponse(status) {
    return { status, ok: status >= 200 && status < 300 };
}
function fetchSequence(responses) {
    let callIndex = 0;
    const fn = async () => {
        const entry = responses[callIndex];
        callIndex++;
        if (!entry)
            throw new Error('Unexpected fetch call — no more responses queued');
        if (entry.type === 'error')
            throw new Error(entry.message);
        return mockResponse(entry.status);
    };
    // Track call count
    const tracker = { count: 0 };
    const wrapped = async () => {
        tracker.count++;
        return fn();
    };
    return { fn: wrapped, tracker };
}
// We can't use fake timers with node:test easily, so we override the
// backoff by monkey-patching setTimeout to be instant in tests.
const originalSetTimeout = setTimeout;
function installInstantTimers() {
    globalThis.setTimeout = ((fn) => originalSetTimeout(fn, 0));
}
function restoreTimers() {
    globalThis.setTimeout = originalSetTimeout;
}
(0, node_test_1.describe)('sendWebhookWithRetry', () => {
    (0, node_test_1.beforeEach)(() => installInstantTimers());
    (0, node_test_1.afterEach)(() => restoreTimers());
    (0, node_test_1.it)('succeeds on first attempt (200) and does not retry', async () => {
        const { fn, tracker } = fetchSequence([{ type: 'response', status: 200 }]);
        globalThis.fetch = fn;
        const log = mockLogger();
        const result = await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        strict_1.default.equal(result.success, true);
        strict_1.default.equal(result.attempts, 1);
        strict_1.default.equal(result.finalStatus, 200);
        strict_1.default.equal(tracker.count, 1); // no retry
    });
    (0, node_test_1.it)('retries 3 times on systematic failure (500), then abandons', async () => {
        const { fn, tracker } = fetchSequence([
            { type: 'response', status: 500 },
            { type: 'response', status: 500 },
            { type: 'response', status: 500 },
        ]);
        globalThis.fetch = fn;
        const log = mockLogger();
        const result = await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        strict_1.default.equal(result.success, false);
        strict_1.default.equal(result.attempts, 3);
        strict_1.default.equal(result.finalStatus, 500);
        strict_1.default.equal(tracker.count, 3); // exactly 3, no more
        // Should have logged the abandonment
        const errorLogs = log.calls.filter((c) => c.level === 'error');
        strict_1.default.equal(errorLogs.length, 1);
        strict_1.default.ok(errorLogs[0].msg.includes('abandoned'));
    });
    (0, node_test_1.it)('stops retrying after success on 2nd attempt (no 3rd call)', async () => {
        const { fn, tracker } = fetchSequence([
            { type: 'response', status: 503 }, // 1st: fail
            { type: 'response', status: 200 }, // 2nd: success
        ]);
        globalThis.fetch = fn;
        const log = mockLogger();
        const result = await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        strict_1.default.equal(result.success, true);
        strict_1.default.equal(result.attempts, 2);
        strict_1.default.equal(result.finalStatus, 200);
        strict_1.default.equal(tracker.count, 2); // no 3rd call
        // Should NOT have logged an abandonment error
        const errorLogs = log.calls.filter((c) => c.level === 'error');
        strict_1.default.equal(errorLogs.length, 0);
        // Should have logged a success on the 2nd attempt
        const infoLogs = log.calls.filter((c) => c.level === 'info' && c.msg.includes('successfully'));
        strict_1.default.equal(infoLogs.length, 1);
        strict_1.default.equal(infoLogs[0].obj.attempt, 2);
    });
    (0, node_test_1.it)('retries on network error (ECONNREFUSED), succeeds on 3rd', async () => {
        const { fn, tracker } = fetchSequence([
            { type: 'error', message: 'ECONNREFUSED' },
            { type: 'error', message: 'ETIMEDOUT' },
            { type: 'response', status: 200 },
        ]);
        globalThis.fetch = fn;
        const log = mockLogger();
        const result = await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        strict_1.default.equal(result.success, true);
        strict_1.default.equal(result.attempts, 3);
        strict_1.default.equal(result.finalStatus, 200);
        strict_1.default.equal(tracker.count, 3);
    });
    (0, node_test_1.it)('retries on 4xx response (429), succeeds on 2nd', async () => {
        const { fn, tracker } = fetchSequence([
            { type: 'response', status: 429 }, // rate limited
            { type: 'response', status: 200 },
        ]);
        globalThis.fetch = fn;
        const log = mockLogger();
        const result = await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        strict_1.default.equal(result.success, true);
        strict_1.default.equal(result.attempts, 2);
        strict_1.default.equal(tracker.count, 2);
    });
    (0, node_test_1.it)('logs each attempt with attempt number and max attempts', async () => {
        const { fn } = fetchSequence([
            { type: 'response', status: 500 },
            { type: 'response', status: 500 },
            { type: 'response', status: 500 },
        ]);
        globalThis.fetch = fn;
        const log = mockLogger();
        await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        // Should have 3 warn logs (one per failed attempt)
        const warnLogs = log.calls.filter((c) => c.level === 'warn');
        strict_1.default.equal(warnLogs.length, 3);
        strict_1.default.equal(warnLogs[0].obj.attempt, 1);
        strict_1.default.equal(warnLogs[0].obj.maxAttempts, 3);
        strict_1.default.equal(warnLogs[1].obj.attempt, 2);
        strict_1.default.equal(warnLogs[2].obj.attempt, 3);
    });
    (0, node_test_1.it)('abandons after 3 network errors with correct error message', async () => {
        const { fn } = fetchSequence([
            { type: 'error', message: 'ECONNREFUSED' },
            { type: 'error', message: 'ETIMEDOUT' },
            { type: 'error', message: 'ENOTFOUND' },
        ]);
        globalThis.fetch = fn;
        const log = mockLogger();
        const result = await (0, webhook_delivery_1.sendWebhookWithRetry)('https://example.com/webhook', '{"event":"test"}', { 'Content-Type': 'application/json' }, log);
        strict_1.default.equal(result.success, false);
        strict_1.default.equal(result.attempts, 3);
        strict_1.default.equal(result.finalStatus, undefined);
        strict_1.default.equal(result.finalError, 'ENOTFOUND');
    });
});
(0, node_test_1.describe)('buildWebhookSignature', () => {
    (0, node_test_1.it)('produces sha256= prefixed HMAC', () => {
        const sig = (0, webhook_delivery_1.buildWebhookSignature)('{"test":true}', 'whsec_secret123');
        strict_1.default.ok(sig.startsWith('sha256='));
        strict_1.default.equal(sig.length, 'sha256='.length + 64); // 64 hex chars for sha256
    });
    (0, node_test_1.it)('produces deterministic output for same input', () => {
        const sig1 = (0, webhook_delivery_1.buildWebhookSignature)('{"test":true}', 'whsec_secret123');
        const sig2 = (0, webhook_delivery_1.buildWebhookSignature)('{"test":true}', 'whsec_secret123');
        strict_1.default.equal(sig1, sig2);
    });
    (0, node_test_1.it)('produces different output for different secrets', () => {
        const sig1 = (0, webhook_delivery_1.buildWebhookSignature)('{"test":true}', 'whsec_secret1');
        const sig2 = (0, webhook_delivery_1.buildWebhookSignature)('{"test":true}', 'whsec_secret2');
        strict_1.default.notEqual(sig1, sig2);
    });
});
//# sourceMappingURL=webhook-delivery.test.js.map