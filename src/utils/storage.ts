export async function fetchImageAsBase64(supabaseUrl: string): Promise<string> {
  const res = await fetch(supabaseUrl);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
