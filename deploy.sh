#!/usr/bin/env bash
# Push apps-script/ to the Apps Script project and update the live web-app
# deployment in place (the /exec URL never changes).
#
# One-time setup (see README "Deployment"):
#   1. Enable the Apps Script API: https://script.google.com/home/usersettings
#   2. npx -y @google/clasp@2 login
#   3. Put the Script ID in .clasp.json and the web-app deployment ID below.
set -euo pipefail
cd "$(dirname "$0")"

# From: npx -y @google/clasp@2 deployments  (the row marked "@<N> - web app")
DEPLOYMENT_ID="AKfycbxHtqAqLn8EBH3w1cTkbeSkPOTEwA_aE1o7y9GDuum6pNGFzCLb70o1UeLo16OAOBCXxg"

if grep -q PASTE_SCRIPT_ID .clasp.json || [[ "$DEPLOYMENT_ID" == PASTE_* ]]; then
  echo "Setup incomplete: fill in the Script ID (.clasp.json) and DEPLOYMENT_ID (deploy.sh)." >&2
  exit 1
fi

npx -y @google/clasp@2 push
npx -y @google/clasp@2 deploy --deploymentId "$DEPLOYMENT_ID" \
  --description "$(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-60)"
echo "Deployed. The web app URL is unchanged."
