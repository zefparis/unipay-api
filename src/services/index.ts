import * as vodacash from './vodacash';
import * as orange from './orange';
import * as airtel from './airtel';
import * as afrimoney from './afrimoney';
import * as cryptoService from './crypto';
import type { Channel } from '../types/payment';

type ProviderService = typeof vodacash;

const registry: Record<Channel, ProviderService> = {
  vodacash,
  orange,
  airtel,
  afrimoney,
  usdt: cryptoService,
};

export function getProviderService(channel: Channel): ProviderService {
  return registry[channel];
}
