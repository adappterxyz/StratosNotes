#!/usr/bin/env python3
"""
Solana side of the StratosNotes cross-chain tokens (CCIP burn-mint CCTs),
paired with the Sepolia tokens in deployments/sepolia-tokens.json
(evm/deploy-tokens.sh). Uses Chainlink's ccip-solana-bs58-generator CLI with
--execute (EOA signing) on devnet.

Per token: create the mint (tUSD reuses the existing test USDC), initialize
its BurnMint pool and pool token account, claim the CCIP admin role, move the
mint authority to a 1-of-2 SPL multisig (pool signer + our key, so the faucet
can still mint), point the pool at its Sepolia twin, create the CCIP lookup
table and register the pool with the router.

Each step that succeeds is recorded in deployments/solana-tokens.json; a
rerun skips it.

    CCT_CLI="pnpm -s --dir /path/to/ccip-solana-bs58-generator bs58" python3 scripts/cct-solana.py
"""
import json, os, shlex, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deployments' / 'solana-tokens.json'
SEPOLIA = json.loads((ROOT / 'deployments' / 'sepolia-tokens.json').read_text())
DEVNET = json.loads((ROOT / 'deployments' / 'devnet.json').read_text())
CLI = shlex.split(os.environ.get('CCT_CLI', 'cct-solana-tx'))
POOL_PROGRAM = '41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB'
ROUTER = 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C'
FEE_QUOTER = 'FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi'
SEPOLIA_SELECTOR = '16015286601757825753'
ADMIN_KP = os.path.expanduser('~/.config/solana/id.json')
FAUCET_KP = str(ROOT / '.demo-keys' / 'faucet.json')

# symbol -> (Solana decimals, keypair holding the mint authority, existing mint or None)
TOKENS = {
    'tUSD': (6, FAUCET_KP, DEVNET['testUsdc']),
    'tETH': (9, ADMIN_KP, None),
    'tBTC': (8, ADMIN_KP, None),
    'tSOL': (9, ADMIN_KP, None),
}

state = json.loads(OUT.read_text()) if OUT.exists() else {}
def save(): OUT.write_text(json.dumps(state, indent=2) + '\n')

def cli(group, instruction, kp, *args, execute=True):
    cmd = [*CLI, group, '--instruction', instruction, '--env', 'devnet', '--json', *args]
    if execute: cmd += ['--execute', '--keypair', kp]
    for attempt in range(5):
        p = subprocess.run(cmd, capture_output=True, text=True)
        try:
            j = json.loads(p.stdout)
        except json.JSONDecodeError:
            j = {'ok': False, 'error': (p.stderr or p.stdout)[-800:]}
        if j.get('ok') is not False:
            return j
        err = json.dumps(j)[-600:]
        if '429' in err or 'Too Many' in err or 'blockhash' in err.lower():
            time.sleep(10 * (attempt + 1)); continue
        raise SystemExit(f'{group} {instruction} failed: {err}')
    raise SystemExit(f'{group} {instruction}: gave up after retries')

def pubkey_of(kp):
    return subprocess.run(['solana-keygen', 'pubkey', kp], capture_output=True, text=True, check=True).stdout.strip()

B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58decode(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    raw = n.to_bytes(32, 'big')
    return raw
def b58encode(b):
    n = int.from_bytes(b, 'big'); out = ''
    while n: n, r = divmod(n, 58); out = B58[r] + out
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + out
TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
def multisig_address(base, seed, mint):
    """As the CLI derives it: createWithSeed(base, sha256(seed || mint bytes).hex()[:32], token program)."""
    import hashlib
    s = hashlib.sha256(seed.encode() + b58decode(mint)).hexdigest()[:32]
    return b58encode(hashlib.sha256(b58decode(base) + s.encode() + b58decode(TOKEN_PROGRAM)).digest())

def find(obj, *keys):
    """First value under any of `keys`, searching nested dicts/lists."""
    if isinstance(obj, dict):
        for k in keys:
            if k in obj and isinstance(obj[k], str): return obj[k]
        for v in obj.values():
            r = find(v, *keys)
            if r: return r
    if isinstance(obj, list):
        for v in obj:
            r = find(v, *keys)
            if r: return r
    return None

for sym, (decimals, kp, existing) in TOKENS.items():
    s = state.setdefault(sym, {})
    me = pubkey_of(kp)
    s['admin'] = me
    def step(name, fn):
        if s.get('done', {}).get(name): return
        print(f'{sym}: {name}', flush=True)
        r = fn()
        s.setdefault('done', {})[name] = (find(r, 'signature') or True) if isinstance(r, dict) else r
        save()

    if existing:
        s['mint'] = existing
    elif 'mint' not in s:
        print(f'{sym}: create-mint', flush=True)
        r = cli('spl-token', 'create-mint', kp, '--authority', me, '--decimals', str(decimals), '--metadata', 'none')
        # The new mint is the create-account target: the transaction's second account.
        mint = r.get('accounts', [{}, {}])[1].get('pubkey') if r.get('execution', {}).get('executed') else None
        if not mint: raise SystemExit(f'no mint address in {json.dumps(r)[:800]}')
        s['mint'] = mint; save()
    mint = s['mint']
    s['decimals'] = decimals

    if 'poolSigner' not in s:
        d = cli('utils', 'derive-accounts', kp, '--program-type', 'burnmint-token-pool', '--program-id', POOL_PROGRAM,
                '--mint', mint, '--remote-chain-selector', SEPOLIA_SELECTOR, execute=False)
        acc = {a['name']: a['address'] for a in d['accounts']}
        s['poolConfig'] = acc['Pool State PDA']; s['poolSigner'] = acc['Pool Signer PDA']; s['poolTokenAccount'] = acc['Pool Token ATA']
        save()

    pool = ['--program-id', POOL_PROGRAM, '--mint', mint, '--authority', me]
    step('initialize-pool', lambda: cli('burnmint-token-pool', 'initialize-pool', kp, *pool))
    step('create-token-account', lambda: cli('burnmint-token-pool', 'create-token-account', kp, *pool))
    step('owner-propose-administrator', lambda: cli('router', 'owner-propose-administrator', kp, '--program-id', ROUTER, '--mint', mint, '--authority', me, '--token-admin-registry-admin', me))
    step('accept-admin-role', lambda: cli('router', 'accept-admin-role', kp, '--program-id', ROUTER, '--mint', mint, '--authority', me))

    if 'multisig' not in s:
        print(f'{sym}: create-multisig', flush=True)
        seed = f'sn-{sym.lower()}-ms'
        cli('spl-token', 'create-multisig', kp, '--authority', me, '--mint', mint, '--seed', seed,
            '--signers', json.dumps([s['poolSigner'], me]), '--threshold', '1')
        s['multisig'] = multisig_address(me, seed, mint); save()
    step('transfer-mint-authority', lambda: cli('spl-token', 'transfer-mint-authority', kp, '--authority', me, '--mint', mint, '--new-mint-authority', s['multisig']))

    eth = SEPOLIA[sym]
    remote = ['--remote-chain-selector', SEPOLIA_SELECTOR, '--token-address', eth['token'], '--decimals', str(eth['decimals'])]
    step('init-chain-remote-config', lambda: cli('burnmint-token-pool', 'init-chain-remote-config', kp, *pool, *remote, '--pool-addresses', '[]'))
    step('edit-chain-remote-config', lambda: cli('burnmint-token-pool', 'edit-chain-remote-config', kp, *pool, *remote, '--pool-addresses', json.dumps([eth['pool']])))

    if 'lookupTable' not in s:
        # create-lookup-table derives the ALT from a recent slot, which public devnet RPCs
        # often reject ("is not a recent slot"); create an empty ALT, then append to it.
        print(f'{sym}: create-alt', flush=True)
        p = subprocess.run([*CLI[:-1], 'create-alt', '--keypair', kp, '--env', 'devnet', '--authority', me], capture_output=True, text=True)
        import re
        m = re.search(r'Derived ALT:\s+([1-9A-HJ-NP-Za-km-z]{32,44})', p.stdout + p.stderr)
        if not m or 'successful' not in (p.stdout + p.stderr): raise SystemExit(f'create-alt failed: {(p.stdout + p.stderr)[-800:]}')
        s['lookupTable'] = m.group(1); save()
        time.sleep(5)  # a fresh ALT is usable one slot later
    step('append-to-lookup-table', lambda: cli('router', 'append-to-lookup-table', kp, '--program-id', ROUTER, '--mint', mint, '--authority', me,
        '--pool-program-id', POOL_PROGRAM, '--fee-quoter-program-id', FEE_QUOTER, '--lookup-table-address', s['lookupTable'],
        '--additional-addresses', json.dumps([s['multisig']])))
    step('set-pool', lambda: cli('router', 'set-pool', kp, '--program-id', ROUTER, '--mint', mint, '--authority', me,
                                 '--pool-lookup-table', s['lookupTable'], '--writable-indexes', '[3,4,7]'))
    print(f'{sym}: ready  mint {mint}  pool config {s["poolConfig"]}', flush=True)

save()
