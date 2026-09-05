# CrawlLoom

Browser-rendered SEO auditing with a React + TypeScript dashboard, an Express crawler API and optional MySQL history.

## Documentation

The complete user, operator and developer guide now lives in the public, browser-readable [documentation file](src/public/info/docs.html).

- Local: [http://localhost:3000/docs](http://localhost:3000/docs)
- Hosted (after deployment): [https://workva.co.za/docs](https://workva.co.za/docs)
- No login is needed to read documentation. Dashboard, admin, API and exports remain private.

The guide covers crawl settings and depth, content detection, redirects, resources, shared SEO rules, exports, saved history, concurrency, access controls, environment variables, API endpoints and troubleshooting. It includes a contents menu, mobile layouts and print styling for saving a PDF.

## Quick start

Requires Node.js **22.17.0 or newer**.

```sh
npm ci
npx playwright-core install chromium
npm run client:build
```

Supply `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` as private environment variables. For local development, create `.tmp/local.env` in your editor (the `.tmp/` directory is ignored by Git), using your own password and a long random signing secret. Do not commit credentials or place them in public/client files.

```sh
node --env-file=.tmp/local.env server.js
```

Alternatively, with variables already in the process environment, use `npm start`. This command does not automatically load a .env file.

Open [/app](http://localhost:3000/app) for the supported React dashboard. The root path is the public homepage, not the crawler UI.

MySQL is optional locally. Set `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` and optionally `DB_PORT` to enable persistence. Without them, results remain in memory only.

## Routes

| Path | Purpose |
| --- | --- |
| `/` | Public product homepage |
| `/docs` | Public documentation |
| `/about`, `/privacy`, `/terms`, `/acceptable-use` | Public information pages |
| `/app` | Authenticated React dashboard |
| `/admin/login`, `/admin` | Sign-in and administration |
| `/next/` | Protected compiled React assets |
| `/legacy` | Older implementation; not the supported interface |

## Code map

| Location | Responsibility |
| --- | --- |
| `server.js` | Routes, authentication, sessions, live events, capacity and exports |
| `src/client/` | React UI, typed API client, domain types and feature modules |
| `src/client/features/crawl/liveCrawler.ts` | Revision-aware snapshots, SSE and resilient fallback |
| `src/engine/` | Queue, browser runtime, extraction, link verification and exports |
| `src/shared/seoIssues.js` | Shared dashboard/report SEO rules |
| `src/storage/database.js` | MySQL schema, persistence and retrieval |
| `src/security/` | Request validation and outbound network policy |
| `src/admin/` | Login and administration UI |
| `src/public/info/docs.html` | Canonical full documentation |
| `src/public/next/` | Committed production React build |

## Development checks

```sh
npm run typecheck
npm test
npm run client:build
```

The test suite includes public documentation, navigation and protected-route regression checks. Run those alone with `npm run test:docs`; they use a temporary local server with test-only credentials and database storage disabled.

`npm run dev` watches the Node server but does not rebuild React. Use `client:build` and Express at `/app` for integrated UI/API testing. `client:dev` starts Vite separately; no API proxy is currently configured, so it is not a complete authenticated app server.

The client build is committed for the current deployment workflow. Commit agreed changes locally; push only when a deployment batch is approved.

## Operating notes

- Single URL starts with one page and depth zero; multi-page scopes normally use 50 pages and depth three.
- “No page limit” still obeys depth, scope and the default 50,000-page server safety ceiling.
- The default capacity is three simultaneous crawls with one asynchronous page worker each.
- “Content area not detected” is not the same as no extracted page text.
- History restores saved data into the dashboard, not an unfinished crawl queue.
- HTML code previews are recaptured on demand, not retained historical HTML.
- The shared-admin login is not an individual user/role system.
- Pagination reduces visible rows, not the memory needed for the complete audit.

See the public guide for detailed behaviour and limitations.

## Maintaining the documentation

Update `src/public/info/docs.html` alongside feature, default, API and storage changes. Keep private deployment credentials, session identifiers, actual security logs and user crawl data out of all public documentation. The guide is static HTML with external CSS so it works without JavaScript and under the strict Content Security Policy.

Deployment notes: [HOSTINGER_DEPLOY.md](HOSTINGER_DEPLOY.md). Current frontend architecture and migration status: [REACT_MIGRATION.md](REACT_MIGRATION.md).
