import { env } from '../config/env';

/**
 * Partner commission helpers.
 *
 * PROVIDER_FEE_RATE is the provider cost rate (Unipesa/Avada), used by
 * the DB-side commission cap: commission = LEAST(rate * amount,
 * fee - amount * PROVIDER_FEE_RATE). Sourced from env, never hardcoded.
 */
export const PROVIDER_FEE_RATE = Number(env.AVADA_FEE_RATE);

export interface PartnerCommissionResult {
  status?: 'credited' | 'skipped_duplicate' | 'no_margin' | 'none' | 'error' | string;
  commission_id?: string;
  partner_merchant_id?: string;
  sub_merchant_id?: string;
  transaction_id?: string;
  amount?: number;
  currency?: string;
  rate?: number;
  reason?: string;
  message?: string;
}

interface PartnerCommissionLogger {
  info: (data: unknown, message?: string) => void;
  warn: (data: unknown, message?: string) => void;
  error: (data: unknown, message?: string) => void;
}

/**
 * Emit the structured pino events for a partner_commission result
 * returned by process_wallet_provider_callback /
 * credit_partner_commission. Call from every RPC caller so the event
 * stream is uniform whether the resolution came from an inbound
 * callback, the reconciliation worker, or an admin backfill.
 *
 * Events:
 *   partner_commission_credited          (info)
 *   partner_commission_skipped_duplicate (info)
 *   partner_commission_skipped_no_margin (warn)
 *   partner_commission_error             (error — DB-side isolation
 *                                         means the tx still succeeded)
 * 'none' emits nothing (non-referred merchant traffic is the norm).
 */
export function logPartnerCommissionResult(
  log: PartnerCommissionLogger,
  result: PartnerCommissionResult | null | undefined,
  context: Record<string, unknown> = {},
): void {
  if (!result || !result.status) return;
  const base = { ...context, ...result };

  switch (result.status) {
    case 'credited':
      log.info({ event: 'partner_commission_credited', ...base }, 'partner commission credited');
      break;
    case 'skipped_duplicate':
      log.info({ event: 'partner_commission_skipped_duplicate', ...base }, 'partner commission already exists — skipped');
      break;
    case 'no_margin':
      log.warn({ event: 'partner_commission_skipped_no_margin', ...base }, 'partner commission skipped — capped margin <= 0');
      break;
    case 'error':
      log.error({ event: 'partner_commission_error', ...base }, 'partner commission computation failed (isolated — transaction unaffected)');
      break;
    default:
      break;
  }
}
