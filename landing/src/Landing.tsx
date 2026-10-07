import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import './notes.css';
import { EDGES, STEPS, type Chain } from './lifecycle';

const APP_URL = '/app/';
const REPO_URL = 'https://github.com/adappterxyz/StratosNotes';
const FLOW_URL = 'https://stratoslab.app';
const EXPLORER = (tx: string) => `https://explorer.solana.com/tx/${tx}?cluster=devnet`;

const CHAIN: Chain = 'solana';

// The cross-chain flow, as it ran on the testnets.
const XC_FLOW = [
  { title: 'Subscribe', dir: 'ltr', left: 'Investor sends 300 tUSD and "subscribe 300 units"', via: 'CCIP', time: '35–40 min', right: 'The engine runs the subscription for their Ethereum address' },
  { title: 'Observe', dir: 'here', left: '', via: 'CRE', time: 'every date', right: 'CRE fixes the strike, observes, pays coupons and the redemption' },
  { title: 'Pay out', dir: 'rtl', left: 'tUSD lands at the investor\'s address', via: 'CCIP', time: '~1 min', right: 'CRE locks the payout in a signed report; a relay sends it' },
  { title: 'Deliver', dir: 'rtl', left: 'tETH, tBTC or tSOL, units ÷ strike', via: 'CCIP', time: '~1 min', right: 'Physically settled notes deliver the worst performer\'s token' },
];

// The devnet run: a phoenix on ETH that Chainlink CRE ran end to end.
const RUN = [
  { what: 'CRE fixes the strike', detail: 'ETH 2,699.34', tx: '2VxTRWLpY7oD3AD65uE3mo8bfd242xNG5fgTVD3HAik7CN6hFLybKcDdD63EY4fYPXmUn8uK4iTR4UzrkRooQj2r', cu: '51,394' },
  { what: 'An investor sells 100 of 600 units', detail: 'transfer in part', tx: '3umFWgcG84oU8nbu2Mn3r2HUAvMWoQBoEkdh4s75H9QSddCes9fz7RBVRUUXAn6D7aGpVyUK2Eug1r9srgppHSZu', cu: '34,775' },
  { what: 'CRE observation 1', detail: '2.5% coupon paid', tx: 'Ju2Wo4k5rzoug8SQwBxsq4KhigaZqDJauxp5N5anAQYg1BDH91FefbFiiFE4iL6xbaQQcEKdqVratVJBX5XRenA', cu: '68,976' },
  { what: 'CRE observation 2', detail: 'coupon, autocall, redemption', tx: '4hySSWXNfSx2oSt5LnwVxegv8s9zXnQFyqz7VjHKWhMZLC37kLovD84K5mhQFCBKUWh3VF3gdDawpJ3VFYhPY8Ed', cu: '87,593' },
];
const PAID = [
  { holder: 'Investor A (kept 500 of 600)', units: '500', usdc: '525' },
  { holder: 'Investor B', units: '400', usdc: '420' },
  { holder: 'Investor C (bought 100 mid-life)', units: '100', usdc: '105' },
];

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('observe');
  const step = STEPS.find(s => s.id === active)!;

  // Terrain, nav state, reveals (shared with the Flow landing).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const cleanups: Array<() => void> = [];
    document.documentElement.classList.add('sn-smooth');
    cleanups.push(() => document.documentElement.classList.remove('sn-smooth'));

    (function terrain() {
      const canvas = root.querySelector<HTMLCanvasElement>('#bg-canvas');
      if (!canvas) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x050b0a, 0.055);
      const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 100);
      camera.position.set(0, 3.4, 9);
      camera.lookAt(0, -1.2, -6);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
      renderer.setSize(window.innerWidth, window.innerHeight);
      const COLS = 90, ROWS = 90, SIZE = 44;
      const geo = new THREE.PlaneGeometry(SIZE, SIZE, COLS, ROWS);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const cA = new THREE.Color(0x10b981), cB = new THREE.Color(0x2dd4bf), cC = new THREE.Color(0xa78bfa);
      const tmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const tt = (pos.getZ(i) + SIZE / 2) / SIZE;
        if (tt < 0.5) tmp.copy(cC).lerp(cB, tt * 2); else tmp.copy(cB).lerp(cA, (tt - 0.5) * 2);
        colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.MeshBasicMaterial({ wireframe: true, vertexColors: true, transparent: true, opacity: 0.42 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = -2.6;
      scene.add(mesh);
      const base = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) base[i] = pos.getY(i);
      let mx = 0, my = 0, tmx = 0, tmy = 0, scrollY = 0;
      const onPointer = (e: PointerEvent) => { tmx = e.clientX / window.innerWidth - 0.5; tmy = e.clientY / window.innerHeight - 0.5; };
      const onScroll = () => { scrollY = window.scrollY; };
      window.addEventListener('pointermove', onPointer);
      window.addEventListener('scroll', onScroll, { passive: true });
      const wave = (x: number, z: number, tt: number) => Math.sin(x * 0.4 + tt * 0.7) * 0.55 + Math.cos(z * 0.45 + tt * 0.55) * 0.5 + Math.sin((x + z) * 0.28 + tt * 0.9) * 0.4 + Math.sin(Math.sqrt(x * x + z * z) * 0.5 - tt * 1.1) * 0.35;
      const clock = new THREE.Clock();
      let raf = 0, stopped = false;
      const animate = () => {
        if (stopped) return;
        raf = requestAnimationFrame(animate);
        const tt = clock.getElapsedTime() * (reduce ? 0.15 : 1);
        const pa = geo.attributes.position;
        for (let i = 0; i < pa.count; i++) pa.setY(i, base[i] + wave(pa.getX(i), pa.getZ(i), tt) * 0.6);
        pa.needsUpdate = true;
        mx += (tmx - mx) * 0.04; my += (tmy - my) * 0.04;
        camera.position.x = mx * 2.2;
        camera.position.y = 3.4 - my * 1.2 - Math.min(scrollY, 1400) * 0.0016;
        camera.lookAt(0, -1.2, -6);
        mesh.rotation.z = mx * 0.04;
        renderer.render(scene, camera);
      };
      animate();
      const onResize = () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); };
      window.addEventListener('resize', onResize);
      const onVisible = () => { if (document.hidden) { stopped = true; cancelAnimationFrame(raf); } else if (stopped) { stopped = false; animate(); } };
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => {
        stopped = true; cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', onPointer); window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisible);
        geo.dispose(); mat.dispose(); renderer.dispose();
      });
    })();

    (function nav() {
      const header = root.querySelector('header.nav');
      if (!header) return;
      const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 30);
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener('scroll', onScroll));
    })();

    (function reveals() {
      root.classList.add('js');
      const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
      const reveal = (el: Element) => el.classList.add('in');
      const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { reveal(en.target); io.unobserve(en.target); } }), { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      els.forEach(el => io.observe(el));
      const firstPass = () => { const vh = window.innerHeight || 800; els.forEach(el => { if (el.getBoundingClientRect().top < vh * 0.96) { reveal(el); io.unobserve(el); } }); };
      const raf = requestAnimationFrame(firstPass);
      const t1 = window.setTimeout(firstPass, 250);
      const t2 = window.setTimeout(() => els.forEach(reveal), 2600);
      cleanups.push(() => { io.disconnect(); cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); });
    })();

    return () => { cleanups.forEach(fn => fn()); root.classList.remove('js'); };
  }, []);

  const pos = (id: string) => STEPS.find(s => s.id === id)!;
  return (
    <div className="sn-root" ref={rootRef}>
      <canvas id="bg-canvas" />
      <div className="bg-veil" />
      <div className="bg-grain" />

      <header className="nav">
        <div className="nav-inner">
          <a className="brand" href="#top" aria-label="StratosNotes home">
            <img className="mark" src="/logos/stratos-mark.png" alt="" width={28} height={28} />
            <span>StratosNotes</span>
          </a>
          <nav className="nav-links">
            <a href="#how">How it works</a>
            <a href="#lifecycle">Lifecycle</a>
            <a href="#proof">Proof</a>
            <a href="#crosschain">Cross-chain</a>
            <a href="#solana">Solana</a>
            <a href={REPO_URL} target="_blank" rel="noopener">Code</a>
          </nav>
          <div className="nav-cta">
            <a href={APP_URL} className="btn btn-primary">Open the app <span className="arrow">→</span></a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap hero-inner">
            <div className="badge" data-reveal>
              <span className="dot" />
              <span><b>Live on Solana devnet</b> · Ethereum investors via CCIP · observed by Chainlink CRE</span>
            </div>
            <h1 data-reveal data-reveal-d="1">
              The structured note lifecycle,<br /><span className="grad-text">on Solana.</span>
            </h1>
            <p className="sub" data-reveal data-reveal-d="2">
              Design a note on one asset or a worst-of basket, from a template, a term sheet, a sentence or a
              BPMN diagram. Sell it for USDC to investors on Solana or Ethereum, let holders transfer it, and let
              Chainlink CRE fix the strike, observe every date and pay every coupon and redemption, on either chain.
            </p>
            <div className="hero-cta" data-reveal data-reveal-d="3">
              <a href="#lifecycle" className="btn btn-primary">Walk the lifecycle <span className="arrow">→</span></a>
              <a href={APP_URL} className="btn btn-ghost">Issue a note</a>
            </div>
            <div className="pipeline-tags" data-reveal data-reveal-d="4">
              <span className="chip"><i style={{ background: 'var(--blue)' }} /> Term sheet</span>
              <span className="sep">→</span>
              <span className="chip"><i style={{ background: 'var(--purple)' }} /> BPMN workflow</span>
              <span className="sep">→</span>
              <span className="chip"><i style={{ background: 'var(--cyan)' }} /> Solana devnet</span>
              <span className="sep">→</span>
              <span className="chip"><i style={{ background: 'var(--blue)' }} /> Chainlink CRE observes</span>
              <span className="sep">↔</span>
              <span className="chip"><i style={{ background: 'var(--purple)' }} /> Ethereum via CCIP</span>
            </div>
          </div>
        </section>

        <section id="how">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">How it works</span>
              <h2>A promise about dates and prices,<br /><span className="grad-text">kept by the ledger.</span></h2>
              <p>A structured note says what is paid, to whom, on which dates, depending on a price. Today a calculation agent watches the dates and a paying agent moves the money. Here the workflow is the contract and Chainlink CRE is the calculation agent.</p>
            </div>
            <div className="steps">
              <div className="step" style={{ '--accent': 'var(--blue)' } as React.CSSProperties} data-reveal>
                <div className="num"><b>01</b> · DESIGN</div>
                <div className="ico"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4a2 2 0 0 1 2 2V14" /></svg></div>
                <h3>Term sheet, AI or BPMN</h3>
                <p>Pick one of five verified payoffs, describe the note to the AI (it asks for missing terms rather than guessing), or change the workflow itself in the studio. Every change passes the validator and compiler first.</p>
                <div className="tag">// fixed coupon · reverse convertible · phoenix · snowball · protected</div>
              </div>
              <div className="step" style={{ '--accent': 'var(--purple)' } as React.CSSProperties} data-reveal data-reveal-d="1">
                <div className="num"><b>02</b> · ISSUE &amp; SELL</div>
                <div className="ico"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><path d="M7 7h11l-3-3M17 17H6l3 3" /></svg></div>
                <h3>A book anyone can buy from</h3>
                <p>Size, strike date and observation dates are set per issuance, at pre-trade. Investors subscribe until the strike date in one atomic stablecoin-for-note swap, and can transfer units in whole or in part.</p>
                <div className="tag">// per-issuance terms · atomic DvP · transfers</div>
              </div>
              <div className="step" style={{ '--accent': 'var(--cyan)' } as React.CSSProperties} data-reveal data-reveal-d="2">
                <div className="num"><b>03</b> · OBSERVE &amp; PAY</div>
                <div className="ico"><svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5 19 19M19 5l-2.5 2.5M7.5 16.5 5 19" /></svg></div>
                <h3>Chainlink CRE keeps every date</h3>
                <p>On the strike date and each observation date, CRE reads the Chainlink feed and writes a signed report. The ledger checks it came from Chainlink, then runs the coupon, autocall or redemption in the same transaction.</p>
                <div className="tag">// one CRE workflow for every note</div>
              </div>
            </div>
          </div>
        </section>

        <section id="lifecycle">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">The lifecycle</span>
              <h2>Every step, <span className="grad-text">on-chain.</span></h2>
              <p>The same phoenix note, step by step. Pick a step to see what it really is: an instruction of the StratosNotes engine on Solana, or the Chainlink CRE workflow that drives it.</p>
            </div>
            <div className="demo-shell" data-reveal>
              <div className="demo-topbar">
                <span className="dots"><i /><i /><i /></span>
                <span className="title">12M Phoenix (memory) on ETH</span>
                <span className="hint">Pick a step <kbd>↳</kbd></span>
              </div>
              <div className="canvas-pane">
                <div className="grid-bg" />
                <div className="bpmn">
                  <svg className="edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {EDGES.map(([a, b], i) => {
                      const p1 = pos(a), p2 = pos(b);
                      const mx = (p1.x + p2.x) / 2;
                      const d = `M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`;
                      const lit = a === active || b === active;
                      return (
                        <g key={a + b}>
                          <path d={d} className={lit ? 'lit' : ''} vectorEffect="non-scaling-stroke" />
                          <circle r="0.9" className="flow-dot"><animateMotion dur="2.6s" repeatCount="indefinite" path={d} begin={`${i * 0.5}s`} /></circle>
                        </g>
                      );
                    })}
                  </svg>
                  {STEPS.map(s => (
                    <button key={s.id} type="button" className={`node${s.id === active ? ' active' : ''}`} style={{ left: `${s.x}%`, top: `${s.y}%`, background: 'none', border: 0, color: 'inherit', font: 'inherit' }} onClick={() => setActive(s.id)} aria-pressed={s.id === active} aria-label={s.label}>
                      {s.type === 'box' && <div className="node-box">{s.label}</div>}
                      {s.type === 'event' && <div className="node-event"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" strokeWidth="2" /></svg></div>}
                      {s.type === 'end' && <div className="node-event end"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" strokeWidth="2.6" /></svg></div>}
                      {s.type === 'gateway' && <div className="node-gateway"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" strokeWidth="2.2" /></svg></div>}
                      {s.type !== 'box' && <span className="label">{s.label}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="code-pane">
                <div className="code-head">
                  <div className="step-tag">{step.tag}</div>
                  <h4>{step.title}</h4>
                  <p>{step.desc}</p>
                </div>
                <div className="code-meta"><img src="/logos/chains/solana-w.svg" alt="" style={{ height: 11, verticalAlign: -1, marginRight: 6 }} />Triggered by <b>{step.actor}</b> · StratosNotes engine on Solana</div>
                <div className="code-body">
                  <pre className="daml" dangerouslySetInnerHTML={{ __html: step.code[CHAIN] }} />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="proof">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Proof</span>
              <h2>A whole life on-chain, <span className="grad-text">with nobody touching it.</span></h2>
              <p>A phoenix note on ETH, issued on Solana devnet. After the book closed, every step was a Chainlink CRE report; one investor sold part of their position mid-life, and each holder was paid exactly what the reference payoff says.</p>
            </div>
            <div className="proof" data-reveal>
              <div className="cell"><div className="v">4</div><div className="k">CRE-driven or holder transactions after issuance, no operator</div></div>
              <div className="cell"><div className="v">99k</div><div className="k">peak compute units per CRE report (three feeds in one), of the 300k cap</div></div>
              <div className="cell"><div className="v">12 / 12</div><div className="k">runs paid to the expected payoff on a local validator, incl. worst-of and physical delivery</div></div>
              <div className="cell"><div className="v">7 s</div><div className="k">from a plain-English term sheet to issuable terms with the AI</div></div>
            </div>
            <div className="ledger" data-reveal>
              <table>
                <thead><tr><th>Event</th><th>Result</th><th className="r">Compute units</th><th>Transaction</th></tr></thead>
                <tbody>
                  {RUN.map(r => (
                    <tr key={r.tx}>
                      <td>{r.what}</td><td>{r.detail}</td><td className="r">{r.cu}</td>
                      <td><a href={EXPLORER(r.tx)} target="_blank" rel="noopener" style={{ color: 'var(--purple)', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.tx.slice(0, 10)}…</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ledger" data-reveal>
              <table>
                <thead><tr><th>Holder at redemption</th><th className="r">Units</th><th className="r">USDC received</th></tr></thead>
                <tbody>
                  {PAID.map(p => <tr key={p.holder}><td>{p.holder}</td><td className="r">{p.units}</td><td className="r"><b>{p.usdc}</b></td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="crosschain">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Cross-chain · Chainlink CCIP</span>
              <h2>One note. <span className="grad-text">Investors on two chains.</span></h2>
              <p>The lifecycle runs on Solana. Investors on Ethereum subscribe with their own tokens and are paid back where they are: Chainlink CCIP carries the money, Chainlink CRE decides every payout.</p>
            </div>
            <div className="xc" data-reveal>
              <div className="xc-head">
                <div className="xc-lane"><img src="/logos/chains/ethereum-w.svg" alt="" /> Ethereum Sepolia</div>
                <div className="xc-lane mid"><img src="/logos/chainlink.svg" alt="" /> Chainlink</div>
                <div className="xc-lane"><img src="/logos/chains/solana-w.svg" alt="" /> Solana devnet</div>
              </div>
              {XC_FLOW.map(r => (
                <div key={r.title} className={`xc-row ${r.dir}`}>
                  <div className="xc-cell">{r.left}</div>
                  <div className="xc-arrow"><span className="xc-label">{r.via}</span><span className="xc-line" /><span className="xc-time">{r.time}</span></div>
                  <div className="xc-cell">{r.right}</div>
                  <div className="xc-title">{r.title}</div>
                </div>
              ))}
            </div>
            <div className="chain-cards" style={{ marginTop: 22 }}>
              <div className="chain-card" data-reveal>
                <div className="logo">Subscribe from either chain</div>
                <span className="status-pill verified"><i />Live on testnets</span>
                <p>Solana investors swap USDC for units in one transaction. Ethereum investors send tUSD and a subscribe call over CCIP; the engine runs the same subscription for their address, or refunds it if the book closed while it travelled.</p>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="1">
                <div className="logo">CRE pays both chains</div>
                <span className="status-pill verified"><i />Live on testnets</span>
                <p>For every Ethereum holder with a coupon or redemption due, CRE writes a DON-signed payout report: the engine locks the amount for CCIP, and any relay delivers it, only to that address and only that amount.</p>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="2">
                <div className="logo">Delivery in tokens, on either chain</div>
                <span className="status-pill"><i />tUSD · tETH · tBTC · tSOL</span>
                <p>Cash and the deliverable underlyings are CCIP cross-chain tokens on both chains. A physically settled note delivers units ÷ strike of the worst performer, to Solana holders in place and to Ethereum holders over CCIP.</p>
              </div>
            </div>
            <div className="proof" data-reveal style={{ marginTop: 22 }}>
              <div className="cell"><div className="v">~1 min</div><div className="k">Solana → Ethereum: payouts and deliveries</div></div>
              <div className="cell"><div className="v">35–40 min</div><div className="k">Ethereum → Solana: subscriptions (Ethereum finality first)</div></div>
              <div className="cell"><div className="v">421 tUSD + tETH</div><div className="k">reached an Ethereum investor from three notes run on Solana, incl. a physical delivery</div></div>
              <div className="cell"><div className="v">0</div><div className="k">manual steps for Ethereum payouts: CRE locks, the relay delivers</div></div>
            </div>
          </div>
        </section>

        <section id="features">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Capabilities</span>
              <h2>Everything between <span className="grad-text">the term sheet and the payout</span>.</h2>
              <p>Built on Flow's BPMN compiler and verified payoff engines, rewritten for Solana and Chainlink CRE.</p>
            </div>
            <div className="features">
              <div className="feature" data-reveal>
                <div className="fico"><svg viewBox="0 0 24 24" strokeWidth="1.7"><path d="M3 17l5-5 4 3 6-7" /><path d="M14 5h5v5" /></svg></div>
                <h3>Five verified payoffs</h3>
                <p>Fixed coupon note, reverse convertible, phoenix with memory, snowball, principal-protected; each tested along price paths against a reference payoff.</p>
              </div>
              <div className="feature" data-reveal data-reveal-d="1">
                <div className="fico"><svg viewBox="0 0 24 24" strokeWidth="1.7"><path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.6z" /></svg></div>
                <h3>AI that asks, not guesses</h3>
                <p>A sentence becomes issuable terms; 10% a year becomes 2.5% a quarter. Missing terms come back as a question, and edits to the workflow come back as checked patches.</p>
              </div>
              <div className="feature" data-reveal data-reveal-d="2">
                <div className="fico"><svg viewBox="0 0 24 24" strokeWidth="1.7"><rect x="3" y="4" width="7" height="5" rx="1.5" /><rect x="14" y="15" width="7" height="5" rx="1.5" /><path d="M10 6.5h3a2 2 0 0 1 2 2v9" /></svg></div>
                <h3>BPMN studio</h3>
                <p>Change what each step does: fields, price observations, timers, payments, gateway conditions. The validator and compiler check every edit before it can be issued.</p>
              </div>
              <div className="feature" data-reveal>
                <div className="fico"><svg viewBox="0 0 24 24" strokeWidth="1.7"><path d="M8 3v4M16 3v4M3 10h18" /><rect x="3" y="5" width="18" height="16" rx="2" /></svg></div>
                <h3>Recurring issuance</h3>
                <p>A product is a template. Each issuance sets its own size and dates at pre-trade, minutes apart for a demo or quarters for real, from the same on-chain definition.</p>
              </div>
              <div className="feature" data-reveal data-reveal-d="1">
                <div className="fico"><svg viewBox="0 0 24 24" strokeWidth="1.7"><path d="M7 7h11l-3-3M17 17H6l3 3" /></svg></div>
                <h3>Open book, atomic settlement</h3>
                <p>Anyone subscribes until the strike date; stablecoins and note units swap in one transaction. Holders transfer units in whole or in part, and payouts follow them.</p>
              </div>
              <div className="feature" data-reveal data-reveal-d="2">
                <div className="fico"><svg viewBox="0 0 24 24" strokeWidth="1.7"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6M9 13h6M9 17h3" /></svg></div>
                <h3>Exact on-chain arithmetic</h3>
                <p>Barriers and payouts are evaluated in 10-decimal fixed point by the ledger; prices are accepted only from Chainlink's forwarder and inside declared bounds.</p>
              </div>
            </div>
            <div className="orchestration" data-reveal>
              <div className="orch-copy">
                <span className="orch-label">Orchestration</span>
                <p><strong>Chainlink CRE</strong> is the calculation agent: one workflow reads Chainlink feeds and writes signed reports for every note. <strong>Cloudflare Workers</strong> host the app, the AI that reads term sheets and the template library.</p>
              </div>
              <div className="orch-logos">
                <div className="orch-logo"><img className="orch-mark" src="/logos/chainlink.svg" alt="Chainlink" /><span className="orch-name"><strong>Chainlink</strong><span>CRE + Data Feeds</span></span></div>
                <div className="orch-logo"><img className="orch-mark" src="/logos/cloudflare.svg" alt="Cloudflare" /><span className="orch-name"><strong>Cloudflare</strong><span>Workers + Workers AI</span></span></div>
              </div>
            </div>
          </div>
        </section>

        <section id="solana">
          <div className="wrap">
            <div className="section-head" data-reveal>
              <span className="eyebrow">Why Solana</span>
              <h2>One program, <span className="grad-text">every note</span>.</h2>
              <p>Every issuance is an account of one Solana program, priced by Chainlink and settled in USDC. Fast, cheap transactions make a quarterly product something you can watch run in minutes.</p>
            </div>
            <div className="chain-cards">
              <div className="chain-card" data-reveal>
                <div className="logo"><img src="/logos/chains/solana-w.svg" alt="" /> The engine</div>
                <span className="status-pill"><i />Live on devnet</span>
                <p>One Anchor program runs every note as a BPMN workflow. A workflow is stored once, addressed by its hash; each issuance is a process of it.</p>
                <ul><li>Coupons, autocalls, knock-in and redemption on-chain</li><li>Exact 10-decimal fixed-point arithmetic</li><li>Worst-of baskets of up to three assets</li></ul>
                <span className="foot-note">flow_engine</span>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="1">
                <div className="logo"><img src="/logos/chainlink.svg" alt="" /> CRE on Solana</div>
                <span className="status-pill"><i />Runs every note</span>
                <p>One Chainlink CRE workflow reads the price feeds and writes DON-signed reports to Solana through the keystone forwarder. The engine accepts prices only from Chainlink.</p>
                <ul><li>Every report under 100k compute units</li><li>All of a basket's prices in one report</li><li>Prices from Chainlink's Ethereum feeds, read only</li></ul>
                <span className="foot-note">notes-keeper</span>
              </div>
              <div className="chain-card" data-reveal data-reveal-d="2">
                <div className="logo"><img src="/logos/chains/solana-w.svg" alt="" /> An open market</div>
                <span className="status-pill"><i />Self-service</span>
                <p>Anyone can issue from a template or their own design, and anyone can subscribe: each subscription is one atomic USDC-for-note swap.</p>
                <ul><li>Open books until the strike date</li><li>Investors on Solana or Ethereum</li><li>Transfers in whole or in part, even to an Ethereum address</li></ul>
                <span className="foot-note">sp.stratoslab.app/app</span>
              </div>
            </div>
            <p style={{ marginTop: 16, color: 'var(--muted)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>Chain and partner logos are trademarks of their respective owners. No endorsement implied.</p>
          </div>
        </section>

        <section id="cta">
          <div className="wrap">
            <div className="cta-final" data-reveal>
              <span className="eyebrow" style={{ justifyContent: 'center' }}>Try it</span>
              <h2 style={{ marginTop: 18 }}>Your next note<br />doesn't need a structuring desk.</h2>
              <p>Issue a phoenix on ETH with observations three minutes apart and watch Chainlink CRE run its whole life on Solana devnet.</p>
              <div className="hero-cta">
                <a href={APP_URL} className="btn btn-primary">Open the app <span className="arrow">→</span></a>
                <a href={REPO_URL} target="_blank" rel="noopener" className="btn btn-ghost">Read the code</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <a className="brand" href="#top"><img className="mark" src="/logos/stratos-mark.png" alt="" width={28} height={28} /><span>StratosNotes</span></a>
          <div className="foot-links">
            <a href="#lifecycle">Lifecycle</a>
            <a href="#proof">Proof</a>
            <a href="#crosschain">Cross-chain</a>
            <a href="#solana">Solana</a>
            <a href={FLOW_URL} target="_blank" rel="noopener">StratosFlow</a>
            <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
          </div>
          <small>© {new Date().getFullYear()} StratosNotes · by Stratos Lab · Solana · Chainlink CRE · CCIP</small>
        </div>
      </footer>
    </div>
  );
}
