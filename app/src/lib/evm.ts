/**
 * Ethereum Sepolia from the browser (MetaMask or any EIP-1193 wallet): the
 * test-token faucet, and CCIP sends to the engine on Solana (tokens plus a
 * payload, e.g. "subscribe 300 units").
 */
import { createPublicClient, createWalletClient, custom, erc20Abi, http, parseAbi, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA } from '../config';

declare global {
  interface Window { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }
}

const routerAbi = parseAbi([
  'struct EVMTokenAmount { address token; uint256 amount; }',
  'struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'function getFee(uint64 destinationChainSelector, EVM2AnyMessage message) view returns (uint256)',
  'function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)',
]);
const faucetAbi = parseAbi(['function drip(address token)', 'function lastDrip(address token, address account) view returns (uint256)']);

export const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA.rpc) });

export const hasEvmWallet = () => typeof window !== 'undefined' && !!window.ethereum;

/** Connect the EVM wallet and make sure it is on Sepolia. */
export async function connectSepolia(): Promise<Address> {
  if (!window.ethereum) throw new Error('No Ethereum wallet found. Install MetaMask (or another EVM wallet) to subscribe from Sepolia.');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' }) as Address[];
  const chain = await window.ethereum.request({ method: 'eth_chainId' }) as string;
  if (chain !== SEPOLIA.chainIdHex) {
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA.chainIdHex }] });
    } catch {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: SEPOLIA.chainIdHex, chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: [SEPOLIA.rpc], blockExplorerUrls: [SEPOLIA.explorer] }] });
    }
  }
  return account;
}

const wallet = (account: Address) => createWalletClient({ account, chain: sepolia, transport: custom(window.ethereum!) });

export async function tokenBalance(token: Address, account: Address) {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
}

/** Claim test tokens from the faucet (once an hour per token). */
export async function drip(account: Address, token: Address) {
  const hash = await wallet(account).writeContract({ address: SEPOLIA.faucet, abi: faucetAbi, functionName: 'drip', args: [token] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export interface CcipToSolana {
  /** The engine program (32 bytes). */
  receiver: Hex;
  data: Hex;
  extraArgs: Hex;
  token: Address;
  amount: bigint;
}

const message = (m: CcipToSolana) => ({
  receiver: m.receiver, data: m.data, tokenAmounts: [{ token: m.token, amount: m.amount }],
  feeToken: '0x0000000000000000000000000000000000000000' as Address, extraArgs: m.extraArgs,
});

export async function ccipFee(m: CcipToSolana) {
  return publicClient.readContract({ address: SEPOLIA.router, abi: routerAbi, functionName: 'getFee', args: [SEPOLIA.solanaSelector, message(m)] });
}

/**
 * Approve the router for the tokens and send the message (fee in Sepolia ETH).
 * Returns the CCIP message id, to follow on the CCIP explorer.
 */
export async function ccipSendToSolana(account: Address, m: CcipToSolana, onStep: (s: string) => void): Promise<{ messageId: Hex; tx: Hex }> {
  const w = wallet(account);
  const allowance = await publicClient.readContract({ address: m.token, abi: erc20Abi, functionName: 'allowance', args: [account, SEPOLIA.router] });
  if (allowance < m.amount) {
    onStep('Approve the CCIP router to take the tokens…');
    const a = await w.writeContract({ address: m.token, abi: erc20Abi, functionName: 'approve', args: [SEPOLIA.router, m.amount] });
    await publicClient.waitForTransactionReceipt({ hash: a });
  }
  const fee = await ccipFee(m);
  onStep('Send the CCIP message (fee in Sepolia ETH)…');
  const tx = await w.writeContract({ address: SEPOLIA.router, abi: routerAbi, functionName: 'ccipSend', args: [SEPOLIA.solanaSelector, message(m)], value: fee });
  const r = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (r.status !== 'success') throw new Error('The CCIP send reverted on Sepolia.');
  // The OnRamp's CCIPMessageSent (topic 0x192442a2…): the message id is the second data word.
  const log = r.logs.find(l => l.topics[0]?.startsWith('0x192442a2'));
  const messageId = (log ? `0x${log.data.slice(2 + 64, 2 + 128)}` : '0x') as Hex;
  return { messageId, tx };
}
