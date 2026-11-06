"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSandboxAllowed = isSandboxAllowed;
function isSandboxAllowed(nodeEnv, requestedMode) {
    return nodeEnv !== 'production' && requestedMode === 'sandbox';
}
//# sourceMappingURL=sandbox-mode.js.map