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
export declare function isProviderOutageFailure(metadata: Record<string, unknown> | null): boolean;
