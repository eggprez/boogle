# Boogle

A personal, self-hosted search engine with the Google layout you're used to,
minus Google's AI Overview and plus one written by Claude.

- **Results** come from an unmodified [SearXNG](https://github.com/searxng/searxng)
  container on a private Docker network (web, images, news, videos).
- **AI Overview** streams in above the results on every search. It's generated
  by the Claude Code CLI running inside the container, on your Claude
  subscription, with inline citations that link to the sources.
- **Three sources**, switchable in Settings: *Claude's knowledge* (the
  default: Claude answers from what it knows and cites the results that back
  each point; fastest, best for general questions, can lag on recent events),
  *Snippets* (a few seconds, summarises only the top 10 result snippets) or
  *Read the pages* (10–30 s, fetches and reads the top 5 pages, then answers
  with real detail). A "Read the pages" button on any overview upgrades that
  one query on demand. When SearXNG returns a knowledge panel (a person, place,
  film, …) the overview stays out of the way and the panel answers instead.
- **Follow-up questions**: an "Ask a follow-up" box under every overview
  answers from the same sources, streamed the same way, without a new search.
  Claude also ends each overview with three **"Search next"** suggestions.
- **Model picker** (Haiku / Sonnet / Opus) and an **on-disk overview cache** so
  repeat searches are instant and don't spend quota. The cache key includes a
  hash of the prompt, so editing the prompt never serves stale overviews.
- **Time filter** (past day / week / month / year) on every tab, real
  **favicons** on result cards (proxied and cached, never fetched by your
  browser), page **thumbnails** on web results when an engine supplies one,
  an **image lightbox** with arrow-key browsing, and **inline video
  playback** for results that offer an embed.
- **Keyboard driven**: `/` focuses search, `j`/`k` move through results,
  `Enter` opens, `o` opens in a new tab, `1`–`4` switch tabs, `Esc` clears.
- **Bangs** (`!yt`, `!gh`, `!w`, `!r`, …) and an **OpenSearch descriptor** so
  you can make it your browser's default search engine with suggestions.
- **Auth** is delegated to your existing TinyAuth + NGINX setup: the app trusts
  the `Remote-User` header and never handles a password.
- Light and dark mode, purple accent, single container to build, no database.

```
browser ─► NGINX (TLS, TinyAuth auth_request) ─► boogle:8080 ─► searxng:8080
                                                     │
                                                     └─► claude -p  (Claude Code CLI, subscription)
```

## Layout

```
docker-compose.yml     searxng + boogle services
.env.example           copy to .env and fill in
searxng/settings.yml   SearXNG config (JSON output on, limiter off, autocomplete on)
app/                   the Boogle web app (Node 24 + TypeScript + Hono)
  Dockerfile           builds the app and installs @anthropic-ai/claude-code
  src/server.ts        routes: /, /search, /api/overview (SSE), /api/followup (SSE), /favicon, /suggest, /settings, /opensearch.xml
  src/searxng.ts       SearXNG JSON API client (one retry, time-range filter, 5-minute memo)
  src/rank.ts          re-sorts SearXNG's results by score and caps results per host
  src/favicons.ts      favicon proxy with on-disk cache
  src/overview/        overview pipeline: pick sources → (deep: fetch + Readability) → claude -p → cache
  src/views/           server-rendered HTML
  public/              CSS, client JS (streaming, follow-ups, keyboard nav, lightbox), markdown renderer, favicon
  test/                Vitest unit tests + a stub SearXNG used by the CI smoke test
  scripts/             search-eval.mjs + eval-queries.json: measure engine health and result quality
```

## Deploy on TrueNAS SCALE (prebuilt images, nothing to copy)

Every push to `main` makes GitHub Actions build three images and publish them:

| Image | Contents |
|---|---|
| `ghcr.io/eggprez/boogle` | the web app plus the Claude Code CLI |
| `ghcr.io/eggprez/boogle-searxng` | upstream SearXNG, the Wikidata patch, and `searxng/settings.yml` baked in |
| `ghcr.io/eggprez/boogle-reddit` | Playwright's Chromium plus the Reddit worker (optional, see below) |

So a Docker host only has to pull them. On TrueNAS SCALE 24.10+:

1. **Apps → Discover Apps → ⋮ (top right) → Install via YAML.** Name it `boogle`
   and paste [`truenas/boogle.yaml`](truenas/boogle.yaml). Change the two
   `CHANGE_ME` values: `SEARXNG_SECRET` (any long random string) and
   `PUBLIC_URL` (your NAS address, e.g. `http://192.168.1.50:8081`). Save.
   TrueNAS pulls the images and starts them; give it a minute.
2. **Log the Claude CLI in, once.** Apps → boogle → the `boogle` container →
   Shell. Run `claude`, choose the subscription login, open the URL it prints in
   your normal browser, paste the code back, then type `/exit`. The login is kept
   in the `boogle-claude-home` volume. (Alternative: run `claude setup-token`
   there instead and paste the token into `CLAUDE_CODE_OAUTH_TOKEN` in the YAML.)
3. Open `http://<nas-ip>:8081` and search. The Settings page (gear icon) has a
   status panel showing whether SearXNG, the Claude CLI and the Reddit worker
   are reachable.

Updates: TrueNAS shows an update for the app whenever the `latest` images change
(every push, plus a weekly rebuild that picks up upstream SearXNG and Claude Code
releases). The YAML ships with `AUTH_MODE: none`, which is fine while the port is
only reachable on your LAN; before putting it behind a public hostname switch to
`proxy` and follow the NGINX + TinyAuth section below.

## Deploy with docker compose (any Docker host)

### 1. Get the files onto the server

Clone this repo on the server, e.g. into `/mnt/<pool>/apps/boogle`.

### 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32      # paste as SEARXNG_SECRET
```

Edit `.env`:

| Variable | What to set |
|---|---|
| `SEARXNG_SECRET` | the random hex from above |
| `PUBLIC_URL` | `https://search.example.com` |
| `BIND_ADDRESS` / `BOOGLE_PORT` | where NGINX reaches the app. `127.0.0.1:8081` if NGINX runs on the same host; `0.0.0.0` if NGINX is another container/host (then firewall it). |
| `AUTH_PROXY_SECRET` | optional random string; see NGINX config below |
| `CLAUDE_CODE_OAUTH_TOKEN` | filled in at step 4 |

### 3. Build and start

```bash
docker compose up -d --build
```

### 4. Log the Claude CLI in (one time)

The overview runs `claude -p` inside the `boogle` container. Authenticate it
with your subscription by generating a long-lived token:

```bash
docker compose run --rm boogle claude setup-token
```

Open the printed URL in a browser, approve, paste the code back. Put the
resulting token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`, then:

```bash
docker compose up -d
```

Alternative: run `docker compose run --rm boogle claude`, type `/login`, and
follow the flow. Credentials persist in the `boogle-claude-home` volume and no
token is needed in `.env`.

Check `http://127.0.0.1:8081/api/health` (from the host) or the **Status**
section of the Settings page: SearXNG reachable, Claude CLI version shown.

> **Note on terms.** Your Claude subscription is for your own use. That is why
> the whole site sits behind TinyAuth: don't expose the overview to other people.
> If you ever want to share it, switch the overview to an API key instead.

### 5. NGINX + TinyAuth

Add a server block like this (adjust the TinyAuth internal address to yours):

```nginx
server {
    listen 443 ssl http2;
    server_name search.example.com;
    # ssl_certificate ... / ssl_certificate_key ...

    # --- TinyAuth forward auth -----------------------------------------------
    location /tinyauth {
        internal;
        proxy_pass http://tinyauth:3000/api/auth/nginx;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Uri $request_uri;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location / {
        auth_request /tinyauth;
        auth_request_set $remote_user  $upstream_http_remote_user;
        auth_request_set $remote_email $upstream_http_remote_email;
        auth_request_set $remote_name  $upstream_http_remote_name;
        error_page 401 = @tinyauth_login;

        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Remote-User  $remote_user;
        proxy_set_header Remote-Email $remote_email;
        proxy_set_header Remote-Name  $remote_name;
        # Matches AUTH_PROXY_SECRET in .env (optional but recommended)
        proxy_set_header X-Proxy-Secret "change-me";

        # The AI overview is a Server-Sent Events stream: don't buffer it.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location @tinyauth_login {
        return 302 https://auth.example.com/login?redirect_uri=$scheme://$host$request_uri;
    }
}
```

Two things matter here: the `Remote-User` header must be set from TinyAuth's
response (the app returns 401 without it), and `proxy_buffering off` so the
overview streams instead of arriving all at once when it finishes.

`AUTH_PROXY_SECRET` is defence in depth: if something ever reaches port 8081
directly with a forged `Remote-User`, it is refused unless it also carries the
secret only NGINX knows.

### 6. Make it your browser's default search

- **Firefox**: visit the site, click the search icon (or ⋯) in the address bar,
  choose "Add Boogle". Then Settings → Search → Default Search Engine.
- **Chrome / Chromium**: visit the site once, then `chrome://settings/searchEngines`
  → it appears under "Inactive shortcuts" → make default. Or add manually with
  URL `https://search.example.com/search?q=%s`.
- Suggestions come from `/suggest`, which proxies SearXNG's autocompleter (Google
  by default; change `search.autocomplete` in `searxng/settings.yml`).

## Settings page

`/settings` (the gear icon) has: overview on/off, source (Claude's knowledge,
snippets, or read the pages), model, safe search, language, open-in-new-tab, theme, a status panel,
a cache-clear button, the keyboard shortcuts, and the bang list. Settings are stored per user under
`/data/settings/` in the `boogle-data` volume.

## Environment reference

| Variable | Default | Meaning |
|---|---|---|
| `SITE_NAME` | `Boogle` | logo text and titles |
| `PUBLIC_URL` | `http://localhost:8081` | absolute URL for OpenSearch |
| `ACCENT_COLOR` | `#6d28d9` | brand colour |
| `AUTH_MODE` | `proxy` | `proxy` trusts the user header; `none` disables auth (LAN/dev only) |
| `AUTH_USER_HEADER` | `Remote-User` | header carrying the username |
| `AUTH_PROXY_SECRET` | *(empty)* | if set, requests must carry `X-Proxy-Secret` |
| `ALLOWED_USERS` | *(empty = any)* | comma-separated usernames allowed in |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(empty)* | token from `claude setup-token` |
| `OVERVIEW_TIMEOUT_SECONDS` | `120` | kill a Claude run after this long |
| `OVERVIEW_CACHE_TTL_HOURS` | `168` | how long cached overviews live |
| `MAX_CONCURRENT_OVERVIEWS` | `2` | parallel Claude processes at most |
| `DEEP_READ_PAGES` | `5` | pages read in deep mode |
| `DEEP_READ_CHARS_PER_PAGE` | `6000` | text cap per page in deep mode |
| `SNIPPET_SOURCES` | `10` | results given to Claude in snippet and knowledge mode |
| `REDDIT_WORKER_URL` | `http://reddit:8080` (compose) | the Reddit worker; empty = no Reddit backfill |
| `REDDIT_WEIGHT` | `0.8` | engine weight Reddit threads get when merged into the ranking |

On the `reddit` container:

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_MIN_INTERVAL_MS` | `5000` | minimum gap between two Reddit searches (plus up to 2 s of jitter) |
| `REDDIT_CACHE_TTL_HOURS` | `72` | how long a query's Reddit results are served before being refreshed |
| `REDDIT_MAX_RESULTS` | `20` | threads fetched per query |

## Reliability notes

- SearXNG is tried twice (12 s, then 18 s) before the page shows an error, and
  the error and the "N engines didn't respond" banner both carry a **Retry**
  link that bypasses the 5-minute result memo.
- The overview stream sends a keep-alive comment every 15 s so NGINX and
  browsers keep a quiet deep-mode connection open; if the connection still
  drops, the client reconnects once by itself.
- Sources for the overview are capped at two per site, prefer results that
  more than one engine returned, and in deep mode skip hosts that never yield
  readable text (YouTube, X, Pinterest, PDFs, …) so no fetches are wasted.
- Every push runs the unit tests and a container smoke test (the app image
  against `app/test/stub-searxng.mjs`) before the images are published, so the
  weekly rebuild cannot ship a broken image to TrueNAS.

## How the overview call works

`src/overview/claude.ts` spawns:

```
claude -p --no-session-persistence --tools "" \
       --output-format stream-json --verbose --include-partial-messages \
       --max-turns 1 --model <haiku|sonnet|opus> \
       --system-prompt "<overview instructions>"
```

with the query and numbered sources on stdin (in knowledge mode the results
are labelled as citation targets only, and the prompt tells Claude to answer
from its own knowledge while deferring to a result that is newer than its
training data). Replacing the system prompt and
giving it an empty tool list turns Claude Code into a plain model call; the
`stream-json` output gives token deltas that are forwarded to the browser over
Server-Sent Events and rendered as Markdown with `[n]` citations turned into
links. The prompt tells Claude to treat page text as untrusted data, and the
client-side Markdown renderer escapes everything, so a hostile page can't inject
HTML into your results.

## Local development

```bash
# SearXNG on :8888 (uses the project's settings.yml)
docker run -d --name searxng-dev -p 127.0.0.1:8888:8080 \
  -v "$PWD/searxng:/etc/searxng" -e SEARXNG_SECRET=dev -e SEARXNG_LIMITER=false \
  docker.io/searxng/searxng:latest

cd app && npm install && npm run build
AUTH_MODE=none SEARXNG_URL=http://127.0.0.1:8888 DATA_DIR=/tmp/boogle-data \
  PORT=8081 PUBLIC_URL=http://localhost:8081 node dist/server.js
```

Set `CLAUDE_BIN` to a locally installed `claude` (logged in) to get real
overviews, or to any script that speaks the `stream-json` format for testing.

No SearXNG handy? `node app/test/stub-searxng.mjs` serves canned results on
`:9999`; point `SEARXNG_URL` at it. `npm test` runs the unit tests.

For Reddit results too, build and run the worker and point the app at it:

```bash
docker build -t boogle-reddit:local reddit
docker run -d --name reddit-dev --init -p 127.0.0.1:8898:8080 boogle-reddit:local
# then add REDDIT_WORKER_URL=http://127.0.0.1:8898 to the app's environment
```

`curl 'http://127.0.0.1:8898/results?q=rust+async'` shows a query's state
(`queued`, then `hit` a few seconds later) and `docker logs reddit-dev` one
line per search.

## Search quality: how results are ranked

The app shows SearXNG's merged list, re-sorted once. SearXNG asks every
enabled engine for the tab, dedupes by URL, and scores each page as

```
score = (product of the weights of the engines that returned it)
      × (number of engines that returned it)
      × Σ 1/position, summed over those engines
```

Two things fall out of that formula. Agreement beats weight: a page two
engines both list at position 3 outscores a page only Google lists at
position 1, so the engine mix matters more than the weights. And position
decays fast: rank 1 is worth ten times rank 10.

SearXNG then runs a grouping pass that clusters results by (category,
template, has-thumbnail). In the web tab it pushes every result that carries a
page thumbnail behind up to eight thumbnail-less ones, so a score-5 page
routinely shows up tenth behind score-0.6 pages. `app/src/rank.ts` restores
the score order and applies a soft per-host cap (a site's third and later
results move to the end of the page, like Google's site collapse). Both the
results page and the overview's source picker see the reranked list.

### Engine findings (September 2026)

- **google** (google.com HTML) answers in ~0.4 s and is the ranking to
  imitate, so it carries the top weight. It trips a CAPTCHA under bursts of
  rapid queries, after which SearXNG benches it; `suspended_times` in
  `searxng/settings.yml` is shortened so it comes back within minutes rather
  than an hour. **google cse** is a second Google-derived list, so pages on
  both get the agreement bonus; it runs on the Programmable Search ID that
  every SearXNG install shares, so Google throttles it for everyone at once,
  and whole-web engines of that kind end on 1 January 2027. **google
  images** (google.com's own image results, which upstream ships off) feeds
  the image tab instead of the shared-ID `google cse images`.
- **brave** is the closest independent index to Google (about half of its
  top ten overlaps). **bing** is independent too. **yahoo** returns Bing's
  list (98% overlap) and is left off. **yandex** is independent and overlaps
  Google only ~20%, so it runs at a low weight as a tie-breaker; set
  `disabled: true` on it if you would rather not send queries there.
- **startpage** switched to Bing's index and SearXNG's parser currently
  returns nothing from it, so it is off. **duckduckgo**, **qwant** and
  **mojeek** answer server requests with a CAPTCHA or access-denied page.
- **reddit** inside SearXNG is the PullPush mirror, which rate-limits bursts;
  the Reddit worker (next section) is the source that actually delivers
  threads, merged in at the same low weight. **stackoverflow** is
  off: the Stack Exchange API allows 300 anonymous requests a day per IP, so
  the engine spent most of its time benched, and Google lists the same
  threads.
- The `hostnames` plugin sinks pinterest, facebook and quora to the end of
  the page; add your own patterns there to demote or boost sites.

### Reddit through a headless browser

reddit.com answers server-side requests with HTTP 403, even from a home IP,
its official API wants per-user app credentials, and the archive mirrors
rate-limit. A real browser gets through, but a browser search takes seconds,
so it is kept out of the request path. The `reddit` container
(`reddit/worker.mjs`, on Playwright's Chromium image) works like this:

- The app asks it for every first-page web search: `GET /results?q=…`. The
  worker answers from its on-disk cache at once. A query it has not seen goes
  on a queue, so the **first search for something is thinner and the repeats
  are full**; entries older than `REDDIT_CACHE_TTL_HOURS` are served stale
  and refreshed in the background.
- One headless Chromium with a persistent profile (cookies survive restarts)
  works the queue, one query every `REDDIT_MIN_INTERVAL_MS` plus jitter, and
  only for queries a person actually ran. It tries Reddit's search JSON with
  the browser's cookies first (scores, comment counts, thumbnails), and reads
  the rendered search page if that is refused. A 403 or 429 pauses it for a
  minute, doubling up to 30 minutes, without dropping the queue.
- `app/src/reddit.ts` folds the threads into SearXNG's scored list the way
  SearXNG would have scored an engine called `reddit`: a thread Google or
  Brave already listed gets the agreement bonus, a new one scores like a
  single-engine result at that position (`REDDIT_WEIGHT` ÷ position), and
  the per-host cap keeps all but two Reddit threads at the end of the page.
- The Settings page shows the worker's cache size, queue length and whether
  Reddit has it paused; `/api/health` carries the same under `reddit`. The
  worker's log has one line per search.

It costs about 400 MB of RAM while Chromium is up. To run without it, remove
the `reddit` service and set `REDDIT_WORKER_URL` to an empty value.

### Measuring a change

`app/scripts/search-eval.mjs` runs a query set against a SearXNG instance and
reports numbers instead of impressions:

```bash
cd app && npm run eval -- engines --url http://127.0.0.1:8888
```

shows, per engine, how often it answered, how many results it returned,
latency, and a top-10 overlap matrix that reveals which engines share an
index.

```bash
cd app && npm run eval -- merged --url http://127.0.0.1:8888 --save /tmp/run-a
```

runs the merged search and reports hit@1/3/5 and MRR against the expected
sites in `app/scripts/eval-queries.json`, both in SearXNG's order and after
the app's reranker, plus multi-engine agreement, grouping-pass displacement,
host concentration, latency, and which engines filled the top ten. Save two
runs and `npm run eval -- compare /tmp/run-a /tmp/run-b` prints them side by
side. Queries are paced (`--delay`, default 1.5 s) because every upstream
rate-limits bursts; a fast loop over 35 queries gets Google, Brave, Reddit and
Stack Overflow benched for minutes. Edit the query file to match what you
actually search for.

## Customising

- **Bangs**: edit the table in `app/src/bangs.ts`.
- **Engines**: the `engines:` block in `searxng/settings.yml` is tuned for
  Google-like results: Google weighted highest, then Google CSE, Brave and
  Bing; Google's own image results rather than the shared-ID Programmable
  Search ones; translators, icon libraries, stock photo sites and broken
  video engines are off; every engine is capped at 5 s. Flip `disabled` on any entry to change the mix, then
  measure it with the eval script (see "Search quality" above); SearXNG's
  defaults apply to everything unlisted.
- **DuckDuckGo and Startpage** are off on purpose: DDG answers every
  server-side request with a CAPTCHA and its results are Bing's index anyway,
  and Startpage now serves Bing results that SearXNG's parser cannot read.
  SearXNG upstream periodically repairs engines; to retry one after pulling a
  newer image, set `disabled: false` and check `npm run eval -- engines`.
- **Reddit** blocks direct server requests (403, then 429 on its RSS feeds),
  and SearXNG dropped its Reddit engine. The `reddit` entry in
  `searxng/settings.yml` queries the PullPush archive API, a public mirror
  of Reddit posts ranked by score; the Reddit worker (see "Search quality")
  is the source that actually delivers threads. Reddit's official API needs
  app credentials per user and Google's Programmable Search Engines are now
  capped at 50 sites, so neither is wired in.
- **Wikidata infobox**: `searxng/Dockerfile` builds the upstream image with a
  one-line patch adding Wikidata's `mul` language to the label fallback chain.
  Without it, entities whose name has moved to the language-independent label
  (most of them now) show up as bare Q-ids. Rebuild with
  `docker compose build searxng` after pulling a new upstream image.
- **Prompt**: `SYSTEM_PROMPT` in `app/src/overview/claude.ts`. Cached
  overviews are keyed on a hash of it, so a change takes effect immediately.
- **Result order**: `app/src/rank.ts` (score sort, per-host cap).
- **Overview source picking**: `app/src/overview/sources.ts` (per-host cap,
  hosts skipped in deep mode).
- **Look**: `app/public/style.css`; the accent is the `--accent` variable.
