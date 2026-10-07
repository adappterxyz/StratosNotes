import devnet from '../../deployments/devnet.json';
import solanaTokens from '../../deployments/solana-tokens.json';
import sepoliaTokens from '../../deployments/sepolia-tokens.json';

/** Cluster and deployed addresses (deployments/devnet.json, written by packages/flow/scripts/devnet.ts). */
export const CLUSTER = 'devnet';
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'https://api.devnet.solana.com';
export const DEPLOYMENT = devnet as {
  engine: string; testUsdc: string; config: string; forwarders: string[];
  ccip?: { router: string; inbox: string; sender: string; lookupTable?: string };
};
export const explorer = (kind: 'address' | 'tx', id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=${CLUSTER}`;

/**
 * Cross-chain test tokens (CCIP burn-mint, Solana devnet <-> Ethereum Sepolia):
 * tUSD is the cash; tETH, tBTC and tSOL are delivered by physically settled notes.
 */
export type TokenSymbol = 'tUSD' | 'tETH' | 'tBTC' | 'tSOL';
type SolanaToken = { mint: string; decimals: number; lookupTable: string };
type SepoliaToken = { token: string; pool: string; decimals: number };
export const TOKENS = Object.fromEntries((['tUSD', 'tETH', 'tBTC', 'tSOL'] as TokenSymbol[]).map(s => [s, {
  symbol: s,
  solana: (solanaTokens as unknown as Record<string, SolanaToken>)[s],
  sepolia: (sepoliaTokens as unknown as Record<string, SepoliaToken>)[s],
}])) as Record<TokenSymbol, { symbol: TokenSymbol; solana: SolanaToken; sepolia: SepoliaToken }>;
export const tokenByMint = (mint: string) => Object.values(TOKENS).find(t => t.solana.mint === mint);

/** Ethereum Sepolia: the CCIP router, the chain selectors and the test-token faucet. */
export const SEPOLIA = {
  chainId: 11155111,
  chainIdHex: '0xaa36a7',
  rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  explorer: 'https://sepolia.etherscan.io',
  router: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59' as `0x${string}`,
  selector: 16015286601757825753n,
  solanaSelector: 16423721717087811551n,
  faucet: (sepoliaTokens as unknown as { faucet: `0x${string}` }).faucet,
};
export const ccipExplorer = (messageId: string) => `https://ccip.chain.link/msg/${messageId}`;
