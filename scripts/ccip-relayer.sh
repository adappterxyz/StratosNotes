#!/usr/bin/env bash
# CCIP relayer for the engine: re-executes Sepolia -> Solana messages that
# Chainlink's executor marked failed.
#
# Why: a programmable token transfer to the engine (tokens + a subscribe call)
# does not fit the CCIP offramp's 32 KiB heap on the DON's execute path (the
# signed-report verification takes the room); the same message succeeds as a
# manual execution. Manual execution is permissionless for failed messages, so
# this loop finds them and runs `ccip-cli manualExec` (Node 24) with the payer
# key. Run it next to the keeper:
#   pm2 start scripts/ccip-relayer.sh --name stratosnotes-ccip-relayer --interpreter bash
set -u
cd "$(dirname "$0")/.."
RPC_SEPOLIA=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
RPC_SOLANA=${SOLANA_RPC:-https://api.devnet.solana.com}
ONRAMP=${ONRAMP:-0x23a5084fa78104f3df11c63ae59fcac4f6ad9dee}   # Sepolia -> Solana devnet
ENGINE=9a5xpgRgK7NQMVtYvLuVq1XooK3Ca4CrKVkFEnVRGaHx
DEST=$(printf '0x%064x' 16423721717087811551)
STATE=${RELAYER_STATE:-.ccip-relayer}
LOOKBACK=${LOOKBACK_BLOCKS:-1500}   # ~5 h of Sepolia blocks
INTERVAL=${INTERVAL:-120}
mkdir -p "$STATE"
KEY_B58=$(python3 -c "
import json, os
B='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
b=bytes(json.load(open(os.path.expanduser(os.environ.get('ANCHOR_WALLET','~/.config/solana/id.json'))))); n=int.from_bytes(b,'big'); o=''
while n: n,r=divmod(n,58); o=B[r]+o
print('1'*(len(b)-len(b.lstrip(b'\0')))+o)")

while true; do
  NOW=$(cast block-number --rpc-url "$RPC_SEPOLIA" 2>/dev/null || echo 0)
  if [ "$NOW" -gt 0 ]; then
    FROM=$(printf '0x%x' $(( NOW - LOOKBACK )))
    IDS=$(curl -s "$RPC_SEPOLIA" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"address\":\"$ONRAMP\",\"fromBlock\":\"$FROM\",\"toBlock\":\"latest\",\"topics\":[null,\"$DEST\"]}]}" \
      | python3 -c "import json,sys
for l in (json.load(sys.stdin).get('result') or []): print('0x'+l['data'][2+64:2+128])" 2>/dev/null)
    for MID in $IDS; do
      [ -f "$STATE/$MID.done" ] && continue
      J=$(curl -s "https://ccip.chain.link/api/h/atlas/message/$MID")
      RECV=$(echo "$J" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('receiver') or '')
except Exception: print('')")
      ST=$(echo "$J" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('state'))
except Exception: print('None')")
      if [ "$RECV" != "$ENGINE" ] || [ "$ST" = "2" ]; then touch "$STATE/$MID.done"; continue; fi
      if [ "$ST" = "3" ]; then
        echo "=== $(date -u +%FT%TZ) $MID failed on the DON executor: manual execution"
        if USER_KEY="$KEY_B58" timeout 900 npx -y -p node@24 -p @chainlink/ccip-cli@1.15.0 -- ccip-cli manualExec "$MID" \
             --rpcs "$RPC_SEPOLIA" "$RPC_SOLANA" --no-interactive -f json > "$STATE/$MID.log" 2>&1; then
          echo "    executed"; touch "$STATE/$MID.done"
        else
          echo "    manual execution failed (see $STATE/$MID.log); will retry"
        fi
      fi
    done
  fi
  sleep "$INTERVAL"
done
