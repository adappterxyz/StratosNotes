#!/usr/bin/env bash
# Live demo until the keeper is deployed to the DON: run the CRE keeper in
# Chainlink's simulator every minute, broadcasting its reports to devnet
# through Chainlink's simulator forwarder. Needs cre/.env (see .env.example)
# and a `cre login`. Stop with Ctrl-C.
set -u
cd "$(dirname "$0")/../cre"
INTERVAL=${INTERVAL:-60}
while true; do
  start=$(date +%s)
  echo "=== $(date -u +%FT%TZ)"
  timeout 300 cre workflow simulate ./notes-keeper --target simulation-settings --trigger-index 0 --non-interactive --broadcast 2>&1 \
    | grep -E "USER LOG|\"\{|✗" || echo "(no output)"
  sleep $(( INTERVAL - ( $(date +%s) - start ) > 5 ? INTERVAL - ( $(date +%s) - start ) : 5 ))
done
