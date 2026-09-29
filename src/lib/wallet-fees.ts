import { env } from '../config/env';

/**
 * Wallet (grand public) fee rate — deposit and withdraw.
 * Single source of truth: env WALLET_FEE_RATE, default 0.05 = 5%.
 * The Avada/Unipesa provider cost (3%) is internal-only and must
 * never appear in user-facing output.
 */
export const WALLET_FEE_RATE = Number(env.WALLET_FEE_RATE);

export function walletFee(amount: number): number {
  return Math.round(amount * WALLET_FEE_RATE * 100) / 100;
}
