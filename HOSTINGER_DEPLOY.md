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
```

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

Start production testing with one worker. Increase concurrency only after checking CPU and memory
usage in hPanel.
