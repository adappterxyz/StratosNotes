#!/usr/bin/env bash
# Sepolia side of the StratosNotes cross-chain tokens (CCIP burn-mint CCTs):
# for each token a BurnMintERC20 + BurnMintTokenPool, mint/burn roles for the
# pool (and the deployer, as the test faucet), CCIP admin claimed and the pool
# registered in the TokenAdminRegistry. Idempotent: reuses what
# ../deployments/sepolia-tokens.json already records.
#
# Gas limits are explicit: Sepolia prices contract code far above what local
# simulation assumes (a pool deployment costs ~22M gas).
set -euo pipefail
cd "$(dirname "$0")"
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
PK=$(python3 -c "import json;print(json.load(open('../.demo-keys/sepolia.json'))['privateKey'])")
ME=$(cast wallet address --private-key "$PK")
ROUTER=0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59
RMN=0xba3f6251de62dED61Ff98590cB2fDf6871FbB991
MODULE=0xa3c796d480638d7476792230da1E2ADa86e031b0
REGISTRY=0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82
OUT=../deployments/sepolia-tokens.json
GAS=(--gas-price 0.01gwei --priority-gas-price 0.001gwei --rpc-url "$RPC" --private-key "$PK")
[ -f "$OUT" ] || echo '{}' > "$OUT"
art() { python3 -c "import json;print(json.load(open('out/$1.sol/$1.json'))['bytecode']['object'])"; }
get() { python3 -c "import json;print(json.load(open('$OUT')).get('$1',{}).get('$2',''))"; }
put() { python3 -c "import json;d=json.load(open('$OUT'));d.setdefault('$1',{})['$2']='$3' if '$2'!='decimals' else int('$3');json.dump(d,open('$OUT','w'),indent=2)"; }
create() { cast send "${GAS[@]}" --gas-limit "$1" --json --create "$2" | python3 -c "import json,sys;j=json.load(sys.stdin);assert j['status']=='0x1',j;print(j['contractAddress'])"; }
call() { cast send "${GAS[@]}" --gas-limit 2000000 "$@" > /dev/null; }

for spec in "tUSD:StratosNotes Test USD:6" "tETH:StratosNotes Test ETH:18" "tBTC:StratosNotes Test BTC:8" "tSOL:StratosNotes Test SOL:9"; do
  IFS=: read -r SYM NAME DEC <<< "$spec"
  TOKEN=$(get "$SYM" token); POOL=$(get "$SYM" pool)
  if [ -z "$TOKEN" ]; then
    ARGS=$(cast abi-encode "c(string,string,uint8,uint256,uint256)" "$NAME" "$SYM" "$DEC" 0 0)
    TOKEN=$(create 12000000 "$(art BurnMintERC20)${ARGS:2}"); put "$SYM" token "$TOKEN"; put "$SYM" decimals "$DEC"
  fi
  if [ -z "$POOL" ]; then
    ARGS=$(cast abi-encode "c(address,uint8,address[],address,address)" "$TOKEN" "$DEC" "[]" "$RMN" "$ROUTER")
    POOL=$(create 26000000 "$(art BurnMintTokenPool)${ARGS:2}"); put "$SYM" pool "$POOL"
  fi
  MINTER=$(cast call "$TOKEN" "getRoleMember(bytes32,uint256)(address)" "$(cast keccak MINTER_ROLE)" 0 --rpc-url "$RPC" 2>/dev/null || true)
  if [ "$(cast call "$TOKEN" "hasRole(bytes32,address)(bool)" "$(cast keccak MINTER_ROLE)" "$POOL" --rpc-url "$RPC")" != true ]; then call "$TOKEN" "grantMintAndBurnRoles(address)" "$POOL"; fi
  if [ "$(cast call "$TOKEN" "hasRole(bytes32,address)(bool)" "$(cast keccak MINTER_ROLE)" "$ME" --rpc-url "$RPC")" != true ]; then call "$TOKEN" "grantMintAndBurnRoles(address)" "$ME"; fi
  CFG=$(cast call "$REGISTRY" "getTokenConfig(address)((address,address,address))" "$TOKEN" --rpc-url "$RPC")
  ADMIN=$(echo "$CFG" | tr -d '() ' | cut -d, -f1); PENDING=$(echo "$CFG" | tr -d '() ' | cut -d, -f2); SETPOOL=$(echo "$CFG" | tr -d '() ' | cut -d, -f3)
  if [ "${ADMIN,,}" != "${ME,,}" ]; then
    [ "${PENDING,,}" = "${ME,,}" ] || call "$MODULE" "registerAdminViaGetCCIPAdmin(address)" "$TOKEN"
    call "$REGISTRY" "acceptAdminRole(address)" "$TOKEN"
  fi
  [ "${SETPOOL,,}" = "${POOL,,}" ] || call "$REGISTRY" "setPool(address,address)" "$TOKEN" "$POOL"
  echo "$SYM token $TOKEN pool $POOL registry $(cast call "$REGISTRY" "getTokenConfig(address)((address,address,address))" "$TOKEN" --rpc-url "$RPC")"
done
