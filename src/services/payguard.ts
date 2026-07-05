const PAYGUARD_API = 'https://hybrid-vector-api-m5xt.onrender.com';
const PAYGUARD_API_KEY = process.env.PAYGUARD_API_KEY!;
const PAYGUARD_TENANT = 'unipay-congo';

export async function enrollPayGuard(params: {
  selfie_b64: string;
  first_name: string;
  last_name: string;
}): Promise<{ student_id: string; confidence: number }> {
  const res = await fetch(`${PAYGUARD_API}/payguard/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': PAYGUARD_API_KEY,
      Origin: 'https://unipay-api.onrender.com',
    },
    body: JSON.stringify({
      ...params,
      tenant_id: PAYGUARD_TENANT,
      cognitive_baseline: {
        vocal_embedding: [],
        vocal_quality: 1,
        digit_span_score: 0.8,
        stroop_accuracy: 0.8,
        reflex_ms: 300,
      },
    }),
  });
  if (!res.ok) throw new Error(`PayGuard enroll failed: ${res.status}`);
  return res.json() as Promise<{ student_id: string; confidence: number }>;
}

export async function verifyPayGuard(params: {
  selfie_b64: string;
  first_name: string;
  last_name: string;
  student_id: string;
}): Promise<{ verified: boolean; similarity: number }> {
  const res = await fetch(`${PAYGUARD_API}/payguard/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': PAYGUARD_API_KEY,
      Origin: 'https://unipay-api.onrender.com',
    },
    body: JSON.stringify({
      ...params,
      tenant_id: PAYGUARD_TENANT,
    }),
  });
  if (!res.ok) throw new Error(`PayGuard verify failed: ${res.status}`);
  return res.json() as Promise<{ verified: boolean; similarity: number }>;
}
