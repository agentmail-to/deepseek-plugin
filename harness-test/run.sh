#!/usr/bin/env bash
# Boot this plugin inside a real Cordis/harness composition.
#   AGENTMAIL_API_KEY=... AGENTMAIL_INBOX_ID=you@agentmail.to ./run.sh [tools|agents]
set -euo pipefail
cd "$(dirname "$0")"
: "${AGENTMAIL_API_KEY:?set AGENTMAIL_API_KEY}"
: "${AGENTMAIL_INBOX_ID:?set AGENTMAIL_INBOX_ID}"
scenario="${1:-tools}"
cp "cordis.${scenario}.yml" cordis.yml
node --import tsx ../node_modules/@deepseek-ai/cordis/bin.js
