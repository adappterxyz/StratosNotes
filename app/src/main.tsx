import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import './styles.css';
import App from './App';
import { RPC_URL } from './config';
import { DemoWalletAdapter } from './lib/demoWallet';

function Root() {
  // Wallet Standard wallets (Phantom, Solflare, Backpack…) register themselves;
  // the two demo wallets let one person play issuer and investor.
  const wallets = useMemo(() => [new DemoWalletAdapter('issuer'), new DemoWalletAdapter('investor')], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter basename="/app">
            <App />
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
