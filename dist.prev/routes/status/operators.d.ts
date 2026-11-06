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
declare const statusRoute: FastifyPluginAsync;
export default statusRoute;
