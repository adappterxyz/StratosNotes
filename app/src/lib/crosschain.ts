/**
 * Cross-chain notes in the app: Sepolia subscriptions in flight (CCIP
 * messages, followed through the Worker's CCIP status proxy) and sending a
 * Sepolia holder's balance home (`withdraw_remote`, a v0 transaction with the
 * token's and the engine's CCIP lookup tables).
 */
import { useEffect, useState } from 'react';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import { CCIP, ccipSendAccounts, ENGINE_PROGRAM_ID, type Engine } from '@stratosnotes/flow';
import { DEPLOYMENT, type TokenSymbol, TOKENS } from '../config';

export interface InFlight { messageId: string; units: number; sentAt: number; from: string; tx: string }
export interface CcipStatus { state: number | null; sendFinalized: string | null; commitBlockTimestamp: string | null; receiptTimestamp: string | null; indexed: boolean }

const storeKey = (process: string) => `sn-ccip-${process}`;
export function loadInFlight(process: string): InFlight[] {
  try { return JSON.parse(localStorage.getItem(storeKey(process)) ?? '[]'); } catch { return []; }
}
export function saveInFlight(process: string, m: InFlight) {
  try { localStorage.setItem(storeKey(process), JSON.stringify([m, ...loadInFlight(process)].slice(0, 20))); } catch { /* private mode */ }
}

/** Where a CCIP message is: sent, waiting for Ethereum finality, committed on Solana, delivered. */
export function statusText(s: CcipStatus | undefined, sentAt: number, now: number): { text: string; done: boolean; failed: boolean } {
  const mins = Math.max(0, Math.round((now - sentAt) / 60));
  if (!s || !s.indexed) return { text: `Sent ${mins} min ago; CCIP is indexing it`, done: false, failed: false };
  if (s.state === 2) return { text: 'Delivered on Solana', done: true, failed: false };
  if (s.state === 3) return { text: 'Failed on Solana: it can be retried from the CCIP explorer', done: false, failed: true };
  if (s.commitBlockTimestamp) return { text: `Committed on Solana; executing (${mins} min)`, done: false, failed: false };
  if (s.sendFinalized) return { text: `Finalized on Ethereum; committing (${mins} min)`, done: false, failed: false };
  return { text: `Waiting for Ethereum finality (${mins} of ~15 min)`, done: false, failed: false };
}

/** Poll the status of a note's in-flight messages every 30 s. */
export function useInFlight(process: string | undefined, tick: number) {
  const [list, setList] = useState<InFlight[]>([]);
  const [status, setStatus] = useState<Record<string, CcipStatus>>({});
  useEffect(() => { if (process) setList(loadInFlight(process)); }, [process, tick]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      for (const m of list) {
        if (status[m.messageId]?.state === 2) continue;
        try {
          const r = await fetch(`/api/ccip/${m.messageId}`);
          const j = await r.json() as CcipStatus;
          if (live) setStatus(s => ({ ...s, [m.messageId]: j }));
        } catch { /* try again later */ }
      }
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, status };
}

/**
 * Send a remote holder's whole balance of `symbol` to its chain: anyone can
 * do this (the caller's wallet pays the CCIP fee in SOL, `feeLamports`).
 */
export async function buildWithdrawRemote(opts: {
  connection: Connection; engine: Engine; payer: PublicKey; process: PublicKey; definition: PublicKey;
  holder: PublicKey; asset: number; symbol: TokenSymbol; feeLamports?: bigint;
}): Promise<VersionedTransaction> {
  const t = TOKENS[opts.symbol];
  const mint = new PublicKey(t.solana.mint);
  if (!DEPLOYMENT.ccip?.lookupTable) throw new Error('The engine\'s CCIP lookup table is not set up on this deployment yet.');
  const [tokenAlt, engineAlt] = await Promise.all([
    opts.connection.getAddressLookupTable(new PublicKey(t.solana.lookupTable)),
    opts.connection.getAddressLookupTable(new PublicKey(DEPLOYMENT.ccip.lookupTable)),
  ]);
  if (!tokenAlt.value || !engineAlt.value) throw new Error('Could not read the CCIP lookup tables.');
  const routerAccounts = ccipSendAccounts({ engine: ENGINE_PROGRAM_ID, mint, destSelector: CCIP.sepolia.selector, lookupTableAddresses: tokenAlt.value.state.addresses });
  const ix = await opts.engine.withdrawRemote(opts.process, opts.definition, opts.holder, opts.asset, mint, opts.feeLamports ?? 50_000_000n, routerAccounts);
  const { blockhash } = await opts.connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: opts.payer, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
  }).compileToV0Message([engineAlt.value, tokenAlt.value]);
  return new VersionedTransaction(msg);
}
