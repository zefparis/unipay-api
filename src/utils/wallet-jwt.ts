import crypto from 'node:crypto';

export interface WalletJwtPayload {
  wallet_id: string;
  phone: string;
  role: 'wallet';
  token_version: number;
  iat: number;
  exp: number;
}

export function signWalletToken(
  payload: Omit<WalletJwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresInSeconds = 86_400,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyWalletToken(token: string, secret: string): WalletJwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (
      sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
    ) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as WalletJwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.role !== 'wallet') return null;
    // Pre-migration tokens (without token_version claim) are treated
    // as version 0 for backward compatibility.
    if (payload.token_version === undefined) payload.token_version = 0;
    return payload;
  } catch {
    return null;
  }
}

export function requireWallet(
  auth: string | undefined,
  secret: string,
): WalletJwtPayload | null {
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyWalletToken(auth.slice(7), secret);
}

export interface RefreshTokenPayload {
  wallet_id: string;
  role: 'wallet_refresh';
  token_version: number;
  iat: number;
  exp: number;
}

export function signRefreshToken(
  payload: { wallet_id: string; token_version: number },
  secret: string,
  expiresInSeconds = 2_592_000,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      role: 'wallet_refresh',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyRefreshToken(token: string, secret: string): RefreshTokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (
      sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
    ) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as RefreshTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.role !== 'wallet_refresh') return null;
    // Pre-migration tokens (without token_version claim) are treated
    // as version 0 for backward compatibility.
    if (payload.token_version === undefined) payload.token_version = 0;
    return payload;
  } catch {
    return null;
  }
}
