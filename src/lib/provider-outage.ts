/**
 * Provider-outage failure classification.
 *
 * Shared between:
 *   - GET /v1/status/operators (public operator health)
 *   - GET /v1/admin/merchants/:id/stats (per-merchant success/failure stats)
 *
 * A "provider outage" failure is one caused by the upstream provider being
 * unavailable (Airtel/Orange API unreachable, token error, etc.), as opposed
 * to a "client error" (insufficient balance, wrong MSISDN, etc.).
 *
 * Detection is based on metadata fields set by the reconciliation job and
 * callback handler:
 *   - metadata.unipesa_result_code = 10301 | 10201  (reconciliation)
 *   - metadata.result.code = 10301 | 10201           (callback)
 *   - metadata.reason matches "API unreachable" / "get token error" / "provider unavailable"
 */

const PROVIDER_OUTAGE_RESULT_CODES = new Set([10301, 10201]);

export function isProviderOutageFailure(metadata: Record<string, unknown> | null): boolean {
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
