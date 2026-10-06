import { useMemo } from 'react';
import { AnchorProvider } from '@coral-xyz/anchor';
import { Keypair, type PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { Engine } from '@stratosnotes/flow';

// Read-only: a wallet that never signs, for browsing without connecting.
const readOnly = (() => {
  const k = Keypair.generate().publicKey;
  return {
    publicKey: k as PublicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(_t: T): Promise<T> => { throw new Error('Connect a wallet to sign'); },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(_t: T[]): Promise<T[]> => { throw new Error('Connect a wallet to sign'); },
  };
})();

/** The engine client, signing with the connected wallet when there is one. */
export function useEngine(): { engine: Engine; connected: boolean } {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(() => ({
    engine: new Engine(new AnchorProvider(connection, wallet ?? readOnly, { commitment: 'confirmed' })),
    connected: !!wallet,
  }), [connection, wallet]);
}
