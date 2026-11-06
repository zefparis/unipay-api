export declare function loginEmailAllowed(email: string, max?: number, windowMs?: number): boolean;
/** Test-only : purge périodique des entrées anciennes. */
export declare function pruneEmailBuckets(now?: number): void;
/** Test-only : réinitialiser les compteurs. */
export declare function resetEmailLimiter(): void;
