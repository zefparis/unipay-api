/**
 * BSC settlement wallet gas monitor.
 *
 * Checks BNB balance every hour. When below threshold, logs an alert
 * and sends a notification email to the admin team via Brevo.
 */

import { ethers } from 'ethers';
import { env } from '../config/env';
import { sendGasAlertEmail } from './email';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BNB_ALERT_THRESHOLD = 0.005;        // alert when < 0.005 BNB

/* ── Provider / address helpers ─────────────────────────────────────────── */

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(env.BSC_RPC_URL);
}

function getHotWalletAddress(): string {
  const key = env.BSC_OWNER_KEY;
  if (!key) throw new Error('BSC_OWNER_KEY not configured');
  return new ethers.Wallet(key).address;
}

/* ── Start monitoring loop ──────────────────────────────────────────────── */

export function startGasMonitor(
  logger: { info: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void; error: (msg: string, data?: unknown) => void },
): void {
  if (!env.BSC_OWNER_KEY) {
    logger.info('[gas-monitor] BSC_OWNER_KEY not set — gas monitor disabled');
    return;
  }

  const address = getHotWalletAddress();
  logger.info(`[gas-monitor] Monitoring BSC gas for ${address} (threshold: ${BNB_ALERT_THRESHOLD} BNB, interval: 1h)`);

  const tick = async () => {
    try {
      const provider = getProvider();
      const balanceWei = await provider.getBalance(address);
      const balanceBnb = Number(ethers.formatEther(balanceWei));

      if (balanceBnb < BNB_ALERT_THRESHOLD) {
        logger.warn(`[ALERT] Settlement wallet low on gas: ${balanceBnb} BNB`);

        // Send alert email to admin (fire-and-forget)
        const adminEmails = env.ADMIN_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
        sendGasAlertEmail(address, balanceBnb, BNB_ALERT_THRESHOLD, adminEmails).catch((err) => {
          logger.error('[gas-monitor] Alert email failed', err);
        });
      } else {
        logger.info(`[gas-monitor] BSC gas OK: ${balanceBnb.toFixed(6)} BNB`);
      }
    } catch (err) {
      logger.error('[gas-monitor] Balance check failed', err);
    }
  };

  // Run immediately on startup, then every hour
  tick().catch((err) => logger.error('[gas-monitor] first tick failed', err));
  setInterval(() => {
    tick().catch((err) => logger.error('[gas-monitor] tick failed', err));
  }, POLL_INTERVAL_MS);
}
