# Hostinger Cloud deployment

Use Hostinger's Node.js Web App deployment, not the Docker workflow.

## Build settings

- Framework: Express.js or Other
- Node.js: 22.x (22.17.0 or newer)
- Entry file: `server.js`
- Start command: `npm start`
- Output directory: leave empty

Hostinger installs the dependencies from `package-lock.json`. The application does not need a
build command or a Playwright browser download.

## Runtime

On Linux, the application automatically launches the bundled `@sparticuz/chromium` browser.
For an explicit setting, add this environment variable in hPanel:

```text
CHROMIUM_ENGINE=sparticuz-only
MAX_CONCURRENT_CRAWLS=2
MAX_WORKERS_PER_CRAWL=1
```

`MAX_CONCURRENT_CRAWLS` controls how many isolated users may crawl simultaneously (allowed range
1–8). `MAX_WORKERS_PER_CRAWL` controls the number of browser pages used by each crawl (allowed
range 1–3). The application defaults to 2 simultaneous crawls with 1 worker each. Increase the
crawl count before increasing workers, because every additional worker creates another rendered
page and raises Chromium memory usage.

Suggested starting points:

| Host resources | Concurrent crawls | Workers per crawl |
| --- | ---: | ---: |
| 4 GB RAM / 4 CPU | 2 | 1 |
| 6 GB RAM / 5 CPU | 2–3 | 1 |
| 12 GB RAM / 6 CPU | 4 | 1 |
| 15–16 GB RAM / 8 CPU | 5–6 | 1 |

Apply environment-variable changes in hPanel before testing. Start conservatively and check memory,
CPU, crawl latency, browser restart count, and HTTP 503 responses before increasing either limit.

After deployment, open `/api/debug/browser`. A working deployment returns HTTP 200 with values
similar to:

```json
{
  "success": true,
  "provider": "sparticuz",
  "browserVersion": "149.0.7827.22"
}
```

The dashboard should display **Cloud Browser Active** during a crawl. If it displays
**Direct DOM Active**, inspect the diagnostic endpoint and Hostinger runtime logs for the original
browser launch error.

Keep one worker per crawl initially. Increase `MAX_WORKERS_PER_CRAWL` only after checking CPU and
memory usage in hPanel under simultaneous load.
