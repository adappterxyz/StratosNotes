/**
 * Built-in devnet wallets, so one person can play the issuer and an investor
 * without a browser extension: each is a keypair kept in this browser's
 * localStorage that signs without a pop-up. Devnet only; never hold real funds.
 */
import { BaseMessageSignerWalletAdapter, WalletNotConnectedError, WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import { Keypair, Transaction, VersionedTransaction, type PublicKey, type TransactionVersion } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';

export type DemoRole = 'issuer' | 'investor';
export const DEMO_WALLETS: Record<DemoRole, WalletName<string>> = {
  issuer: 'Demo issuer' as WalletName<string>,
  investor: 'Demo investor' as WalletName<string>,
};

const icon = (letter: string, hue: number) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="hsl(${hue},55%,38%)"/><text x="16" y="21.5" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`)}` as const;

function loadKey(role: DemoRole): Keypair {
  const k = `sn-demo-${role}`;
  try {
    const saved = localStorage.getItem(k);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
    const kp = Keypair.generate();
    localStorage.setItem(k, JSON.stringify(Array.from(kp.secretKey)));
    return kp;
  } catch {
    return Keypair.generate(); // storage blocked: a wallet for this page load only
  }
}

export class DemoWalletAdapter extends BaseMessageSignerWalletAdapter {
  readonly name: WalletName<string>;
  readonly url = 'https://sp.stratoslab.app/app';
  readonly icon: `data:image/svg+xml;base64,${string}`;
  readonly supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(['legacy', 0] as TransactionVersion[]);
  readonly readyState = WalletReadyState.Loadable;
  private kp: Keypair | null = null;
  private busy = false;

  constructor(readonly role: DemoRole) {
    super();
    this.name = DEMO_WALLETS[role];
    this.icon = role === 'issuer' ? icon('I', 160) : icon('V', 265);
  }

  get publicKey(): PublicKey | null { return this.kp?.publicKey ?? null; }
  get connecting() { return this.busy; }

  async connect() {
    if (this.kp) return;
    this.busy = true;
    this.kp = loadKey(this.role);
    this.busy = false;
    this.emit('connect', this.kp.publicKey);
  }

  async disconnect() {
    this.kp = null;
    this.emit('disconnect');
  }

  private key() {
    if (!this.kp) throw new WalletNotConnectedError();
    return this.kp;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    const kp = this.key();
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map(t => this.signTransaction(t)));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return ed25519.sign(message, this.key().secretKey.slice(0, 32));
  }
}
