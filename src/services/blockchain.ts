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

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WCGLT_BSC     = '0xfE4Ce029A1CB84Aa0D3906C7eC409f1496d13A3B';
const USDT_BSC      = '0x55d398326f99059fF775485246999027B3197955';
const WBNB          = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const PANCAKE_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
];

const RESERVE_ABI = [
  'function cgltPerUsdt() view returns (uint256)',
  'function feePercent() view returns (uint256)',
  'function paused() view returns (bool)',
  'function swapCGLTtoUSDT(uint256 cgltAmount) external',
  'function swapUSDTtoCGLT(uint256 usdtAmount6) external',
];

function getBscProvider() {
  return new ethers.JsonRpcProvider(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org');
}

function getBscSigner() {
  const key = process.env.BSC_OWNER_KEY;
  if (!key) throw new Error('BSC_OWNER_KEY not configured');
  return new ethers.Wallet(key, getBscProvider());
}

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

export async function mintWCGLTonBSC(
  bscAddress: string,
  amount: number,
): Promise<string> {
  const bridgeUrl = process.env.BRIDGE_API_URL ?? 'http://104.248.166.144:3099';
  const res = await fetch(`${bridgeUrl}/bridge/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: bscAddress, amount }),
  });
  const data = await res.json() as { success?: boolean; hash?: string; error?: string };
  if (!data.success) throw new Error(data.error ?? 'bridge_failed');
  return data.hash ?? '';
}

export async function swapWCGLTtoUSDT(
  wcgltAmount: number,
  recipientAddress: string,
): Promise<{ usdtReceived: number; txHash: string }> {
  const signer    = getBscSigner();
  const wcgltWei  = ethers.parseEther(wcgltAmount.toString());

  const wcglt     = new ethers.Contract(WCGLT_BSC, ERC20_ABI, signer);
  const allowance: bigint = await wcglt.allowance(signer.address, PANCAKE_ROUTER);
  if (allowance < wcgltWei) {
    const approveTx = await wcglt.approve(PANCAKE_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
  }

  const router    = new ethers.Contract(PANCAKE_ROUTER, PANCAKE_ABI, signer);
  const path      = [WCGLT_BSC, WBNB, USDT_BSC];
  const amounts: bigint[] = await router.getAmountsOut(wcgltWei, path);
  const expectedUsdt = amounts[2];
  const amountOutMin = expectedUsdt * 95n / 100n;

  const deadline = Math.floor(Date.now() / 1000) + 300;
  const tx = await router.swapExactTokensForTokens(
    wcgltWei,
    amountOutMin,
    path,
    recipientAddress,
    deadline,
  );
  const receipt = await tx.wait();

  const usdtReceived = Number(ethers.formatUnits(expectedUsdt, 18));
  return { usdtReceived, txHash: receipt.hash };
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
