/**
 * MSISDN normalization for Unipesa (api.unipesa.tech) — DRC (country=CD).
 *
 * Per Unipesa documentation (docs.unipesa.tech), the customer_id format
 * differs by operator for country=CD:
 *
 *   Orange    (provider_id=10) : must start with 0  → "0800000000"
 *   Airtel    (provider_id=17) : must NOT start with 0 → "999000000"
 *   Afrimoney (provider_id=19) : must start with 0  → "0900000000"
 *
 * Accepted input formats (all produce the same 9-digit local number):
 *   +243XXXXXXXXX   (E.164 with +)
 *   243XXXXXXXXX    (E.164 without +)
 *   0XXXXXXXXX      (local with leading 0)
 *   XXXXXXXXX       (9 digits, bare local)
 *
 * The function extracts the 9 significant digits, then prefixes
 * according to the operator. Throws if the input does not contain
 * exactly 9 significant digits.
 */
export type UnipesaOperator = 'orange' | 'airtel' | 'afrimoney' | 'africell';
/**
 * Normalize any international phone number to E.164 (e.g. "+33612345678").
 *
 * Primary path: libphonenumber-js strict parse — the input must carry a "+"
 * country prefix (no default-country guessing: a bare "0612…" is ambiguous).
 * Fallback: the DRC-specific extractor, which rescues defensive cases such as
 * "+243243997174834" or "0243997174834" that strict parsing rejects.
 *
 * Returns null when no valid number can be derived.
 */
export declare function normalizeToE164(phone: string): string | null;
/**
 * Extract the 9 significant local digits from any common DRC phone format.
 * Returns null if the input does not contain exactly 9 digits after
 * stripping the country code / leading zero.
 */
export declare function extractLocalDigits(phone: string): string | null;
/**
 * Normalize a phone number to the MSISDN format expected by Unipesa
 * for the given operator.
 *
 * @param phone    Input phone in any common DRC format
 * @param operator 'orange' | 'airtel' | 'afrimoney'
 * @returns Normalized MSISDN string
 * @throws {Error} if the phone does not contain exactly 9 significant digits
 */
export declare function normalizePhoneForOperator(phone: string, operator: UnipesaOperator): string;
/**
 * Validate that a phone number contains exactly 9 significant digits.
 * Returns true if valid, false otherwise. Does not throw.
 */
export declare function isValidDrcPhone(phone: string): boolean;
/**
 * Detect the likely operator from a DRC phone number's prefix.
 * Returns the operator slug ('airtel' | 'orange' | 'afrimoney') or null
 * if the prefix is unknown.
 */
export declare function detectOperatorFromPhone(phone: string): string | null;
/**
 * Validate that a phone number's prefix matches the selected operator.
 * Returns { ok: true } if the prefix matches, or
 * { ok: false, detected: '<operator>', message: '...' } if mismatched.
 */
export declare function validatePhoneOperatorMatch(phone: string, operator: string): {
    ok: true;
} | {
    ok: false;
    detected: string | null;
    message: string;
};
