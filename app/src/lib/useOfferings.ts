import { useEffect, useState } from 'react';
import { useEngine } from './engine';
import { loadOfferings, type Offering } from './offerings';

/** Offerings from chain, refreshed every 15 s (CRE observations land while you watch). */
export function useOfferings() {
  const { engine } = useEngine();
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    loadOfferings(engine)
      .then(o => { if (live) { setOfferings(o); setError(''); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    const t = setTimeout(() => setTick(x => x + 1), 15000);
    return () => { live = false; clearTimeout(t); };
  }, [engine, tick]);
  return { offerings, error, refresh: () => setTick(x => x + 1) };
}
