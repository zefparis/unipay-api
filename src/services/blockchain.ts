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
  const tx = await cgltContract.mint(walletAddress, amount, txRef, {
    gasPrice: ethers.parseUnits("1", "gwei"),
    gasLimit: 200000n
  });
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
  const tx = await cgltContract.burn(walletAddress, amount, txRef, {
    gasPrice: ethers.parseUnits("1", "gwei"),
    gasLimit: 200000n
  });
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
  /** Reserve (AMM pool) balances held by the reserve contract. */
  pool_usdt: number;
  pool_cglt: number;
}

export async function getSwapRate(): Promise<SwapRate> {
  const provider = getProvider();
  const reserveAddress = getReserveAddress();
  const reserve = new ethers.Contract(reserveAddress, RESERVE_ABI, provider);

  const [rate, feePercent, paused] = await Promise.all([
    reserve.cgltPerUsdt(),
    reserve.feePercent(),
    reserve.paused(),
  ]);

  // Best-effort: read the pool balances held by the reserve contract.
  // USDT uses 6 decimals, CGLT uses 18.
  let poolUsdt = 0;
  let poolCglt = 0;
  try {
    const usdtAddress = process.env.USDT_ADDRESS;
    const cgltAddress = process.env.CGLT_CONTRACT_ADDRESS;
    if (usdtAddress) {
      const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, provider);
      poolUsdt = Number(ethers.formatUnits(await usdt.balanceOf(reserveAddress), 6));
    }
    if (cgltAddress) {
      const cglt = new ethers.Contract(cgltAddress, ERC20_ABI, provider);
      poolCglt = Number(ethers.formatUnits(await cglt.balanceOf(reserveAddress), 18));
    }
  } catch {
    /* pool balances are best-effort; keep zeros on failure */
  }

  return {
    rate: Number(rate),
    fee: Number(feePercent) / 100, // basis points -> percent (50 -> 0.5)
    paused: Boolean(paused),
    pool_usdt: poolUsdt,
    pool_cglt: poolCglt,
  };
}


