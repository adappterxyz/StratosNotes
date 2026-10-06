import devnet from '../../deployments/devnet.json';

/** Cluster and deployed addresses (deployments/devnet.json, written by packages/flow/scripts/devnet.ts). */
export const CLUSTER = 'devnet';
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'https://api.devnet.solana.com';
export const DEPLOYMENT = devnet as { engine: string; testUsdc: string; config: string; forwarders: string[] };
export const explorer = (kind: 'address' | 'tx', id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=${CLUSTER}`;
