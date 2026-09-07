import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendWebhookWithRetry, buildWebhookSignature } from '../webhook-delivery';

/**
 * Tests for the webhook retry mechanism.
 *
 * We mock global fetch to simulate success/failure scenarios and
 * verify that:
 * - 3 attempts are made on systematic failure
 * - Success on 2nd attempt stops the loop (no 3rd call)
 * - Network errors trigger retries
 * - 4xx responses trigger retries (not just 5xx)
 */

// Mock logger that records all calls
interface LogCall { level: string; obj: Record<string, unknown>; msg: string }

function mockLogger() {
  const calls: LogCall[] = [];
  return {
    info: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'info', obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'warn', obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'error', obj, msg }),
    calls,
  };
}

function mockResponse(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

type FetchEntry = { type: 'response'; status: number } | { type: 'error'; message: string };

function fetchSequence(responses: FetchEntry[]) {
  let callIndex = 0;
  const fn = async (): Promise<Response> => {
    const entry = responses[callIndex];
    callIndex++;
    if (!entry) throw new Error('Unexpected fetch call — no more responses queued');
    if (entry.type === 'error') throw new Error(entry.message);
    return mockResponse(entry.status);
  };
  // Track call count
  const tracker = { count: 0 };
  const wrapped = async (): Promise<Response> => {
    tracker.count++;
    return fn();
  };
  return { fn: wrapped, tracker };
}

// We can't use fake timers with node:test easily, so we override the
// backoff by monkey-patching setTimeout to be instant in tests.
const originalSetTimeout = setTimeout;

function installInstantTimers() {
  globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as typeof setTimeout;
}

function restoreTimers() {
  globalThis.setTimeout = originalSetTimeout;
}

describe('sendWebhookWithRetry', () => {
  beforeEach(() => installInstantTimers());
  afterEach(() => restoreTimers());

  it('succeeds on first attempt (200) and does not retry', async () => {
    const { fn, tracker } = fetchSequence([{ type: 'response', status: 200 }]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    const result = await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.finalStatus, 200);
    assert.equal(tracker.count, 1); // no retry
  });

  it('retries 3 times on systematic failure (500), then abandons', async () => {
    const { fn, tracker } = fetchSequence([
      { type: 'response', status: 500 },
      { type: 'response', status: 500 },
      { type: 'response', status: 500 },
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    const result = await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    assert.equal(result.success, false);
    assert.equal(result.attempts, 3);
    assert.equal(result.finalStatus, 500);
    assert.equal(tracker.count, 3); // exactly 3, no more

    // Should have logged the abandonment
    const errorLogs = log.calls.filter((c) => c.level === 'error');
    assert.equal(errorLogs.length, 1);
    assert.ok(errorLogs[0].msg.includes('abandoned'));
  });

  it('stops retrying after success on 2nd attempt (no 3rd call)', async () => {
    const { fn, tracker } = fetchSequence([
      { type: 'response', status: 503 }, // 1st: fail
      { type: 'response', status: 200 }, // 2nd: success
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    const result = await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.finalStatus, 200);
    assert.equal(tracker.count, 2); // no 3rd call

    // Should NOT have logged an abandonment error
    const errorLogs = log.calls.filter((c) => c.level === 'error');
    assert.equal(errorLogs.length, 0);

    // Should have logged a success on the 2nd attempt
    const infoLogs = log.calls.filter((c) => c.level === 'info' && c.msg.includes('successfully'));
    assert.equal(infoLogs.length, 1);
    assert.equal(infoLogs[0].obj.attempt, 2);
  });

  it('retries on network error (ECONNREFUSED), succeeds on 3rd', async () => {
    const { fn, tracker } = fetchSequence([
      { type: 'error', message: 'ECONNREFUSED' },
      { type: 'error', message: 'ETIMEDOUT' },
      { type: 'response', status: 200 },
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    const result = await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    assert.equal(result.success, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.finalStatus, 200);
    assert.equal(tracker.count, 3);
  });

  it('retries on 4xx response (429), succeeds on 2nd', async () => {
    const { fn, tracker } = fetchSequence([
      { type: 'response', status: 429 }, // rate limited
      { type: 'response', status: 200 },
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    const result = await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.equal(tracker.count, 2);
  });

  it('logs each attempt with attempt number and max attempts', async () => {
    const { fn } = fetchSequence([
      { type: 'response', status: 500 },
      { type: 'response', status: 500 },
      { type: 'response', status: 500 },
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    // Should have 3 warn logs (one per failed attempt)
    const warnLogs = log.calls.filter((c) => c.level === 'warn');
    assert.equal(warnLogs.length, 3);
    assert.equal(warnLogs[0].obj.attempt, 1);
    assert.equal(warnLogs[0].obj.maxAttempts, 3);
    assert.equal(warnLogs[1].obj.attempt, 2);
    assert.equal(warnLogs[2].obj.attempt, 3);
  });

  it('abandons after 3 network errors with correct error message', async () => {
    const { fn } = fetchSequence([
      { type: 'error', message: 'ECONNREFUSED' },
      { type: 'error', message: 'ETIMEDOUT' },
      { type: 'error', message: 'ENOTFOUND' },
    ]);
    globalThis.fetch = fn as unknown as typeof fetch;
    const log = mockLogger();

    const result = await sendWebhookWithRetry(
      'https://example.com/webhook',
      '{"event":"test"}',
      { 'Content-Type': 'application/json' },
      log,
    );

    assert.equal(result.success, false);
    assert.equal(result.attempts, 3);
    assert.equal(result.finalStatus, undefined);
    assert.equal(result.finalError, 'ENOTFOUND');
  });
});

describe('buildWebhookSignature', () => {
  it('produces sha256= prefixed HMAC', () => {
    const sig = buildWebhookSignature('{"test":true}', 'whsec_secret123');
    assert.ok(sig.startsWith('sha256='));
    assert.equal(sig.length, 'sha256='.length + 64); // 64 hex chars for sha256
  });

  it('produces deterministic output for same input', () => {
    const sig1 = buildWebhookSignature('{"test":true}', 'whsec_secret123');
    const sig2 = buildWebhookSignature('{"test":true}', 'whsec_secret123');
    assert.equal(sig1, sig2);
  });

  it('produces different output for different secrets', () => {
    const sig1 = buildWebhookSignature('{"test":true}', 'whsec_secret1');
    const sig2 = buildWebhookSignature('{"test":true}', 'whsec_secret2');
    assert.notEqual(sig1, sig2);
  });
});
