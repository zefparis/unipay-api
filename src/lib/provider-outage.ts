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
 * callback handler. After M6, the callback stores the provider payload under
 * metadata.provider_payload (merged structure). We check both the merged
 * structure (provider_payload) and the flat structure (for transactions
 * processed before the M6 migration or by manual reconciliation):
 *   - metadata.provider_payload.unipesa_result_code = 10301 | 10201  (callback, post-M6)
 *   - metadata.unipesa_result_code = 10301 | 10201                   (reconciliation / pre-M6)
 *   - metadata.provider_payload.result.code = 10301 | 10201          (callback, post-M6)
 *   - metadata.result.code = 10301 | 10201                           (callback, pre-M6)
 *   - metadata.reason matches "API unreachable" / "get token error" / "provider unavailable"
 */

const PROVIDER_OUTAGE_RESULT_CODES = new Set([10301, 10201]);

export function isProviderOutageFailure(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;

  // M6 merged structure: check provider_payload first
  const providerPayload = metadata['provider_payload'];
  if (providerPayload && typeof providerPayload === 'object') {
    const pp = providerPayload as Record<string, unknown>;
    // Reconciliation metadata: unipesa_result_code
    const unipesaCodePp = pp['unipesa_result_code'];
    if (typeof unipesaCodePp === 'number' && PROVIDER_OUTAGE_RESULT_CODES.has(unipesaCodePp)) {
      return true;
    }
    // Callback metadata: result.code
    const resultPp = pp['result'];
    if (resultPp && typeof resultPp === 'object') {
      const codePp = (resultPp as Record<string, unknown>)['code'];
      if (typeof codePp === 'number' && PROVIDER_OUTAGE_RESULT_CODES.has(codePp)) {
        return true;
      }
    }
    // Reason-based detection
    const reasonPp = pp['reason'];
    if (typeof reasonPp === 'string' && /API unreachable|get token error|provider.*unavailable/i.test(reasonPp)) {
      return true;
    }
  }

  // Flat structure (pre-M6 transactions or manual reconciliation)
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
