#!/usr/bin/env bash
# Point each Sepolia token pool at its Solana devnet twin (CCIP applyChainUpdates):
# the remote pool is the Solana pool's config PDA and the remote token its mint,
# both as raw 32-byte values. Rate limits off (testnet). Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
PK=$(python3 -c "import json;print(json.load(open('../.demo-keys/sepolia.json'))['privateKey'])")
SOLANA_SELECTOR=16423721717087811551
b58hex() { node -e "const {PublicKey}=require('../node_modules/@solana/web3.js'); console.log('0x'+Buffer.from(new PublicKey('$1').toBytes()).toString('hex'))"; }
for SYM in tUSD tETH tBTC tSOL; do
  POOL=$(python3 -c "import json;print(json.load(open('../deployments/sepolia-tokens.json'))['$SYM']['pool'])")
  read -r MINT CFG < <(python3 -c "import json;d=json.load(open('../deployments/solana-tokens.json'))['$SYM'];print(d['mint'], d['poolConfig'])")
  if [ "$(cast call "$POOL" "isSupportedChain(uint64)(bool)" $SOLANA_SELECTOR --rpc-url "$RPC")" = true ]; then echo "$SYM: lane already configured"; continue; fi
  RPOOL=$(b58hex "$CFG"); RTOKEN=$(b58hex "$MINT")
  cast send "$POOL" "applyChainUpdates(uint64[],(uint64,bytes[],bytes,(bool,uint128,uint128),(bool,uint128,uint128))[])" "[]" \
    "[($SOLANA_SELECTOR,[$RPOOL],$RTOKEN,(false,0,0),(false,0,0))]" \
    --gas-limit 3000000 --gas-price 0.01gwei --priority-gas-price 0.001gwei --rpc-url "$RPC" --private-key "$PK" > /dev/null
  echo "$SYM: pool $POOL -> Solana pool $CFG mint $MINT supported=$(cast call "$POOL" "isSupportedChain(uint64)(bool)" $SOLANA_SELECTOR --rpc-url "$RPC")"
done
