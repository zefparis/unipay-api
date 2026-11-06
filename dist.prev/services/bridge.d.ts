/**
 * CGLT Bridge API client.
 *
 * Handles minting wCGLT on BSC via the bridge server.
 * All BSC signing is done server-side by the bridge — this service
 * only sends authenticated HTTP requests.
 */
export declare class BridgeOutcomeUnknownError extends Error {
    readonly operationId: string;
    constructor(operationId: string, cause?: unknown);
}
/**
 * Mints wCGLT on BSC to the given address.
 *
 * @param bscAddress  Recipient BSC address (0x...)
 * @param amountCGLT  Amount in CGLT (converted to wCGLT internally: amountCGLT / 500)
 * @returns           BSC transaction hash
 */
export declare function mintWCGLT(bscAddress: string, amountCGLT: number, operationId: string): Promise<string>;
