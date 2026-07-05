const PAYGUARD_API = 'https://hybrid-vector-api-m5xt.onrender.com';
const PAYGUARD_API_KEY = process.env.PAYGUARD_API_KEY!;
const PAYGUARD_TENANT = 'unipay-congo';

export interface CognitiveBaseline {
  reflex_ms: number;
  stroop_accuracy: number;
  stroop_hits: number;
  stroop_rounds: number;
  digit_span_score: number;
  vocal_embedding: number[];
  vocal_quality: number;
}

export async function enrollPayGuard(params: {
  selfie_b64: string;
  first_name: string;
  last_name: string;
  cognitive_baseline?: CognitiveBaseline;
}): Promise<{ student_id: string; confidence: number }> {
  const cognitive = params.cognitive_baseline ?? {
    reflex_ms: 0,
    stroop_accuracy: 0,
    stroop_hits: 0,
    stroop_rounds: 0,
    digit_span_score: 0,
    vocal_embedding: [],
    vocal_quality: 0,
  };

  const res = await fetch(`${PAYGUARD_API}/payguard/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': PAYGUARD_API_KEY,
      Origin: 'https://unipay-api.onrender.com',
    },
    body: JSON.stringify({
      selfie_b64: params.selfie_b64,
      first_name: params.first_name,
      last_name: params.last_name,
      tenant_id: PAYGUARD_TENANT,
      cognitive_baseline: cognitive,
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
