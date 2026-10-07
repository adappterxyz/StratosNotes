import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { ENGINE_PROGRAM_ID } from '@stratosnotes/flow';
import { useEngine } from './engine';
import { loadOffering, loadOfferings, type Offering } from './offerings';

const FALLBACK_POLL_MS = 20_000;

/**
 * Re-read when the engine's accounts change: a WebSocket subscription to the
 * program (CRE reports, subscriptions, transfers land as account writes), so
 * pages update as events happen, with a slow poll in case the socket drops.
 */
function useLiveTick(subscribe: (bump: () => void) => () => void) {
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setTick(x => x + 1), 400); // one re-read per burst of writes
    };
    const stop = subscribe(bump);
    const poll = setInterval(() => setTick(x => x + 1), FALLBACK_POLL_MS);
    return () => { stop(); clearInterval(poll); if (timer.current) clearTimeout(timer.current); };
  }, [subscribe]);
  return [tick, () => setTick(x => x + 1)] as const;
}

/** Every offering, kept current. */
export function useOfferings() {
  const { engine } = useEngine();
  const { connection } = useConnection();
  const subscribe = useCallback((bump: () => void) => {
    const id = connection.onProgramAccountChange(ENGINE_PROGRAM_ID, bump, { commitment: 'confirmed' });
    return () => { connection.removeProgramAccountChangeListener(id).catch(() => {}); };
  }, [connection]);
  const [tick, refresh] = useLiveTick(subscribe);
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    loadOfferings(engine)
      .then(o => { if (live) { setOfferings(o); setError(''); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [engine, tick]);
  return { offerings, error, refresh };
}

/** One offering, updated the moment its account changes (a CRE report, a subscription, a transfer). */
export function useOffering(address: string | undefined) {
  const { engine } = useEngine();
  const { connection } = useConnection();
  const subscribe = useCallback((bump: () => void) => {
    let key: PublicKey;
    try { key = new PublicKey(address ?? ''); } catch { return () => {}; }
    const id = connection.onAccountChange(key, bump, { commitment: 'confirmed' });
    return () => { connection.removeAccountChangeListener(id).catch(() => {}); };
  }, [connection, address]);
  const [tick, refresh] = useLiveTick(subscribe);
  const [offering, setOffering] = useState<Offering | null | undefined>(undefined);
  const [updatedAt, setUpdatedAt] = useState(0);
  useEffect(() => {
    let live = true;
    let key: PublicKey;
    try { key = new PublicKey(address ?? ''); } catch { setOffering(null); return; }
    loadOffering(engine, key)
      .then(o => { if (live) { setOffering(o); setUpdatedAt(Date.now()); } })
      .catch(() => { if (live) setOffering(prev => (prev === undefined ? null : prev)); });
    return () => { live = false; };
  }, [engine, address, tick]);
  return { offering, refresh, updatedAt };
}

/** The current time, re-rendered every `ms` (phases and countdowns move with the clock). */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
