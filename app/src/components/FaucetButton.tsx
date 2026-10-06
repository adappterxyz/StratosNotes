import { useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { DEPLOYMENT } from '../config';

/** Devnet test USDC: open your token account (you pay its rent), then the faucet mints 2,000. */
export default function FaucetButton() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean }>({ busy: false, text: '' });
  if (!publicKey) return null;
  const get = async () => {
    setState({ busy: true, text: 'Opening your test-USDC account…' });
    try {
      const mint = new PublicKey(DEPLOYMENT.testUsdc);
      const ata = getAssociatedTokenAddressSync(mint, publicKey);
      if (!(await connection.getAccountInfo(ata))) {
        const sig = await sendTransaction(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(publicKey, ata, publicKey, mint)), connection);
        await connection.confirmTransaction(sig, 'confirmed');
      }
      setState({ busy: true, text: 'Minting 2,000 test USDC…' });
      // The faucet signs the mint; this app submits it (devnet RPCs refuse Workers).
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const r = await fetch('/api/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: publicKey.toBase58(), blockhash }) });
      const j = await r.json() as { error?: string; transaction?: string };
      if (!r.ok || !j.transaction) { setState({ busy: false, text: j.error ?? `Faucet error ${r.status}`, bad: true }); return; }
      const raw = Uint8Array.from(atob(j.transaction), c => c.charCodeAt(0));
      const sig = await connection.sendRawTransaction(raw);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      setState({ busy: false, text: '2,000 test USDC received.' });
    } catch (e) {
      setState({ busy: false, text: e instanceof Error ? e.message : String(e), bad: true });
    }
  };
  return (
    <span className="row" style={{ gap: 8 }}>
      <button className="btn ghost" onClick={get} disabled={state.busy} title="Devnet only: needs a little devnet SOL for fees (faucet.solana.com)">Get test USDC</button>
      {state.text && <span className="small" role="status" style={{ color: state.bad ? 'var(--bad)' : 'var(--muted)', maxWidth: 220 }}>{state.text}</span>}
    </span>
  );
}
