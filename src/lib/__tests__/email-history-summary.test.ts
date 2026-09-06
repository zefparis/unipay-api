import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the email history summary logic.
 *
 * The route queries Supabase, so we test the aggregation/grouping
 * logic that the route applies to the raw message data.
 */

interface RawMessage {
  conversation_id: string;
  template_label: string;
  created_at: string;
  channel: string;
}

interface TemplateSummary {
  template_label: string;
  count: number;
  last_sent_at: string;
}

function computeEmailHistorySummary(
  messages: RawMessage[],
  merchantConvIds: Set<string>,
): TemplateSummary[] {
  // Filter: only email channel, only this merchant's conversations, only with non-empty template_label
  const filtered = messages.filter(
    (m) =>
      m.channel === 'email' &&
      m.template_label != null &&
      m.template_label !== '' &&
      merchantConvIds.has(m.conversation_id),
  );

  const summaryMap = new Map<string, TemplateSummary>();
  for (const m of filtered) {
    const existing = summaryMap.get(m.template_label);
    if (existing) {
      existing.count += 1;
      if (m.created_at > existing.last_sent_at) {
        existing.last_sent_at = m.created_at;
      }
    } else {
      summaryMap.set(m.template_label, {
        template_label: m.template_label,
        count: 1,
        last_sent_at: m.created_at,
      });
    }
  }

  return Array.from(summaryMap.values()).sort((a, b) =>
    b.last_sent_at.localeCompare(a.last_sent_at),
  );
}

function countKycReminders(
  messages: RawMessage[],
  convToMerchant: Map<string, string>,
  merchantId: string,
): { count: number; last_sent_at: string | null } {
  const merchantConvIds = new Set<string>();
  for (const [convId, mid] of convToMerchant) {
    if (mid === merchantId) merchantConvIds.add(convId);
  }

  let count = 0;
  let lastSentAt: string | null = null;

  for (const m of messages) {
    if (m.channel !== 'email') continue;
    if (!m.template_label || m.template_label === '') continue;
    if (!merchantConvIds.has(m.conversation_id)) continue;
    if (!/kyc/i.test(m.template_label)) continue;

    count += 1;
    if (!lastSentAt || m.created_at > lastSentAt) {
      lastSentAt = m.created_at;
    }
  }

  return { count, last_sent_at: lastSentAt };
}

describe('Email history summary', () => {
  it('groups by template_label and counts correctly', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-05T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Bienvenue', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
    ];
    const convIds = new Set(['c1']);
    const summary = computeEmailHistorySummary(messages, convIds);

    assert.equal(summary.length, 2);

    const kyc = summary.find((s) => s.template_label === 'Relance KYC')!;
    assert.equal(kyc.count, 2);
    assert.equal(kyc.last_sent_at, '2026-09-05T10:00:00Z');

    const welcome = summary.find((s) => s.template_label === 'Bienvenue')!;
    assert.equal(welcome.count, 1);
    assert.equal(welcome.last_sent_at, '2026-09-02T10:00:00Z');
  });

  it('merchant with no emails returns empty summary', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
    ];
    const convIds = new Set<string>(); // this merchant has no conversations
    const summary = computeEmailHistorySummary(messages, convIds);
    assert.equal(summary.length, 0);
  });

  it('excludes non-email channels (chat bot messages)', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-02T10:00:00Z', channel: 'chat' },
      { conversation_id: 'c1', template_label: 'Support bot', created_at: '2026-09-03T10:00:00Z', channel: 'chat' },
    ];
    const convIds = new Set(['c1']);
    const summary = computeEmailHistorySummary(messages, convIds);

    // Only the email message should be counted
    assert.equal(summary.length, 1);
    assert.equal(summary[0].template_label, 'Relance KYC');
    assert.equal(summary[0].count, 1);
    assert.equal(summary[0].last_sent_at, '2026-09-01T10:00:00Z');
  });

  it('excludes messages without template_label (free-form)', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: '', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
    ];
    const convIds = new Set(['c1']);
    const summary = computeEmailHistorySummary(messages, convIds);

    assert.equal(summary.length, 1);
    assert.equal(summary[0].count, 1);
  });

  it('only includes messages from this merchant (isolation)', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c2', template_label: 'Relance KYC', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
    ];
    // Merchant A only owns c1
    const convIds = new Set(['c1']);
    const summary = computeEmailHistorySummary(messages, convIds);

    assert.equal(summary.length, 1);
    assert.equal(summary[0].count, 1);
    assert.equal(summary[0].last_sent_at, '2026-09-01T10:00:00Z');
  });

  it('last_sent_at is the most recent date for each template', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-08-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-15T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
    ];
    const convIds = new Set(['c1']);
    const summary = computeEmailHistorySummary(messages, convIds);

    assert.equal(summary[0].count, 3);
    assert.equal(summary[0].last_sent_at, '2026-09-15T10:00:00Z');
  });

  it('results sorted by last_sent_at descending', () => {
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Old template', created_at: '2026-08-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'New template', created_at: '2026-09-15T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Mid template', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
    ];
    const convIds = new Set(['c1']);
    const summary = computeEmailHistorySummary(messages, convIds);

    assert.equal(summary[0].template_label, 'New template');
    assert.equal(summary[1].template_label, 'Mid template');
    assert.equal(summary[2].template_label, 'Old template');
  });
});

describe('KYC reminder count for merchant list', () => {
  it('counts only KYC-related templates', () => {
    const convToMerchant = new Map([
      ['c1', 'm1'],
    ]);
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'KYC en cours de revue', created_at: '2026-09-05T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Bienvenue', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
    ];

    const result = countKycReminders(messages, convToMerchant, 'm1');
    assert.equal(result.count, 2); // "Relance KYC" + "KYC en cours de revue"
    assert.equal(result.last_sent_at, '2026-09-05T10:00:00Z');
  });

  it('merchant with no KYC reminders returns count=0, last_sent_at=null', () => {
    const convToMerchant = new Map([['c1', 'm1']]);
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Bienvenue', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
    ];

    const result = countKycReminders(messages, convToMerchant, 'm1');
    assert.equal(result.count, 0);
    assert.equal(result.last_sent_at, null);
  });

  it('merchant with no conversations returns count=0', () => {
    const convToMerchant = new Map([['c2', 'm2']]);
    const messages: RawMessage[] = [
      { conversation_id: 'c2', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
    ];

    const result = countKycReminders(messages, convToMerchant, 'm1');
    assert.equal(result.count, 0);
    assert.equal(result.last_sent_at, null);
  });

  it('excludes chat channel messages from KYC count', () => {
    const convToMerchant = new Map([['c1', 'm1']]);
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-02T10:00:00Z', channel: 'chat' },
    ];

    const result = countKycReminders(messages, convToMerchant, 'm1');
    assert.equal(result.count, 1); // only email
    assert.equal(result.last_sent_at, '2026-09-01T10:00:00Z');
  });

  it('multiple merchants are isolated correctly', () => {
    const convToMerchant = new Map([
      ['c1', 'm1'],
      ['c2', 'm2'],
    ]);
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-05T10:00:00Z', channel: 'email' },
      { conversation_id: 'c2', template_label: 'Relance KYC', created_at: '2026-09-03T10:00:00Z', channel: 'email' },
    ];

    const m1 = countKycReminders(messages, convToMerchant, 'm1');
    const m2 = countKycReminders(messages, convToMerchant, 'm2');

    assert.equal(m1.count, 2);
    assert.equal(m1.last_sent_at, '2026-09-05T10:00:00Z');
    assert.equal(m2.count, 1);
    assert.equal(m2.last_sent_at, '2026-09-03T10:00:00Z');
  });

  it('KYC template matching is case-insensitive', () => {
    const convToMerchant = new Map([['c1', 'm1']]);
    const messages: RawMessage[] = [
      { conversation_id: 'c1', template_label: 'relance kyc', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
      { conversation_id: 'c1', template_label: 'KYC Reminder', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
    ];

    const result = countKycReminders(messages, convToMerchant, 'm1');
    assert.equal(result.count, 2);
  });
});
