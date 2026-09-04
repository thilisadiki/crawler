# OmniCrawl

OmniCrawl is a browser-based SEO crawler for auditing server-rendered and JavaScript-rendered websites. It renders pages in Chromium where possible, extracts SEO metadata and content, discovers links, checks link status codes, and exports the audit as CSV or a multi-sheet Excel workbook.

The dashboard is designed for on-demand audits. Each browser tab receives its own crawl session, results, controls, real-time updates, and exports.

## Contents

- [Capabilities](#capabilities)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Using the dashboard](#using-the-dashboard)
- [Crawl behavior](#crawl-behavior)
- [Concurrent users and shared Chromium](#concurrent-users-and-shared-chromium)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Exports](#exports)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Operational limits and security](#operational-limits-and-security)
- [Development and testing](#development-and-testing)

## Capabilities

- Renders dynamic sites with Chromium before extracting content.
- Falls back to direct HTML parsing when Chromium cannot be started or a single page cannot be rendered.
- Extracts page title, meta description, canonical URL, robots directives, Open Graph metadata, H1–H3 headings, word count, image count, full page text, and links.
- Detects a custom content area using a supplied CSS selector or a built-in SEO-content selector list.
- Crawls by URL scope, depth, page limit, inclusion/exclusion rules, and optional `robots.txt` rules.
- Classifies internal, external, nofollow, mailto, tel, anchor/script, and invalid links.
- Checks link status codes with bounded parallel `HEAD`/`GET` requests.
- Supports geography presets, an optional proxy, auto-scrolling, and redirect guard settings.
- Shows real-time progress through Server-Sent Events (SSE), with polling as a fallback.
- Exports pages, links, and content-area data as CSV or an Excel workbook with a summary, link inventory, and one sheet per crawled page.
- Supports multiple simultaneous user sessions while keeping crawl state isolated per browser tab.
- Persists crawl runs, page results, links, and extracted text to MySQL when database credentials are configured.
- Paginates large result sets (100 page/link rows and 10 text cards by default) so 1,000+ page audits stay responsive.
- Includes public About, Privacy, Terms, and Acceptable Use pages linked from the dashboard footer.

## Architecture

```text
Browser tab
  └─ tab-specific session ID (sessionStorage)
       ├─ Dashboard UI + SSE stream
       └─ REST API requests with ?sessionId=...

Express server
  ├─ In-memory session map
  │    └─ one SiteCrawler and result set per tab session
  ├─ global crawl-capacity limiter
  └─ shared Chromium process on Hostinger Linux
       └─ isolated browser context per active crawl
            └─ page contexts are closed after DOM extraction
```

### Main components

| Component | Responsibility |
| --- | --- |
| `server.js` | Express server, tab-session isolation, SSE, API, export routes, capacity limits |
| `src/engine/crawler.js` | Crawl queue, URL filtering, rendering/fallback logic, extraction flow, statistics |
| `src/engine/browser.js` | Playwright/Sparticuz Chromium startup, shared browser lifecycle, per-crawl contexts |
| `src/engine/extractor.js` | DOM and direct-HTML metadata, content, and link extraction |
| `src/engine/statusChecker.js` | Bounded link status verification |
| `src/engine/robots.js` | `robots.txt` parser and origin fetcher |
| `src/engine/geoPresets.js` | Regional browser locale, timezone, coordinates, and request-header presets |
| `src/engine/exporter.js` | CSV and XLSX report generation |
| `src/storage/database.js` | Optional MySQL schema, persistence, and saved-crawl retrieval |
| `src/public/` | Dashboard HTML, JavaScript, and styles |

## Quick start

### Prerequisites

- Node.js 22.17.0 or later
- npm
- A Chromium browser available to Playwright for local browser-rendering tests

### Install and run

```bash
npm ci
npm start
```

Open `http://localhost:3000`.

For automatic restart during development:

```bash
npm run dev
```

### Local Chromium

On macOS or Windows, if the app reports that no local Chromium executable is available, install a compatible Playwright Chromium build:

```bash
npx playwright install chromium
```

On Linux, OmniCrawl prefers `@sparticuz/chromium`, which is intended for environments where desktop GTK libraries cannot be installed.

## Using the dashboard

1. Enter a seed URL, including `https://` if possible.
2. Choose a crawl scope.
3. Set page, depth, and worker limits.
4. Optionally open **Advanced Directives & Exclusions** and configure selectors, geo settings, proxy, `robots.txt`, or URL rules.
5. Select **Execute Crawl**.
6. Inspect the Pages, Discovered Links, and Extracted Content Area Text views.
7. Use the export buttons after pages have been collected.

### Crawl scope

| Scope | Behavior |
| --- | --- |
| `single-url` | Audit only the seed URL. Depth and page limit are forced to 0 and 1. |
| `subpath` | Crawl URLs on the same host whose paths begin at the seed URL's path. |
| `domain` | Crawl URLs on the same hostname as the seed URL. |
| `subdomains` | Crawl the root domain and matching subdomains. |

### Advanced directives

| Setting | Effect |
| --- | --- |
| Custom content selector | Uses the supplied CSS selector as the content area to audit. |
| Exclude patterns | One JavaScript regular expression per line; matching URLs are not queued. |
| Include patterns | When provided, a URL must match at least one expression to be queued. |
| Respect `robots.txt` | Prevents queued URLs disallowed by the target origin's `robots.txt`. |
| Auto-scroll | Scrolls the page after hydration to trigger lazy-loaded sections. |
| Region | Selects browser locale, timezone, coordinates, and request-header hints. `auto` derives a preset from familiar country TLDs. |
| Proxy | Uses the supplied proxy for the browser context. Use a real regional proxy when the target uses source-IP geolocation. |
| Block cross-domain redirects | Warns when the main frame moves away from the intended hostname. |

### Content area detection

If no custom selector is supplied, OmniCrawl looks for these common content containers in order:

```text
.page-text
[class*="page-text"]
.seo-content
[class*="seo-content"]
[class*="seo_content"]
[class*="seoText"]
[class*="seo-text"]
[class*="kentico"]
#content
#seo-content
#seo-text
.seo-section
.bottom-seo
[data-seo-content]
.copy-section
[class*="copy-section"]
.content-block
[class*="content-block"]
.mainBlock
[class*="main-block"]
[class*="mainBlock"]
article
```

If no known selector matches, OmniCrawl applies a conservative content-area heuristic. It selects a visible, text-rich container with headings or structured copy and low link density, while excluding navigation, cookie banners, sidebars, betting widgets, and footers. Heuristic matches are shown as **Auto-found** in the table and **Content Area Auto-detected** in the inspector.

For a reliable content-area audit, provide the site's exact selector rather than relying on auto-detection. A custom selector overrides automatic detection for the entire crawl.

## Crawl behavior

### Rendering flow

For each page, OmniCrawl:

1. Opens an isolated browser context and page.
2. Navigates with `DOMContentLoaded` as the primary wait condition.
3. Waits for client hydration, then optionally auto-scrolls.
4. Extracts the rendered DOM, metadata, full text, content area, and all anchor links.
5. Releases the page context before checking discovered link status codes.
6. Queues eligible internal links within the configured scope and depth.

The crawler blocks images, media, fonts, analytics, and selected non-essential third-party requests during browser rendering to reduce memory use. The DOM still contains image elements, so the image count remains available.

### Browser recovery and fallback

If Chromium disconnects while a page is rendering, the crawler restarts it and retries that URL once. A failure on one page does **not** downgrade the entire audit. If retrying still fails, only that page uses the direct HTML parser and is marked with:

- `renderMode: "direct-dom-fallback"`
- a page-level error explaining that client-rendered content may be absent

If Chromium cannot launch at all, the crawl uses the direct DOM engine for the session. This is useful for server-rendered pages but cannot reliably extract client-only content from SPAs.

### Link verification

Every extracted HTTP(S) link is checked with `HEAD`, falling back to `GET` when necessary. Link verification is intentionally bounded by the configured concurrency and page deadline so slow or rate-limited targets do not stall an audit forever. Links not reached before the deadline can have no verified status code.

## Concurrent users and shared Chromium

### Session isolation

The dashboard creates a random session ID in `sessionStorage`. That identifier is added to API and SSE requests. The server stores each session's crawler independently, so users do not see or control another user's crawl, results, pause state, reset action, or exports.

- A refresh reconnects to the same browser-tab session.
- Opening a new ordinary browser tab starts a new session.
- Finished sessions are retained in memory for up to six hours and are also capped at 25 retained sessions.
- A server restart or deployment clears all in-memory sessions and results.

### Shared browser lifecycle

On Hostinger Linux, active crawls share one `@sparticuz/chromium` parent process. Each crawler gets a dedicated Playwright browser context, which isolates cookies, storage, headers, permissions, proxy settings, and pages.

The first active crawl launches Chromium. Additional crawls acquire a lease on the same browser. When a crawl completes, its context and lease are released; Chromium closes only after the final active lease is released. This avoids launching a separate heavyweight Chromium process per user.

### Capacity limits

By default, the app permits three simultaneous crawls with one browser worker each. When all slots are occupied, `POST /api/crawler/start` returns HTTP `429` and the dashboard shows the capacity state.

The limits are controlled by environment variables described below. Raise them gradually after observing memory, CPU, latency, browser restart counts, and target-site rate limiting.

## Configuration

All configuration is optional. The defaults are suitable for a small Hostinger Cloud deployment.

| Variable | Default | Allowed range | Purpose |
| --- | ---: | ---: | --- |
| `PORT` | `3000` | — | Express listen port. Hostinger supplies this automatically. |
| `CHROMIUM_ENGINE` | `sparticuz` on Linux, `playwright` elsewhere | `sparticuz`, `sparticuz-only`, `playwright` | Select browser engine. Use `sparticuz-only` on Hostinger. |
| `CHROMIUM_SINGLE_PROCESS` | `false` | `true` / `false` | Re-enables Chromium single-process mode. Leave disabled because it makes renderer failures take down the whole browser. |
| `MAX_CONCURRENT_CRAWLS` | `3` | 1–8 | Number of simultaneous isolated crawl sessions. |
| `MAX_WORKERS_PER_CRAWL` | `1` | 1–3 | Maximum browser workers within each crawl. |
| `LINK_CHECK_CONCURRENCY` | `6` | 1–12 | Parallel link status checks per crawl. |
| `LINK_CHECK_DEADLINE_MS` | `30000` | 5000–120000 | Per-page deadline for link status verification. |
| `APP_RELEASE` | `concurrent-crawls-v4` | — | Optional runtime release label returned by the status API. |
| `DB_HOST` | — | — | MySQL host; enables durable crawl history when all `DB_*` values are present. |
| `DB_PORT` | `3306` | — | MySQL port. |
| `DB_NAME` | — | — | MySQL database name. |
| `DB_USER` | — | — | MySQL database user. |
| `DB_PASSWORD` | — | — | MySQL database password. Keep this only in hosting environment variables. |
| `ADMIN_PASSWORD` | — | — | Enables the protected `/admin` history-management screen. Use a long, unique password and set it only in hPanel. |
| `ADMIN_SESSION_SECRET` | `ADMIN_PASSWORD` | — | Optional separate, long random value used to sign administrator sessions. Recommended in production. |

Recommended starting capacity:

| Hosting resources | `MAX_CONCURRENT_CRAWLS` | `MAX_WORKERS_PER_CRAWL` |
| --- | ---: | ---: |
| 4 GB RAM / 4 CPU | 2 | 1 |
| 6 GB RAM / 5 CPU | 2–3 | 1 |
| 12 GB RAM / 6 CPU | 4 | 1 |
| 15–16 GB RAM / 8 CPU | 5–6 | 1 |

Keep `LINK_CHECK_CONCURRENCY=6` while increasing simultaneous crawls. Increasing both the crawl count and link-check concurrency multiplies outgoing requests quickly.

## HTTP API

All crawler and export routes use a session ID. The dashboard appends it as `?sessionId=<id>`. API clients can supply it by query string, `X-Crawler-Session` header, or JSON request body. Valid IDs contain letters, numbers, `_`, or `-` and are 8–128 characters long.

Calls without a valid ID use the legacy `default` session.

### Start a crawl

`POST /api/crawler/start?sessionId=<id>`

Example:

```bash
curl -X POST http://localhost:3000/api/crawler/start?sessionId=demo_session_01 \
  -H 'Content-Type: application/json' \
  --data '{
    "seedUrl": "https://example.com",
    "crawlScope": "domain",
    "maxDepth": 2,
    "maxPages": 50,
    "concurrency": 1,
    "customContentSelector": "article",
    "excludePatterns": ["/login", "/cart"],
    "includePatterns": [],
    "respectRobotsTxt": true,
    "autoScroll": true,
    "delayBetweenRequestsMs": 500,
    "region": "auto",
    "proxy": "",
    "blockCrossDomainRedirects": true
  }'
```

The server caps the requested `concurrency` to `MAX_WORKERS_PER_CRAWL`.

Responses:

- `200` — crawl started.
- `400` — the same session already has a running crawl or `seedUrl` is missing.
- `429` — all global crawl slots are occupied; the response includes capacity information.

### Controls

| Method and route | Description |
| --- | --- |
| `POST /api/crawler/pause?sessionId=<id>` | Pauses a running crawl after the current work completes. |
| `POST /api/crawler/resume?sessionId=<id>` | Resumes a paused crawl. |
| `POST /api/crawler/stop?sessionId=<id>` | Cancels queued work, active HTTP/link requests, and the current browser page. The dashboard shows **Stopping…** until cleanup is complete and the crawl slot is released. |
| `POST /api/crawler/reset?sessionId=<id>` | Stops the session if needed and removes its retained results. |

### Read routes

| Route | Description |
| --- | --- |
| `GET /api/crawler/status?sessionId=<id>` | Session status, statistics, engine mode, runtime release, and global capacity. |
| `GET /api/crawler/results?sessionId=<id>` | Crawled page results. |
| `GET /api/crawler/links?sessionId=<id>` | Aggregated link records. |
| `GET /api/crawler/history?limit=25` | Saved crawls from MySQL; survives restarts and deployments. |
| `GET /api/crawler/history/<crawlId>` | One saved crawl with its page results and links. |
| `GET /api/crawler/stream?sessionId=<id>` | SSE stream for live UI updates. |
| `GET /api/debug/browser` | Launch diagnostic for Chromium. Do not use it as a frequent production health check during busy crawls. |

### SSE events

| Event | Meaning |
| --- | --- |
| `status` | Initial session status after stream connection. |
| `started` | A crawl started. |
| `engineSelected` | Browser/direct-DOM engine state changed. |
| `pageCrawled` | One result was collected. |
| `paused`, `resumed`, `stopping`, `stopped`, `completed`, `reset` | Session lifecycle changes. `stopping` means active browser/network work is being cancelled; `stopped` is emitted after cleanup completes. |
| `error` | Crawl-level error. |
| `capacity` | Global crawl capacity changed. |

## Exports

All export links are session-scoped in the dashboard.

| Route | Format | Contents |
| --- | --- | --- |
| `GET /api/export/workbook.xlsx` | XLSX | Master page overview, all discovered links, and one detailed sheet per crawled page. |
| `GET /api/export/excel` | XLSX | Alias of the workbook route. |
| `GET /api/export/pages.csv` | CSV | Page-level SEO and content-area metrics. |
| `GET /api/export/links.csv` | CSV | Aggregated discovered-link inventory. |
| `GET /api/export/custom-content.csv` | CSV | Content-area extraction report. |
| `GET /api/export/kentico.csv` | CSV | Alias of the content-area report. |

Exports are unavailable until the current session has results.

## Deployment

### Hostinger Node.js Web App

Use Hostinger's Node.js Web App deployment with GitHub connected to the desired branch.

- Framework: **Express.js** or **Other**
- Node.js: **22.x** (22.17.0 or newer)
- Entry file: `server.js`
- Start command: `npm start`
- Build output directory: leave empty

Set these hPanel environment variables as a safe starting point:

```text
CHROMIUM_ENGINE=sparticuz-only
MAX_CONCURRENT_CRAWLS=3
MAX_WORKERS_PER_CRAWL=1
LINK_CHECK_CONCURRENCY=6
LINK_CHECK_DEADLINE_MS=30000
```

To enable saved crawl history, add `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` for a MySQL database in hPanel. OmniCrawl creates its own three tables on startup. Database credentials must never be committed to Git.

To clear saved history without phpMyAdmin, set `ADMIN_PASSWORD` in hPanel **Environment variables**, then deploy or restart the application. Visit `/admin` and sign in. The administration page requires typing `DELETE ALL` before it enables the permanent **Clear all saved crawl history** action. It clears only this app's saved crawl history; it does not drop the MySQL tables or change live crawler settings.

For stronger session signing, also set `ADMIN_SESSION_SECRET` to a separate long random value. The admin session is an HTTP-only, same-site cookie that expires after eight hours. Login attempts are rate-limited to five failures per 15 minutes.

Use [HOSTINGER_DEPLOY.md](HOSTINGER_DEPLOY.md) for Hostinger-specific diagnostics, capacity guidance, and post-deployment checks.

### Docker

The repository includes a Playwright-based Dockerfile and Compose configuration for environments where Docker is available:

```bash
docker compose up --build
```

The Docker image uses the Playwright Ubuntu image with browser dependencies installed. Set `CHROMIUM_ENGINE=playwright` for this deployment mode.

## Troubleshooting

### Dashboard says “Direct DOM Active”

Chromium could not start. Check:

```text
GET /api/debug/browser
```

On Hostinger, confirm:

```text
CHROMIUM_ENGINE=sparticuz-only
```

Then inspect runtime logs for the exact launch error. Direct DOM mode can crawl static HTML but not reliably extract content created only after client-side JavaScript runs.

### Only the homepage has content, while child routes look empty

This normally indicates an unrendered HTML fallback rather than an SEO selector problem. Inspect the session status and affected page result:

- `engine.mode` should be `browser`.
- A proper rendered result uses `renderMode: "browser"`.
- A page-level fallback has `renderMode: "direct-dom-fallback"` and an explanatory error.

The crawler retries a disconnected browser once per affected URL. Check `browserRestartsCount`, `browserFallbacksCount`, and runtime logs if this persists.

### “All cloud-browser crawl slots are occupied”

The global capacity limit has been reached. Wait for a crawl to finish, stop an unused crawl, or increase `MAX_CONCURRENT_CRAWLS` only after confirming that the hosting plan has sufficient resources.

### A crawl is slow after page rendering

Link verification can be the slowest phase because it makes status requests for every discovered URL. Keep the defaults, lower `LINK_CHECK_CONCURRENCY`, or lower `LINK_CHECK_DEADLINE_MS` if target sites rate-limit requests or response time matters more than complete link-status coverage.

### Region selection does not change the site version

Region presets adjust browser locale, timezone, geolocation, and request headers. They do **not** change the server's real public IP address. Configure a proxy located in the required region for sites that make decisions from source IP.

### Results disappeared

The current tab's live results are in memory and can disappear on deployment, process restart, or session expiration. When the `DB_*` variables are configured, completed crawl history remains available through `/api/crawler/history` after those events. Export completed audits promptly for offline records.

## Operational limits and security

- Crawl only sites you are authorized to audit and respect the target site's terms, crawl policies, and applicable law.
- `robots.txt` handling is optional; enable it when the target policy requires it.
- No user authentication is implemented. Session IDs isolate normal dashboard tabs but are not a substitute for accounts, authorization, audit ownership, rate limits, or tenant security.
- Avoid exposing the app publicly without an authentication layer, request throttling, and a persistent job store.
- The crawler stores results in memory. It is not a durable job queue and is not designed for distributed/multi-instance deployment without shared storage and coordination.
- Proxies can expose credentials and traffic to third parties. Store proxy secrets in hPanel environment variables or a secrets manager, not in source control.

## Development and testing

Run the automated checks:

```bash
npm test
```

The suite covers `robots.txt` behavior, exports, single-URL crawling, exclusion rules, and browser-disconnect detection. It performs a real browser crawl when a local Chromium executable is available.

Useful manual checks:

```bash
# Browser diagnostic
curl http://localhost:3000/api/debug/browser

# Empty session status and capacity
curl 'http://localhost:3000/api/crawler/status?sessionId=docs_demo_01'
```

## Project structure

```text
.
├── server.js                    # Express app and HTTP/SSE API
├── src/
│   ├── engine/
│   │   ├── browser.js            # Chromium and browser-context lifecycle
│   │   ├── crawler.js            # Crawl engine and queue
│   │   ├── extractor.js          # SEO/content/link extraction
│   │   ├── exporter.js           # CSV/XLSX output
│   │   ├── geoPresets.js         # Region presets
│   │   ├── robots.js             # robots.txt handling
│   │   └── statusChecker.js      # Link status verifier
│   └── public/                   # Dashboard assets
├── HOSTINGER_DEPLOY.md           # Hostinger deployment guide
├── Dockerfile                    # Optional Docker deployment
├── docker-compose.yml
└── test-features.js              # Automated checks
```

## License

No license file is currently included. Add an explicit license before distributing or accepting external contributions.
