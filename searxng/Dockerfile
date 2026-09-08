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
USER searxng
