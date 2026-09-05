# Hostinger deployment notes

This describes the repository's existing deployment workflow, not every Hostinger plan or current hPanel screen. Full operating instructions and environment reference are in [the public guide](src/public/info/docs.html#deployment), served at `/docs`.

## Application configuration

- Node.js 22.17.0 or newer.
- Entry file: `server.js`.
- Start command: `npm start`.
- Express serves both the API and the committed React bundle.
- Dependencies must be installed from `package-lock.json`.
- A production Vite build is unnecessary when deploying the committed `src/public/next/` output. If you introduce a remote client build, install development dependencies too.

The root URL is public marketing content. The private dashboard is at `/app`; administration is at `/admin`. Public documentation is at `/docs`.

## Private environment configuration

Set `ADMIN_PASSWORD` and a long random `ADMIN_SESSION_SECRET` through the hosting environment. Do not place real credentials in Git, public files, screenshots or client-side variables.

Set `NODE_ENV=production` and the correct `PUBLIC_APP_URL`. Keep the host-provided port configuration. Express currently trusts one reverse-proxy hop; verify HTTPS redirects and secure cookie behaviour against the actual deployment topology.

Optional durable history requires all of `DB_HOST`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`; `DB_PORT` defaults to 3306. Schema initialization creates missing tables and applies supported additive columns. Confirm storage status and write errors in administration/runtime logs after deployment.

## Browser and workload defaults

Linux prefers the bundled Sparticuz Chromium runtime, avoiding many missing desktop-library failures. There is no separate production Playwright browser download in this workflow.

Optional explicit configuration:

```text
CHROMIUM_ENGINE=sparticuz-only
MAX_CONCURRENT_CRAWLS=3
MAX_WORKERS_PER_CRAWL=1
MAX_UNLIMITED_CRAWL_PAGES=50000
LINK_CHECK_CONCURRENCY=6
LINK_CHECK_DEADLINE_MS=30000
```

These are application defaults, not a guarantee that a particular plan can sustain that workload. Keep one page worker per crawl and observe simultaneous-load memory, CPU, latency, failures and browser restarts before raising capacity.

Crawls share a Chromium process on this Linux configuration, with isolated page contexts closed after extraction. Queues, controls and results belong to dashboard sessions. Saved history is shared within the authenticated administrator workspace.

## Deployment checklist

1. Run `npm ci`, `npm test` and `npm run client:build` locally.
2. Review and commit source changes and regenerated client assets.
3. Push only when the deployment batch is approved. The connected GitHub branch triggers Hostinger deployment.
4. Verify `/` and `/docs` are public, while `/app`, `/admin`, crawler data and exports require sign-in.
5. Sign in, test a small permitted crawl, inspect its engine status and check saved history if MySQL is configured.
6. Confirm exports, source/rendered inspection, admin session revocation and runtime errors as appropriate for the changed feature.

The authenticated `/api/debug/browser` endpoint provides launch diagnostics; it is not a lightweight public health check. Direct HTML fallback cannot render JavaScript, so investigate browser errors if dynamic pages lose content.

A deployment restarts process-local sessions and unfinished crawl queues. Existing saved MySQL records remain, but queue resumption is not implemented. Schedule deployments around active work.

## Backups

Hosting backups are managed outside the application. Confirm that the relevant database and files are included and that restoration works. The admin clear-history action has no in-app undo and preserves security events; restoring deleted history requires an appropriate external backup.
