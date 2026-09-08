#!/bin/sh
# Boogle: apply per-deploy credentials from the environment to the baked-in
# settings.yml, then hand over to SearXNG's own entrypoint.
#
#   GOOGLE_CSE_ID         your Programmable Search Engine ID; without it the
#                         "google cse" engines use SearXNG's shared public one
#   REDDIT_CLIENT_ID      Reddit app credentials; with both set, the official
#   REDDIT_CLIENT_SECRET  API engine runs and the pullpush.io fallback is off
#
# The rendered copy lives in /tmp so a bind-mounted settings.yml (the local
# docker-compose setup) is never modified in place.
set -eu

src="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"
out="/tmp/settings.yml"
cp "$src" "$out"

if [ -n "${GOOGLE_CSE_ID:-}" ]; then
    sed -i "s|__GOOGLE_CSE_ID__|${GOOGLE_CSE_ID}|g" "$out"
    echo "boogle: google cse uses your own search engine ID"
else
    sed -i '/__GOOGLE_CSE_ID__/d' "$out"
    echo "boogle: GOOGLE_CSE_ID not set, google cse uses SearXNG's shared ID"
fi

if [ -n "${REDDIT_CLIENT_ID:-}" ] && [ -n "${REDDIT_CLIENT_SECRET:-}" ]; then
    sed -i 's|^\([[:space:]]*disabled:[[:space:]]*\)false\([[:space:]]*# boogle:reddit-fallback\)|\1true\2|' "$out"
    echo "boogle: reddit uses the official API with your app credentials"
else
    echo "boogle: REDDIT_CLIENT_ID/SECRET not set, reddit uses the pullpush.io archive"
fi

export SEARXNG_SETTINGS_PATH="$out"
exec /usr/local/searxng/entrypoint.sh "$@"
