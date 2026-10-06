#!/usr/bin/env bash
# End-to-end: every structured product, issued and run on a local Solana
# validator with the engine + a mock keystone forwarder, investor payouts
# checked against the reference payoff.
set -euo pipefail
cd "$(dirname "$0")/.."
ENGINE=$(solana-keygen pubkey solana/target/deploy/flow_engine-keypair.json)
MOCK=$(solana-keygen pubkey solana/target/deploy/mock_forwarder-keypair.json)
LEDGER=$(mktemp -d)
PORT=${E2E_RPC_PORT:-8999}
solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port "$PORT" --faucet-port $((PORT + 2)) \
  --bpf-program "$ENGINE" solana/target/deploy/flow_engine.so \
  --bpf-program "$MOCK" solana/target/deploy/mock_forwarder.so > "$LEDGER/validator.out" 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null; rm -rf "$LEDGER"' EXIT
for _ in $(seq 1 60); do
  curl -s -X POST "http://127.0.0.1:$PORT" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"' && break
  sleep 1
done
cd packages/flow
E2E_RPC="http://127.0.0.1:$PORT" npx vitest run test/products.e2e.test.ts --testTimeout=600000 "$@"
