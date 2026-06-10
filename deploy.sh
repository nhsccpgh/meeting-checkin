#!/usr/bin/env bash
# Push apps-script/ to the Apps Script project, update the live web-app
# deployment in place (the /exec URL never changes), then verify the live
# endpoint is actually serving this exact version.
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

HASH=$(git rev-parse --short HEAD)
git diff --quiet apps-script/Code.gs || \
  echo "warning: Code.gs has uncommitted changes — deploying them tagged as $HASH anyway" >&2

# Bake the commit hash into the deployed copy so the post-deploy check can
# prove the live endpoint serves this version. The local file is restored
# afterward no matter how the deploy exits.
BACKUP=$(mktemp)
cp apps-script/Code.gs "$BACKUP"
trap 'mv "$BACKUP" apps-script/Code.gs' EXIT
perl -pi -e "s/^const DEPLOY_VERSION = .*/const DEPLOY_VERSION = '$HASH';/" apps-script/Code.gs

npx -y @google/clasp@2 push
npx -y @google/clasp@2 deploy --deploymentId "$DEPLOYMENT_ID" \
  --description "$HASH $(git log -1 --format=%s | cut -c1-60)"

# Verify the live /exec URL reports the hash we just baked in. Retries cover
# the few seconds a new version can take to start serving.
EXEC_URL="https://script.google.com/macros/s/$DEPLOYMENT_ID/exec"
for attempt in 1 2 3 4 5; do
  LIVE=$(curl -sL "$EXEC_URL?action=version" || true)
  if [[ "$LIVE" == *"\"version\":\"$HASH\""* ]]; then
    echo "Verified: live web app is serving $HASH. URL unchanged."
    exit 0
  fi
  sleep 3
done

echo "DEPLOY NOT VERIFIED: live endpoint never reported $HASH (last response: ${LIVE:-none})." >&2
echo "The /exec URL may be pinned to a different deployment — check 'Manage deployments'." >&2
exit 1
