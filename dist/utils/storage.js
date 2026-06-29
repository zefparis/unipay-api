"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchImageAsBase64 = fetchImageAsBase64;
async function fetchImageAsBase64(supabaseUrl) {
    const res = await fetch(supabaseUrl);
    if (!res.ok)
        throw new Error(`Image fetch failed: ${res.status}`);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
}
//# sourceMappingURL=storage.js.map