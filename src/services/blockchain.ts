import crypto from 'node:crypto';
import { ethers } from 'ethers';

const CGLT_ABI = [
  'function mint(address to, uint256 amount, string txRef) external',
  'function burn(address from, uint256 amount, string txRef) external',
  'function balanceOf(address) view returns (uint256)',
];

function getCgltContract() {
  const nodeUrl = process.env.CGLT_NODE_URL;
  const minterKey = process.env.CGLT_MINTER_KEY;
  const contractAddress = process.env.CGLT_CONTRACT_ADDRESS;

  if (!nodeUrl || !minterKey || !contractAddress) {
    throw new Error('CGLT blockchain service is not configured');
  }

  const provider = new ethers.JsonRpcProvider(nodeUrl);
  const signer = new ethers.Wallet(minterKey, provider);
  return new ethers.Contract(contractAddress, CGLT_ABI, signer);
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
