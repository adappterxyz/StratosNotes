import { useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Droplet } from 'lucide-react';
import { TOKENS, type TokenSymbol } from '../config';

const DRIP: Record<TokenSymbol, string> = { tUSD: '2,000', tETH: '5', tBTC: '0.2', tSOL: '100' };
/** Below this the faucet tops the wallet up with 0.1 devnet SOL first. */
const MIN_LAMPORTS = 50_000_000;

/**
 * Devnet test tokens: open your token account (you pay its rent), then the
 * faucet sends some: 2,000 test USD, or tETH / tBTC / tSOL for a physically
 * settled note's delivery reserve. A wallet low on devnet SOL gets 0.1 SOL first.
 */
export default function FaucetButton({ token = 'tUSD', label }: { token?: TokenSymbol; label?: string }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [state, setState] = useState<{ busy: boolean; text: string; bad?: boolean }>({ busy: false, text: '' });
  if (!publicKey) return null;
  // The faucet signs; this app submits it (devnet RPCs refuse Workers).
  const drip = async (what: TokenSymbol | 'SOL') => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const r = await fetch('/api/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: publicKey.toBase58(), blockhash, token: what }) });
    const j = await r.json() as { error?: string; transaction?: string };
    if (!r.ok || !j.transaction) throw new Error(j.error ?? `Faucet error ${r.status}`);
    const sig = await connection.sendRawTransaction(Uint8Array.from(atob(j.transaction), c => c.charCodeAt(0)));
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  };
  const get = async () => {
    try {
      // A new wallet has no SOL for fees or the token account's rent: send some first.
      if (await connection.getBalance(publicKey, 'confirmed') < MIN_LAMPORTS) {
        setState({ busy: true, text: 'Sending devnet SOL for fees…' });
        await drip('SOL');
      }
      setState({ busy: true, text: `Opening your ${token} account…` });
      const mint = new PublicKey(TOKENS[token].solana.mint);
      const ata = getAssociatedTokenAddressSync(mint, publicKey);
      if (!(await connection.getAccountInfo(ata))) {
        const sig = await sendTransaction(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(publicKey, ata, publicKey, mint)), connection);
        await connection.confirmTransaction(sig, 'confirmed');
      }
      setState({ busy: true, text: `Sending ${DRIP[token]} ${token}…` });
      await drip(token);
      setState({ busy: false, text: `${DRIP[token]} ${token} received.` });
    } catch (e) {
      setState({ busy: false, text: e instanceof Error ? e.message : String(e), bad: true });
    }
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      {state.text && <span className="xs" role="status" style={{ color: state.bad ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))', maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={state.text}>{state.text}</span>}
      <button className="btn" onClick={get} disabled={state.busy} title="Devnet test tokens (and devnet SOL for fees if the wallet is low)"><Droplet className="i" />{label ?? (token === 'tUSD' ? 'Test USDC' : `Get ${token}`)}</button>
    </span>
  );
}
