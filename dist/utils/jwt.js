"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signToken = signToken;
exports.verifyToken = verifyToken;
const node_crypto_1 = __importDefault(require("node:crypto"));
function signToken(payload, secret, expiresInSeconds = 86_400) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })).toString('base64url');
    const sig = node_crypto_1.default.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}
function verifyToken(token, secret) {
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
        return payload;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=jwt.js.map