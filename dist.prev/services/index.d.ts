import * as vodacash from './vodacash';
import type { Channel } from '../types/payment';
type ProviderService = typeof vodacash;
export declare function getProviderService(channel: Channel): ProviderService;
export {};
