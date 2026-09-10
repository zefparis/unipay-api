/**
 * Public operator status endpoint.
 *
 * GET /v1/status/operators
 *
 * Returns real-time operator health computed from the last 24h of
 * transactions in the `transactions` table. No authentication required
 * (the status page is public). CORS allows unipaycongo.com.
 *
 * For each operator (airtel, orange, afrimoney), computes:
 *   - total_attempts_24h: count of terminal transactions (success + failed)
 *   - success_rate_pct: success / (success + failed) * 100
 *   - status: operational | degraded | down | insufficient_data
 *   - last_incident_at: timestamp of the most recent provider-outage failure
 *
 * Provider-outage failures are detected via metadata:
 *   - metadata.unipesa_result_code = 10301 (get token error)
 *   - metadata.result.code = 10301
 *   - metadata.reason contains "Airtel API unreachable" or similar
 *
 * Thresholds:
 *   - success_rate >= 95% → operational
 *   - 80% <= success_rate < 95% → degraded
 *   - success_rate < 80% OR 5+ provider-outage failures in 24h → down
 *   - total_attempts < 5 → insufficient_data
 */

import type { FastifyPluginAsync } from 'fastify';

interface OperatorRow {
  operator: string;
  status: 'operational' | 'degraded' | 'down' | 'insufficient_data';
  success_rate_pct: number | null;
  total_attempts_24h: number;
  success_count: number;
  failed_count: number;
  processing_count: number;
  provider_outage_failures_24h: number;
  avg_latency_ms: number | null;
  last_incident_at: string | null;
}

interface DbRow {
  operator: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

const OPERATOR_NAMES: Record<string, string> = {
  airtel: 'Airtel Money',
  orange: 'Orange Money',
  afrimoney: 'Afrimoney',
};

const PROVIDER_OUTAGE_RESULT_CODES = new Set([10301, 10201]);

function isProviderOutageFailure(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  // Reconciliation metadata: unipesa_result_code
  const unipesaCode = metadata['unipesa_result_code'];
  if (typeof unipesaCode === 'number' && PROVIDER_OUTAGE_RESULT_CODES.has(unipesaCode)) {
    return true;
  }
  // Callback metadata: result.code
  const result = metadata['result'];
  if (result && typeof result === 'object') {
    const code = (result as Record<string, unknown>)['code'];
    if (typeof code === 'number' && PROVIDER_OUTAGE_RESULT_CODES.has(code)) {
      return true;
    }
  }
  // Reason-based detection (manual reconciliation)
  const reason = metadata['reason'];
  if (typeof reason === 'string' && /API unreachable|get token error|provider.*unavailable/i.test(reason)) {
    return true;
  }
  return false;
}

function computeOperatorStatus(
  totalAttempts: number,
  successCount: number,
  failedCount: number,
  providerOutageCount: number,
): OperatorRow['status'] {
  if (totalAttempts < 5) return 'insufficient_data';
  const successRate = (successCount / totalAttempts) * 100;
  if (providerOutageCount >= 5) return 'down';
  if (successRate < 80) return 'down';
  if (successRate < 95) return 'degraded';
  return 'operational';
}

const statusRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/status/operators',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              operators: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    operator: { type: 'string' },
                    name: { type: 'string' },
                    status: { type: 'string' },
                    success_rate_pct: { type: ['number', 'null'] },
                    total_attempts_24h: { type: 'number' },
                    success_count: { type: 'number' },
                    failed_count: { type: 'number' },
                    processing_count: { type: 'number' },
                    provider_outage_failures_24h: { type: 'number' },
                    avg_latency_ms: { type: ['number', 'null'] },
                    last_incident_at: { type: ['string', 'null'] },
                  },
                },
              },
              generated_at: { type: 'string' },
            },
          },
        },
      },
    },
    async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await fastify.supabase
        .from('transactions')
        .select('operator, status, created_at, updated_at, metadata')
        .in('operator', ['airtel', 'orange', 'afrimoney'])
        .in('status', ['success', 'failed', 'processing'])
        .gte('created_at', since);

      if (error) {
        fastify.log.error({ err: error }, '[status/operators] query failed');
        return { operators: [], generated_at: new Date().toISOString() };
      }

      const rows = (data as DbRow[] | null) ?? [];

      // Group by operator
      const byOperator: Record<string, DbRow[]> = {};
      for (const row of rows) {
        if (!byOperator[row.operator]) byOperator[row.operator] = [];
        byOperator[row.operator].push(row);
      }

      const operators: OperatorRow[] = [];

      for (const op of ['airtel', 'orange', 'afrimoney']) {
        const opRows = byOperator[op] ?? [];

        let successCount = 0;
        let failedCount = 0;
        let processingCount = 0;
        let providerOutageCount = 0;
        let lastIncidentAt: string | null = null;

        for (const row of opRows) {
          if (row.status === 'success') {
            successCount++;
          } else if (row.status === 'failed') {
            failedCount++;
            if (isProviderOutageFailure(row.metadata)) {
              providerOutageCount++;
              if (!lastIncidentAt || row.created_at > lastIncidentAt) {
                lastIncidentAt = row.created_at;
              }
            }
          } else if (row.status === 'processing') {
            processingCount++;
          }
        }

        const totalAttempts = successCount + failedCount;
        const successRatePct = totalAttempts > 0
          ? Math.round((successCount / totalAttempts) * 1000) / 10
          : null;

        const status = computeOperatorStatus(
          totalAttempts,
          successCount,
          failedCount,
          providerOutageCount,
        );

        // Latency: compute from updated_at - created_at for successful
        // transactions only (failed ones may resolve quickly or slowly
        // for unrelated reasons). Not all transactions have updated_at
        // populated meaningfully, so we report null if no data.
        let avgLatencyMs: number | null = null;
        const latencies: number[] = [];
        for (const row of opRows) {
          if (row.status === 'success' && row.updated_at && row.created_at) {
            const latency = new Date(row.updated_at).getTime() - new Date(row.created_at).getTime();
            if (latency > 0 && latency < 60 * 60 * 1000) {
              latencies.push(latency);
            }
          }
        }
        if (latencies.length > 0) {
          avgLatencyMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
        }

        operators.push({
          operator: op,
          status,
          success_rate_pct: successRatePct,
          total_attempts_24h: totalAttempts,
          success_count: successCount,
          failed_count: failedCount,
          processing_count: processingCount,
          provider_outage_failures_24h: providerOutageCount,
          avg_latency_ms: avgLatencyMs,
          last_incident_at: lastIncidentAt,
        });
      }

      return {
        operators: operators.map((o) => ({
          ...o,
          name: OPERATOR_NAMES[o.operator] ?? o.operator,
        })),
        generated_at: new Date().toISOString(),
      };
    },
  );
};

export default statusRoute;
