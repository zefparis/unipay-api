"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signWalletToken = signWalletToken;
exports.verifyWalletToken = verifyWalletToken;
exports.requireWallet = requireWallet;
exports.signRefreshToken = signRefreshToken;
exports.verifyRefreshToken = verifyRefreshToken;
const node_crypto_1 = __importDefault(require("node:crypto"));
function signWalletToken(payload, secret, expiresInSeconds = 86_400) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })).toString('base64url');
    const sig = node_crypto_1.default.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}
function verifyWalletToken(token, secret) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return null;
        const [header, body, sig] = parts;
        const expectedSig = node_crypto_1.default
            .createHmac('sha256', secret)
            .update(`${header}.${body}`)
            .digest('base64url');
        if (sig.length !== expectedSig.length ||
            !node_crypto_1.default.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
            return null;
        }
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (payload.exp < Math.floor(Date.now() / 1000))
            return null;
        if (payload.role !== 'wallet')
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
function requireWallet(auth, secret) {
    if (!auth?.startsWith('Bearer '))
        return null;
    return verifyWalletToken(auth.slice(7), secret);
}
function signRefreshToken(payload, secret, expiresInSeconds = 2_592_000) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
        ...payload,
        role: 'wallet_refresh',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })).toString('base64url');
    const sig = node_crypto_1.default.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}
function verifyRefreshToken(token, secret) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return null;
        const [header, body, sig] = parts;
        const expectedSig = node_crypto_1.default
            .createHmac('sha256', secret)
            .update(`${header}.${body}`)
            .digest('base64url');
        if (sig.length !== expectedSig.length ||
            !node_crypto_1.default.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
            return null;
        }
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (payload.exp < Math.floor(Date.now() / 1000))
            return null;
        if (payload.role !== 'wallet_refresh')
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=wallet-jwt.js.map