# Boogle

A personal, self-hosted search engine with the Google layout you're used to,
minus Google's AI Overview and plus one written by Claude.

- **Results** come from an unmodified [SearXNG](https://github.com/searxng/searxng)
  container on a private Docker network (web, images, news, videos).
- **AI Overview** streams in above the results on every search. It's generated
  by the Claude Code CLI running inside the container, on your Claude
  subscription, with inline citations that link to the sources.
- **Two depths**, switchable in Settings: *Snippets* (fast, a few seconds,
  summarises the top 10 result snippets) or *Read the pages* (10–30 s, fetches
  and reads the top 5 pages, then answers with real detail). A "Read the pages"
  button on any overview upgrades that one query on demand.
- **Model picker** (Haiku / Sonnet / Opus) and an **on-disk overview cache** so
  repeat searches are instant and don't spend quota.
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
  src/server.ts        routes: /, /search, /api/overview (SSE), /suggest, /settings, /opensearch.xml
  src/searxng.ts       SearXNG JSON API client
  src/overview/        overview pipeline: pick sources → (deep: fetch + Readability) → claude -p → cache
  src/views/           server-rendered HTML
  public/              CSS, client JS (streaming + autocomplete + markdown), favicon
```

## Deploy on TrueNAS SCALE (prebuilt images, nothing to copy)

Every push to `main` makes GitHub Actions build two images and publish them:

| Image | Contents |
|---|---|
| `ghcr.io/eggprez/boogle` | the web app plus the Claude Code CLI |
| `ghcr.io/eggprez/boogle-searxng` | upstream SearXNG, the Wikidata patch, and `searxng/settings.yml` baked in |

So a Docker host only has to pull them. On TrueNAS SCALE 24.10+:

1. **Apps → Discover Apps → ⋮ (top right) → Install via YAML.** Name it `boogle`
   and paste [`truenas/boogle.yaml`](truenas/boogle.yaml). Change the two
   `CHANGE_ME` values: `SEARXNG_SECRET` (any long random string) and
   `PUBLIC_URL` (your NAS address, e.g. `http://192.168.1.50:8081`). Save.
   TrueNAS pulls both images and starts them; give it a minute.
2. **Log the Claude CLI in, once.** Apps → boogle → the `boogle` container →
   Shell. Run `claude`, choose the subscription login, open the URL it prints in
   your normal browser, paste the code back, then type `/exit`. The login is kept
   in the `boogle-claude-home` volume. (Alternative: run `claude setup-token`
   there instead and paste the token into `CLAUDE_CODE_OAUTH_TOKEN` in the YAML.)
3. Open `http://<nas-ip>:8081` and search. The Settings page (gear icon) has a
   status panel showing whether SearXNG and the Claude CLI are reachable.

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

`/settings` (the gear icon) has: overview on/off, depth (snippets vs read the
pages), model, safe search, language, open-in-new-tab, theme, a status panel,
a cache-clear button, and the bang list. Settings are stored per user under
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
| `SNIPPET_SOURCES` | `10` | results given to Claude in snippet mode |

## How the overview call works

`src/overview/claude.ts` spawns:

```
claude -p --bare --no-session-persistence --tools "" \
       --output-format stream-json --verbose --include-partial-messages \
       --max-turns 1 --model <haiku|sonnet|opus> \
       --system-prompt "<overview instructions>"
```

with the query and numbered sources on stdin. Replacing the system prompt and
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

## Customising

- **Bangs**: edit the table in `app/src/bangs.ts`.
- **Engines**: the `engines:` block in `searxng/settings.yml` is tuned for
  Google-like results: Google CSE weighted highest, then Startpage, Brave and
  Bing, plus Stack Overflow and Reddit in web results; translators, icon
  libraries, stock photo sites and broken video engines are off; every engine
  is capped at 5 s. Flip `disabled` on any entry to change the mix; SearXNG's
  defaults apply to everything unlisted.
- **DuckDuckGo** is off on purpose: its HTML endpoint answers every
  server-side request with a CAPTCHA, and its results are Bing's index anyway,
  so Bing is enabled directly instead. SearXNG upstream periodically repairs
  the DDG engine; if you want to retry it after pulling a newer image, set
  `disabled: false` on `duckduckgo` and watch the Status page.
- **Reddit** blocks direct server requests (403, then 429 on its RSS feeds),
  and SearXNG dropped its Reddit engine. The `reddit` entry therefore queries
  the PullPush archive API, a public mirror of Reddit posts ranked by score.
  For the best Reddit results, create a free Google Programmable Search Engine
  limited to reddit.com and enable the commented `reddit via google` entry
  with its ID.
- **Wikidata infobox**: `searxng/Dockerfile` builds the upstream image with a
  one-line patch adding Wikidata's `mul` language to the label fallback chain.
  Without it, entities whose name has moved to the language-independent label
  (most of them now) show up as bare Q-ids. Rebuild with
  `docker compose build searxng` after pulling a new upstream image.
- **Prompt**: `SYSTEM_PROMPT` in `app/src/overview/claude.ts`.
- **Look**: `app/public/style.css`; the accent is the `--accent` variable.
