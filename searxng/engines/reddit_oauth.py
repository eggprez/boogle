# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reddit search through the official API, authenticated as your own app.

Reddit stopped answering anonymous search requests and SearXNG dropped its
Reddit engine. With a free "script" app from https://www.reddit.com/prefs/apps
this engine fetches an app-only token (client-credentials grant), keeps it
until shortly before it expires and searches via oauth.reddit.com. The free
tier allows 100 requests a minute per app.

Credentials come from ``client_id`` / ``client_secret`` in settings.yml or,
preferably, the ``REDDIT_CLIENT_ID`` / ``REDDIT_CLIENT_SECRET`` environment
variables. Without them the engine is simply not loaded.
"""

import base64
import logging
import os
import typing as t
from datetime import datetime, timezone
from urllib.parse import urlencode

from searx.enginelib import EngineCache
from searx.exceptions import (
    SearxEngineAccessDeniedException,
    SearxEngineAPIException,
    SearxEngineTooManyRequestsException,
)
from searx.network import post
from searx.result_types import EngineResults, MainResult

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://www.reddit.com",
    "wikidata_id": "Q1136",
    "official_api_documentation": "https://www.reddit.com/dev/api/#GET_search",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general", "social media"]
paging = False
time_range_support = True
safesearch = False

# Overridable from settings.yml; env vars fill in whatever is left empty.
client_id = ""
client_secret = ""
user_agent = "linux:boogle-searxng:1.0 (personal search engine)"
page_size = 25
sort = "relevance"  # relevance | hot | top | new | comments

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
SEARCH_URL = "https://oauth.reddit.com/search"
TIME_RANGE = {"day": "day", "week": "week", "month": "month", "year": "year"}

logger: logging.Logger = logging.getLogger("searx.engines.reddit")  # replaced by SearXNG's per-engine logger
CACHE: EngineCache


def setup(engine_settings: dict[str, t.Any]) -> bool:
    global CACHE, client_id, client_secret  # pylint: disable=global-statement
    client_id = client_id or os.environ.get("REDDIT_CLIENT_ID", "").strip()
    client_secret = client_secret or os.environ.get("REDDIT_CLIENT_SECRET", "").strip()
    if not (client_id and client_secret):
        logger.info("no Reddit app credentials (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET); engine not loaded")
        return False
    CACHE = EngineCache(engine_settings["name"])
    return True


def _token() -> str:
    token = CACHE.get("token")
    if token:
        return token
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    resp = post(
        TOKEN_URL,
        data={"grant_type": "client_credentials"},
        headers={"Authorization": f"Basic {basic}", "User-Agent": user_agent},
        timeout=10,
        raise_for_httperror=False,
    )
    if resp.status_code in (401, 403):
        # Wrong id/secret: no point retrying every few minutes.
        raise SearxEngineAccessDeniedException(message="reddit: app id/secret rejected", suspended_time=3600)
    if resp.status_code == 429:
        raise SearxEngineTooManyRequestsException(message="reddit: token endpoint rate limited")
    if not resp.ok:
        raise SearxEngineAPIException(f"reddit: token request failed with HTTP {resp.status_code}")
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise SearxEngineAPIException(f"reddit: no access_token in reply ({data.get('error', 'unknown error')})")
    # Renew a couple of minutes early so a token never expires mid-search.
    CACHE.set("token", token, expire=max(60, int(data.get("expires_in", 3600)) - 120))
    return token


def request(query: str, params: "OnlineParams") -> None:
    args = {
        "q": query,
        "limit": page_size,
        "sort": sort,
        "t": TIME_RANGE.get(params["time_range"] or "", "all"),
        "type": "link",
        "raw_json": 1,
    }
    params["url"] = SEARCH_URL + "?" + urlencode(args)
    params["headers"]["Authorization"] = "bearer " + _token()
    params["headers"]["User-Agent"] = user_agent
    # Map the status codes ourselves so an expired token is refreshed rather
    # than suspending the engine.
    params["raise_for_httperror"] = False


def response(resp: "SXNG_Response") -> EngineResults:
    if resp.status_code == 401:
        CACHE.set("token", "", expire=1)
        raise SearxEngineAccessDeniedException(message="reddit: token expired, refreshing", suspended_time=5)
    if resp.status_code == 429:
        raise SearxEngineTooManyRequestsException(message="reddit: API rate limit")
    if resp.status_code == 403:
        raise SearxEngineAccessDeniedException(message="reddit: access denied")
    if not resp.ok:
        raise SearxEngineAPIException(f"reddit: HTTP {resp.status_code}")

    results = EngineResults()
    for child in resp.json().get("data", {}).get("children", []):
        d = child.get("data") or {}
        permalink = d.get("permalink")
        if not permalink:
            continue
        meta = f"{d.get('subreddit_name_prefixed', '')} · {d.get('score', 0)} points · {d.get('num_comments', 0)} comments"
        body = " ".join((d.get("selftext") or "").split())
        if len(body) > 300:
            body = body[:300].rsplit(" ", 1)[0] + "…"
        thumb = d.get("thumbnail") or ""
        if not thumb.startswith("http"):
            thumb = ""
        created = d.get("created_utc")
        results.add(
            MainResult(
                url="https://www.reddit.com" + permalink,
                title=d.get("title", ""),
                content=f"{meta} · {body}" if body else meta,
                thumbnail=thumb,
                publishedDate=datetime.fromtimestamp(created, tz=timezone.utc) if created else None,
            )
        )
    return results
