/**
 * CGLT configuration validator — runs at startup.
 *
 * Checks blockchain configuration without revealing secrets.
 * If validation fails, forces CGLT_BLOCKCHAIN_MODE=disabled at runtime.
 * Does NOT stop the server — fiat/mobile money functions remain available.
 */
import { type CgltBlockchainMode } from './cglt-blockchain-mode';
export interface CgltConfigValidation {
    mode: CgltBlockchainMode;
    chain_id_expected: number;
    chain_id_actual: number | null;
    rpc_reachable: boolean;
    cglt_contract_configured: boolean;
    cglt_contract_has_code: boolean;
    wcglt_contract_configured: boolean;
    wcglt_contract_has_code: boolean;
    bridge_reachable: boolean;
    bridge_endpoint_compatible: boolean;
    configuration_valid: boolean;
    errors: string[];
}
export declare function getLastCgltConfigValidation(): CgltConfigValidation | null;
/**
 * Validates CGLT blockchain configuration at startup.
 * Does NOT throw — logs errors and forces disabled mode on failure.
 */
export declare function validateCgltConfig(log?: {
    info: (msg: object, fmt?: string) => void;
    error: (msg: object, fmt?: string) => void;
    warn: (msg: object, fmt?: string) => void;
}): Promise<CgltConfigValidation>;
