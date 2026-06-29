/**
 * BSC settlement wallet gas monitor.
 *
 * Checks BNB balance every hour. When below threshold, logs an alert
 * and sends a notification email to the admin team via Brevo.
 */
export declare function startGasMonitor(logger: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
}): void;
