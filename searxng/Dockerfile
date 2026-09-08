# SearXNG with one fix on top of the upstream image.
#
# Wikidata has been moving language-independent labels (names like "Rust" or
# "Albert Einstein") from per-language labels to the special "mul" language.
# SearXNG's SPARQL template asks the label service for "<lang>,en" only, so
# entities without an explicit English label come back as bare Q-ids
# ("Q575650") in the infobox title and attribute values. Adding "mul" to the
# fallback chain resolves them. If upstream has fixed this, the sed is a no-op.
FROM docker.io/searxng/searxng:latest

USER root
# The image ships precompiled bytecode with unchecked hashes, so editing the
# .py alone is ignored at import time: drop the stale .pyc and recompile.
RUN f=/usr/local/searxng/searx/wikidata_properties.py \
 && sed -i 's/wikibase:language "%LANGUAGE%,en"\./wikibase:language "%LANGUAGE%,en,mul"./' "$f" \
 && grep -q '"%LANGUAGE%,en,mul"' "$f" \
 && rm -f /usr/local/searxng/searx/__pycache__/wikidata_properties.*.pyc \
 && /usr/local/searxng/.venv/bin/python -m compileall -q --invalidation-mode unchecked-hash "$f" \
 && echo "wikidata label fallback patched"

# Bake Boogle's settings.yml into the image so it runs with no host files
# (TrueNAS "Install via YAML" deploys). A bind mount on /etc/searxng, as the
# local docker-compose.yml does, still overrides it.
RUN mkdir -p /etc/searxng && chown searxng:searxng /etc/searxng
COPY --chown=searxng:searxng settings.yml /etc/searxng/settings.yml

# Reddit through the official API (needs your own app credentials; see
# engines/reddit_oauth.py and the README).
COPY --chown=searxng:searxng engines/reddit_oauth.py /usr/local/searxng/searx/engines/reddit_oauth.py

# Fill GOOGLE_CSE_ID / REDDIT_CLIENT_* from the environment into settings.yml
# at start, then run SearXNG's own entrypoint.
COPY entrypoint.sh /usr/local/searxng/boogle-entrypoint.sh
RUN chmod 755 /usr/local/searxng/boogle-entrypoint.sh
USER searxng
ENTRYPOINT ["/usr/local/searxng/boogle-entrypoint.sh"]
