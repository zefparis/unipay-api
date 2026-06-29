"use strict";
/**
 * BSC settlement wallet gas monitor.
 *
 * Checks BNB balance every hour. When below threshold, logs an alert
 * and sends a notification email to the admin team via Brevo.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startGasMonitor = startGasMonitor;
const ethers_1 = require("ethers");
const env_1 = require("../config/env");
const email_1 = require("./email");
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BNB_ALERT_THRESHOLD = 0.005; // alert when < 0.005 BNB
/* ── Provider / address helpers ─────────────────────────────────────────── */
function getProvider() {
    return new ethers_1.ethers.JsonRpcProvider(env_1.env.BSC_RPC_URL);
}
function getHotWalletAddress() {
    const key = env_1.env.HOT_WALLET_USDT_PRIVATE_KEY;
    if (!key)
        throw new Error('HOT_WALLET_USDT_PRIVATE_KEY not configured');
    return new ethers_1.ethers.Wallet(key).address;
}
/* ── Start monitoring loop ──────────────────────────────────────────────── */
function startGasMonitor(logger) {
    if (!env_1.env.HOT_WALLET_USDT_PRIVATE_KEY) {
        logger.info('[gas-monitor] HOT_WALLET_USDT_PRIVATE_KEY not set — gas monitor disabled');
        return;
    }
    const address = getHotWalletAddress();
    logger.info(`[gas-monitor] Monitoring BSC gas for ${address} (threshold: ${BNB_ALERT_THRESHOLD} BNB, interval: 1h)`);
    const tick = async () => {
        try {
            const provider = getProvider();
            const balanceWei = await provider.getBalance(address);
            const balanceBnb = Number(ethers_1.ethers.formatEther(balanceWei));
            if (balanceBnb < BNB_ALERT_THRESHOLD) {
                logger.warn(`[ALERT] Settlement wallet low on gas: ${balanceBnb} BNB`);
                // Send alert email to admin (fire-and-forget)
                const adminEmails = env_1.env.ADMIN_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
                (0, email_1.sendGasAlertEmail)(address, balanceBnb, BNB_ALERT_THRESHOLD, adminEmails).catch((err) => {
                    logger.error('[gas-monitor] Alert email failed', err);
                });
            }
            else {
                logger.info(`[gas-monitor] BSC gas OK: ${balanceBnb.toFixed(6)} BNB`);
            }
        }
        catch (err) {
            logger.error('[gas-monitor] Balance check failed', err);
        }
    };
    // Run immediately on startup, then every hour
    tick().catch((err) => logger.error('[gas-monitor] first tick failed', err));
    setInterval(() => {
        tick().catch((err) => logger.error('[gas-monitor] tick failed', err));
    }, POLL_INTERVAL_MS);
}
//# sourceMappingURL=gas-monitor.js.map