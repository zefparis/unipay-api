/**
 * CGLT Bridge API client.
 *
 * Handles minting wCGLT on BSC via the bridge server.
 * All BSC signing is done server-side by the bridge — this service
 * only sends authenticated HTTP requests.
 */

const CGLT_PER_WCGLT   = 500;
const BRIDGE_TIMEOUT_MS = 8_000; // must be < upstreamFetch timeout (10s) + Vercel function timeout (10s)

/**
 * Mints wCGLT on BSC to the given address.
 *
 * @param bscAddress  Recipient BSC address (0x...)
 * @param amountCGLT  Amount in CGLT (converted to wCGLT internally: amountCGLT / 500)
 * @returns           BSC transaction hash
 */
export async function mintWCGLT(
  bscAddress: string,
  amountCGLT: number,
): Promise<string> {
  const bridgeUrl = process.env.BRIDGE_API_URL ?? 'http://104.248.166.144:3099';
  const key       = process.env.BRIDGE_API_KEY;
  if (!key) throw new Error('BRIDGE_API_KEY not set');

  const wcgltAmount = amountCGLT / CGLT_PER_WCGLT;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${bridgeUrl}/bridge/mint-wcglt`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body:   JSON.stringify({ to: bscAddress, amount: wcgltAmount }),
      signal: ctrl.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    throw new Error(isTimeout ? 'bridge_timeout' : `bridge_unreachable: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge error ${res.status}: ${text}`);
  }

  const data = await res.json() as { success: boolean; hash?: string; error?: string };
  if (!data.success) throw new Error(data.error ?? 'bridge_failed');
  return data.hash ?? '';
}
