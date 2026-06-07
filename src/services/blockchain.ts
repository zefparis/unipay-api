import crypto from 'node:crypto';
import { ethers } from 'ethers';

const CGLT_ABI = [
  'function mint(address to, uint256 amount, string txRef) external',
  'function burn(address from, uint256 amount, string txRef) external',
  'function balanceOf(address) view returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const RESERVE_ABI = [
  'function cgltPerUsdt() view returns (uint256)',
  'function feePercent() view returns (uint256)',
  'function paused() view returns (bool)',
  'function swapCGLTtoUSDT(uint256 cgltAmount) external',
  'function swapUSDTtoCGLT(uint256 usdtAmount6) external',
];

function getProvider() {
  const nodeUrl = process.env.CGLT_NODE_URL;
  if (!nodeUrl) {
    throw new Error('CGLT_NODE_URL is not configured');
  }
  return new ethers.JsonRpcProvider(nodeUrl);
}

function getSigner() {
  const minterKey = process.env.CGLT_MINTER_KEY;
  if (!minterKey) {
    throw new Error('CGLT_MINTER_KEY is not configured');
  }
  return new ethers.Wallet(minterKey, getProvider());
}

function getCgltContract() {
  const contractAddress = process.env.CGLT_CONTRACT_ADDRESS;
  if (!contractAddress) {
    throw new Error('CGLT_CONTRACT_ADDRESS is not configured');
  }
  return new ethers.Contract(contractAddress, CGLT_ABI, getSigner());
}

function getReserveAddress() {
  const reserveAddress = process.env.CGLT_RESERVE_ADDRESS;
  if (!reserveAddress) {
    throw new Error('CGLT_RESERVE_ADDRESS is not configured');
  }
  return reserveAddress;
}

export function encryptPrivateKey(privateKey: string): string {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be a 32 bytes hex string');
  }

  const iv = crypto.randomBytes(12);
  const key = Buffer.from(encryptionKey, 'hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export async function mintCGLT(
  walletAddress: string,
  amountCDF: number,
  txRef: string,
): Promise<string> {
  const amount = ethers.parseUnits(amountCDF.toString(), 18);
  const cgltContract = getCgltContract();
  const tx = await cgltContract.mint(walletAddress, amount, txRef);
  await tx.wait();
  console.log(`[blockchain] Minted ${amountCDF} CGLT to ${walletAddress}`);
  return tx.hash;
}

export async function burnCGLT(
  walletAddress: string,
  amountCDF: number,
  txRef: string,
): Promise<string> {
  const amount = ethers.parseUnits(amountCDF.toString(), 18);
  const cgltContract = getCgltContract();
  const tx = await cgltContract.burn(walletAddress, amount, txRef);
  await tx.wait();
  console.log(`[blockchain] Burned ${amountCDF} CGLT from ${walletAddress}`);
  return tx.hash;
}

export async function getCGLTBalance(walletAddress: string): Promise<number> {
  const cgltContract = getCgltContract();
  const balance = await cgltContract.balanceOf(walletAddress);
  return Number(ethers.formatUnits(balance, 18));
}

export function generateWallet(): { address: string; privateKey: string } {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

export interface SwapRate {
  rate: number;
  fee: number;
  paused: boolean;
}

export async function getSwapRate(): Promise<SwapRate> {
  const reserve = new ethers.Contract(getReserveAddress(), RESERVE_ABI, getProvider());
  const [rate, feePercent, paused] = await Promise.all([
    reserve.cgltPerUsdt(),
    reserve.feePercent(),
    reserve.paused(),
  ]);
  return {
    rate: Number(rate),
    fee: Number(feePercent) / 100, // basis points -> percent (50 -> 0.5)
    paused: Boolean(paused),
  };
}

export type SwapDirection = 'cglt_to_usdt' | 'usdt_to_cglt';

export interface SwapResult {
  amountIn: number;
  amountOut: number;
  fee: number;
  txHash: string;
}

async function ensureAllowance(
  tokenAddress: string,
  signer: ethers.Wallet,
  spender: string,
  required: bigint,
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const current: bigint = await token.allowance(signer.address, spender);
  if (current < required) {
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
  }
}

export async function executeSwap(
  direction: SwapDirection,
  amount: number,
): Promise<SwapResult> {
  const signer = getSigner();
  const reserveAddress = getReserveAddress();
  const reserve = new ethers.Contract(reserveAddress, RESERVE_ABI, signer);

  const [rateRaw, feePercentRaw] = await Promise.all([
    reserve.cgltPerUsdt(),
    reserve.feePercent(),
  ]);
  const rate = Number(rateRaw);
  const feeRatio = Number(feePercentRaw) / 10000; // 50 -> 0.005

  if (direction === 'cglt_to_usdt') {
    const cgltWei = ethers.parseUnits(amount.toString(), 18);
    await ensureAllowance(process.env.CGLT_CONTRACT_ADDRESS as string, signer, reserveAddress, cgltWei);
    const tx = await reserve.swapCGLTtoUSDT(cgltWei);
    const receipt = await tx.wait();
    const gross = amount / rate;
    const fee = gross * feeRatio;
    return { amountIn: amount, amountOut: gross - fee, fee, txHash: receipt.hash };
  }

  // usdt_to_cglt
  const usdt6 = ethers.parseUnits(amount.toString(), 6);
  await ensureAllowance(process.env.USDT_ADDRESS as string, signer, reserveAddress, usdt6);
  const tx = await reserve.swapUSDTtoCGLT(usdt6);
  const receipt = await tx.wait();
  const feeUsdt = amount * feeRatio;
  const netUsdt = amount - feeUsdt;
  return { amountIn: amount, amountOut: netUsdt * rate, fee: feeUsdt, txHash: receipt.hash };
}
