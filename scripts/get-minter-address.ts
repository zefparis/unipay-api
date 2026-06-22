import { ethers } from 'ethers';

const key = process.env.CGLT_MINTER_KEY;
if (!key) {
  console.error('CGLT_MINTER_KEY not set');
  process.exit(1);
}
const wallet = new ethers.Wallet(key);
console.log('Minter BSC address:', wallet.address);
