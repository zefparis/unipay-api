/**
 * CGLT Bridge API client.
 *
 * Handles minting wCGLT on BSC via the bridge server.
 * All BSC signing is done server-side by the bridge — this service
 * only sends authenticated HTTP requests.
 */

const CGLT_PER_WCGLT = 500;

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

  const res = await fetch(`${bridgeUrl}/bridge/mint`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ to: bscAddress, amount: wcgltAmount }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge error ${res.status}: ${text}`);
  }

  const data = await res.json() as { success: boolean; hash?: string; error?: string };
  if (!data.success) throw new Error(data.error ?? 'bridge_failed');
  return data.hash ?? '';
}
