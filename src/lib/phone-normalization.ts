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
 * Extract the 9 significant local digits from any common DRC phone format.
 * Returns null if the input does not contain exactly 9 digits after
 * stripping the country code / leading zero.
 */
export function extractLocalDigits(phone: string): string | null {
  // Remove all whitespace, dashes, dots, parentheses
  let p = phone.replace(/[\s\-().]/g, '');

  // Remove leading +
  p = p.replace(/^\+/, '');

  // Remove country code 243 (if present at start)
  if (p.startsWith('243')) {
    p = p.slice(3);
  }

  // Remove leading 0 (local prefix)
  if (p.startsWith('0')) {
    p = p.slice(1);
  }

  // At this point p should be exactly 9 digits
  if (!/^\d{9}$/.test(p)) {
    return null;
  }

  return p;
}

/**
 * Normalize a phone number to the MSISDN format expected by Unipesa
 * for the given operator.
 *
 * @param phone    Input phone in any common DRC format
 * @param operator 'orange' | 'airtel' | 'afrimoney'
 * @returns Normalized MSISDN string
 * @throws {Error} if the phone does not contain exactly 9 significant digits
 */
export function normalizePhoneForOperator(
  phone: string,
  operator: UnipesaOperator,
): string {
  const local9 = extractLocalDigits(phone);
  if (!local9) {
    throw new Error(
      `Invalid phone number: expected 9 significant digits after stripping country code, got "${phone}"`,
    );
  }

  const op = operator.toLowerCase();
  switch (op) {
    case 'orange':
    case 'afrimoney':
    case 'africell':
      // Orange and Afrimoney/Africell: must start with 0
      return '0' + local9;
    case 'airtel':
      // Airtel: must NOT start with 0 — bare 9 digits
      return local9;
    default:
      throw new Error(`Unsupported operator for phone normalization: ${operator}`);
  }
}

/**
 * Validate that a phone number contains exactly 9 significant digits.
 * Returns true if valid, false otherwise. Does not throw.
 */
export function isValidDrcPhone(phone: string): boolean {
  return extractLocalDigits(phone) !== null;
}

/**
 * DRC mobile operator prefix map (first 2 digits of the 9-digit local number).
 *
 * Source: ARPTC numbering plan + cross-referenced with test fixtures.
 *   81, 82, 85, 90 → Vodacom (Afrimoney)
 *   84, 88, 89     → Orange
 *   97, 98, 99     → Airtel
 */
const OPERATOR_PREFIXES: Record<string, string[]> = {
  airtel:   ['97', '98', '99'],
  orange:   ['84', '88', '89'],
  afrimoney: ['81', '82', '85', '90'],
};

/**
 * Detect the likely operator from a DRC phone number's prefix.
 * Returns the operator slug ('airtel' | 'orange' | 'afrimoney') or null
 * if the prefix is unknown.
 */
export function detectOperatorFromPhone(phone: string): string | null {
  const local9 = extractLocalDigits(phone);
  if (!local9) return null;
  const prefix2 = local9.slice(0, 2);
  for (const [op, prefixes] of Object.entries(OPERATOR_PREFIXES)) {
    if (prefixes.includes(prefix2)) return op;
  }
  return null;
}

/**
 * Validate that a phone number's prefix matches the selected operator.
 * Returns { ok: true } if the prefix matches, or
 * { ok: false, detected: '<operator>', message: '...' } if mismatched.
 */
export function validatePhoneOperatorMatch(
  phone: string,
  operator: string,
): { ok: true } | { ok: false; detected: string | null; message: string } {
  const detected = detectOperatorFromPhone(phone);
  if (!detected) {
    return { ok: true }; // Unknown prefix — don't block
  }
  if (detected === operator.toLowerCase()) {
    return { ok: true };
  }
  return {
    ok: false,
    detected,
    message: `Le numéro ${phone} appartient à l'opérateur ${detected}, mais le retrait est demandé vers ${operator}. L'opérateur de destination rejetera ce numéro (MSISDN INCORRECT).`,
  };
}
