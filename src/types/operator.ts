export type OperatorStatus = 'active' | 'suspended' | 'pending';

export interface Operator {
  id: string;
  name: string;
  email: string;
  balance_usd: number;
  status: OperatorStatus;
  webhook_url: string | null;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  merchant_id: string;
  key_prefix: string;
  key_hash: string;
  label: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiKeyWithOperator extends ApiKey {
  merchants: Pick<Operator, 'id' | 'name' | 'email' | 'status' | 'webhook_url'>;
}
