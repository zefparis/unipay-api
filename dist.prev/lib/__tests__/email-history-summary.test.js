"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
function computeEmailHistorySummary(messages, merchantConvIds) {
    // Filter: only email channel, only this merchant's conversations, only with non-empty template_label
    const filtered = messages.filter((m) => m.channel === 'email' &&
        m.template_label != null &&
        m.template_label !== '' &&
        merchantConvIds.has(m.conversation_id));
    const summaryMap = new Map();
    for (const m of filtered) {
        const existing = summaryMap.get(m.template_label);
        if (existing) {
            existing.count += 1;
            if (m.created_at > existing.last_sent_at) {
                existing.last_sent_at = m.created_at;
            }
        }
        else {
            summaryMap.set(m.template_label, {
                template_label: m.template_label,
                count: 1,
                last_sent_at: m.created_at,
            });
        }
    }
    return Array.from(summaryMap.values()).sort((a, b) => b.last_sent_at.localeCompare(a.last_sent_at));
}
function countKycReminders(messages, convToMerchant, merchantId) {
    const merchantConvIds = new Set();
    for (const [convId, mid] of convToMerchant) {
        if (mid === merchantId)
            merchantConvIds.add(convId);
    }
    let count = 0;
    let lastSentAt = null;
    for (const m of messages) {
        if (m.channel !== 'email')
            continue;
        if (!m.template_label || m.template_label === '')
            continue;
        if (!merchantConvIds.has(m.conversation_id))
            continue;
        if (!/kyc/i.test(m.template_label))
            continue;
        count += 1;
        if (!lastSentAt || m.created_at > lastSentAt) {
            lastSentAt = m.created_at;
        }
    }
    return { count, last_sent_at: lastSentAt };
}
(0, node_test_1.describe)('Email history summary', () => {
    (0, node_test_1.it)('groups by template_label and counts correctly', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-05T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Bienvenue', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
        ];
        const convIds = new Set(['c1']);
        const summary = computeEmailHistorySummary(messages, convIds);
        strict_1.default.equal(summary.length, 2);
        const kyc = summary.find((s) => s.template_label === 'Relance KYC');
        strict_1.default.equal(kyc.count, 2);
        strict_1.default.equal(kyc.last_sent_at, '2026-09-05T10:00:00Z');
        const welcome = summary.find((s) => s.template_label === 'Bienvenue');
        strict_1.default.equal(welcome.count, 1);
        strict_1.default.equal(welcome.last_sent_at, '2026-09-02T10:00:00Z');
    });
    (0, node_test_1.it)('merchant with no emails returns empty summary', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
        ];
        const convIds = new Set(); // this merchant has no conversations
        const summary = computeEmailHistorySummary(messages, convIds);
        strict_1.default.equal(summary.length, 0);
    });
    (0, node_test_1.it)('excludes non-email channels (chat bot messages)', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-02T10:00:00Z', channel: 'chat' },
            { conversation_id: 'c1', template_label: 'Support bot', created_at: '2026-09-03T10:00:00Z', channel: 'chat' },
        ];
        const convIds = new Set(['c1']);
        const summary = computeEmailHistorySummary(messages, convIds);
        // Only the email message should be counted
        strict_1.default.equal(summary.length, 1);
        strict_1.default.equal(summary[0].template_label, 'Relance KYC');
        strict_1.default.equal(summary[0].count, 1);
        strict_1.default.equal(summary[0].last_sent_at, '2026-09-01T10:00:00Z');
    });
    (0, node_test_1.it)('excludes messages without template_label (free-form)', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: '', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
        ];
        const convIds = new Set(['c1']);
        const summary = computeEmailHistorySummary(messages, convIds);
        strict_1.default.equal(summary.length, 1);
        strict_1.default.equal(summary[0].count, 1);
    });
    (0, node_test_1.it)('only includes messages from this merchant (isolation)', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c2', template_label: 'Relance KYC', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
        ];
        // Merchant A only owns c1
        const convIds = new Set(['c1']);
        const summary = computeEmailHistorySummary(messages, convIds);
        strict_1.default.equal(summary.length, 1);
        strict_1.default.equal(summary[0].count, 1);
        strict_1.default.equal(summary[0].last_sent_at, '2026-09-01T10:00:00Z');
    });
    (0, node_test_1.it)('last_sent_at is the most recent date for each template', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-08-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-15T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
        ];
        const convIds = new Set(['c1']);
        const summary = computeEmailHistorySummary(messages, convIds);
        strict_1.default.equal(summary[0].count, 3);
        strict_1.default.equal(summary[0].last_sent_at, '2026-09-15T10:00:00Z');
    });
    (0, node_test_1.it)('results sorted by last_sent_at descending', () => {
        const messages = [
            { conversation_id: 'c1', template_label: 'Old template', created_at: '2026-08-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'New template', created_at: '2026-09-15T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Mid template', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
        ];
        const convIds = new Set(['c1']);
        const summary = computeEmailHistorySummary(messages, convIds);
        strict_1.default.equal(summary[0].template_label, 'New template');
        strict_1.default.equal(summary[1].template_label, 'Mid template');
        strict_1.default.equal(summary[2].template_label, 'Old template');
    });
});
(0, node_test_1.describe)('KYC reminder count for merchant list', () => {
    (0, node_test_1.it)('counts only KYC-related templates', () => {
        const convToMerchant = new Map([
            ['c1', 'm1'],
        ]);
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'KYC en cours de revue', created_at: '2026-09-05T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Bienvenue', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
        ];
        const result = countKycReminders(messages, convToMerchant, 'm1');
        strict_1.default.equal(result.count, 2); // "Relance KYC" + "KYC en cours de revue"
        strict_1.default.equal(result.last_sent_at, '2026-09-05T10:00:00Z');
    });
    (0, node_test_1.it)('merchant with no KYC reminders returns count=0, last_sent_at=null', () => {
        const convToMerchant = new Map([['c1', 'm1']]);
        const messages = [
            { conversation_id: 'c1', template_label: 'Bienvenue', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
        ];
        const result = countKycReminders(messages, convToMerchant, 'm1');
        strict_1.default.equal(result.count, 0);
        strict_1.default.equal(result.last_sent_at, null);
    });
    (0, node_test_1.it)('merchant with no conversations returns count=0', () => {
        const convToMerchant = new Map([['c2', 'm2']]);
        const messages = [
            { conversation_id: 'c2', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
        ];
        const result = countKycReminders(messages, convToMerchant, 'm1');
        strict_1.default.equal(result.count, 0);
        strict_1.default.equal(result.last_sent_at, null);
    });
    (0, node_test_1.it)('excludes chat channel messages from KYC count', () => {
        const convToMerchant = new Map([['c1', 'm1']]);
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-02T10:00:00Z', channel: 'chat' },
        ];
        const result = countKycReminders(messages, convToMerchant, 'm1');
        strict_1.default.equal(result.count, 1); // only email
        strict_1.default.equal(result.last_sent_at, '2026-09-01T10:00:00Z');
    });
    (0, node_test_1.it)('multiple merchants are isolated correctly', () => {
        const convToMerchant = new Map([
            ['c1', 'm1'],
            ['c2', 'm2'],
        ]);
        const messages = [
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'Relance KYC', created_at: '2026-09-05T10:00:00Z', channel: 'email' },
            { conversation_id: 'c2', template_label: 'Relance KYC', created_at: '2026-09-03T10:00:00Z', channel: 'email' },
        ];
        const m1 = countKycReminders(messages, convToMerchant, 'm1');
        const m2 = countKycReminders(messages, convToMerchant, 'm2');
        strict_1.default.equal(m1.count, 2);
        strict_1.default.equal(m1.last_sent_at, '2026-09-05T10:00:00Z');
        strict_1.default.equal(m2.count, 1);
        strict_1.default.equal(m2.last_sent_at, '2026-09-03T10:00:00Z');
    });
    (0, node_test_1.it)('KYC template matching is case-insensitive', () => {
        const convToMerchant = new Map([['c1', 'm1']]);
        const messages = [
            { conversation_id: 'c1', template_label: 'relance kyc', created_at: '2026-09-01T10:00:00Z', channel: 'email' },
            { conversation_id: 'c1', template_label: 'KYC Reminder', created_at: '2026-09-02T10:00:00Z', channel: 'email' },
        ];
        const result = countKycReminders(messages, convToMerchant, 'm1');
        strict_1.default.equal(result.count, 2);
    });
});
//# sourceMappingURL=email-history-summary.test.js.map