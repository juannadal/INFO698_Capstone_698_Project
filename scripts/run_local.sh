#!/bin/bash
# Runs the whole app on this Mac with one command, at one address: http://localhost:8787
# (the page and the API together, from one wrangler dev).
#
#   ./scripts/run_local.sh        from the repo folder; press Ctrl+C to stop
#
# What it does, and why:
#   1. Builds the web page (web/dist), so wrangler serves the latest page with every menu. Without this, 8787 shows
#      whatever page was built last, which may be missing new features.
#   2. Makes sure the Claude key is in worker/.dev.vars (gitignored, never committed), read from 1Password, so the
#      "Answer written by" menu can offer Claude; the same for the Grok key. If 1Password is locked or has no key, it
#      carries on without that model.
#   3. Starts wrangler dev, which uses the real database, search index and Workers AI (nothing is deployed).
set -e
cd "$(dirname "$0")/.."

echo "1/3 Building the web page..."
(cd web && npm install --silent && npm run build --silent)

echo "2/3 Checking the Claude and Grok keys..."
cd worker
npm install --silent
touch .dev.vars
# Drop an empty ANTHROPIC_API_KEY= line (left by a key read that failed), so it never hides the real key.
sed -i '' '/^ANTHROPIC_API_KEY=$/d' .dev.vars
if grep -q '^ANTHROPIC_API_KEY=.' .dev.vars; then
  echo "    Claude key found."
elif key=$(op read 'op://Claude/Anthropic API key/credential' 2>/dev/null) && [ -n "$key" ]; then
  echo "ANTHROPIC_API_KEY=$key" >> .dev.vars
  unset key
  echo "    Claude key added from 1Password."
else
  echo "    No Claude key (1Password locked, or no 'Anthropic API key' item). Running without Claude."
fi
# The Grok key, the same way. The item is found by name: the first item in the Claude vault whose title has "grok" or
# "xai" in it, and its "credential" (API Credential items) or "password" field. Each lookup ends in "|| true": the
# script runs with set -e, and a locked 1Password must only skip Grok, never stop the script.
sed -i '' '/^XAI_API_KEY=$/d' .dev.vars
if grep -q '^XAI_API_KEY=.' .dev.vars; then
  echo "    Grok key found."
else
  item=$(op item list --vault Claude --format json 2>/dev/null \
    | python3 -c 'import json,sys; print(next((i["id"] for i in json.load(sys.stdin) if any(w in i["title"].lower() for w in ("grok","xai","x.ai"))), ""))' 2>/dev/null || true)
  key=""
  if [ -n "$item" ]; then
    key=$(op read "op://Claude/$item/credential" 2>/dev/null || op read "op://Claude/$item/password" 2>/dev/null || true)
  fi
  if [ -n "$key" ]; then
    echo "XAI_API_KEY=$key" >> .dev.vars
    echo "    Grok key added from 1Password."
  else
    echo "    No Grok key (1Password locked, or no item named Grok/xAI in the Claude vault). Running without Grok."
  fi
  unset key item
fi

echo "3/3 Starting the app. Open http://localhost:8787 (Ctrl+C to stop)."
npx wrangler dev --name aler-dev
