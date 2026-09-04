import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { SiteCrawler } from './src/engine/crawler.js';
import { Extractor } from './src/engine/extractor.js';
import { Exporter } from './src/engine/exporter.js';
import { crawlStorage } from './src/storage/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const MAX_CONCURRENT_CRAWLS = boundedInteger(process.env.MAX_CONCURRENT_CRAWLS, 3, 1, 8);
const MAX_WORKERS_PER_CRAWL = boundedInteger(process.env.MAX_WORKERS_PER_CRAWL, 1, 1, 3);
const LINK_CHECK_CONCURRENCY = boundedInteger(process.env.LINK_CHECK_CONCURRENCY, 6, 1, 12);
const LINK_CHECK_DEADLINE_MS = boundedInteger(process.env.LINK_CHECK_DEADLINE_MS, 30000, 5000, 120000);
const APP_RELEASE = process.env.APP_RELEASE || 'concurrent-crawls-v4';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_PASSWORD;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const adminLoginAttempts = new Map();
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'https://workva.co.za').replace(/\/$/, '');

function preventIndexing(req, res, next) {
  // robots.txt is advisory; this response header is the crawler-enforced layer.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(['/admin', '/api', '/next'], preventIndexing);
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Only public product and information pages are submitted to search engines.
// Administration, API and preview routes are excluded above and in robots.txt.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /next\n\nSitemap: ${PUBLIC_APP_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const pages = ['', '/about', '/privacy', '/terms', '/acceptable-use'];
  const urls = pages.map(page => `  <url><loc>${PUBLIC_APP_URL}${page}/</loc></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

function sendInformationPage(filename) {
  return (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'info', filename));
}

app.get('/about', sendInformationPage('about.html'));
app.get('/privacy', sendInformationPage('privacy.html'));
app.get('/terms', sendInformationPage('terms.html'));
app.get('/acceptable-use', sendInformationPage('acceptable-use.html'));

// Database persistence is optional locally, but enabled automatically when the
// Hostinger database environment variables are configured.
crawlStorage.initialize().catch(() => {});

const crawlerSessions = new Map();
const runningCrawlers = new Set();
let sseClients = [];
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RETAINED_SESSIONS = 25;

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').flatMap(part => {
    const separator = part.indexOf('=');
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      return [[name, decodeURIComponent(value)]];
    } catch {
      return [];
    }
  }));
}

function signAdminPayload(payload) {
  return createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
}

function createAdminSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${signAdminPayload(payload)}`;
}

function hasValidAdminSession(req) {
  if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) return false;
  const token = parseCookies(req).omnicrawl_admin;
  if (!token) return false;
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) return false;
  const expected = signAdminPayload(payload);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(exp) && exp > Date.now();
  } catch {
    return false;
  }
}

function isSecureRequest(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https' || process.env.NODE_ENV === 'production';
}

function adminCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: ADMIN_SESSION_TTL_MS
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(404).send('Not found');
  if (!hasValidAdminSession(req)) return res.status(401).json({ error: 'Administrator login required.' });
  return next();
}

function getLoginAttempt(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const existing = adminLoginAttempts.get(key);
  if (!existing || existing.resetAt <= now) {
    const attempt = { count: 0, resetAt: now + ADMIN_LOGIN_WINDOW_MS };
    adminLoginAttempts.set(key, attempt);
    return { key, attempt };
  }
  return { key, attempt: existing };
}

function passwordsMatch(candidate) {
  const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
  const candidateBuffer = Buffer.from(typeof candidate === 'string' ? candidate : '');
  return expectedBuffer.length === candidateBuffer.length && timingSafeEqual(expectedBuffer, candidateBuffer);
}

// The history-management screen is intentionally separate from the crawler UI.
// It is unavailable until an administrator password is configured in the hosting
// environment, and every data-changing endpoint requires its signed HTTP-only cookie.
app.get('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(404).send('Not found');
  if (hasValidAdminSession(req)) return res.redirect('/admin');
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, 'src', 'admin', 'login.html'));
});

app.get('/admin', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(404).send('Not found');
  if (!hasValidAdminSession(req)) return res.redirect('/admin/login');
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, 'src', 'admin', 'index.html'));
});

app.get('/api/admin/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ configured: Boolean(ADMIN_PASSWORD), authenticated: hasValidAdminSession(req) });
});

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(404).json({ error: 'Administrator access is not configured.' });
  const { key, attempt } = getLoginAttempt(req);
  if (attempt.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', retryAfterSeconds);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).` });
  }
  if (!passwordsMatch(req.body?.password)) {
    attempt.count++;
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  adminLoginAttempts.delete(key);
  res.setHeader('Cache-Control', 'no-store');
  res.cookie('omnicrawl_admin', createAdminSession(), adminCookieOptions(req));
  return res.json({ success: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.clearCookie('omnicrawl_admin', adminCookieOptions(req));
  res.json({ success: true });
});

app.get('/api/admin/database-overview', requireAdmin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const overview = await crawlStorage.getDatabaseOverview();
    res.json({ storage: crawlStorage.getStatus(), ...overview });
  } catch (error) {
    res.status(503).json({ error: error.message, storage: crawlStorage.getStatus() });
  }
});

app.post('/api/admin/crawl-history/clear', requireAdmin, async (req, res) => {
  try {
    if (runningCrawlers.size > 0) {
      return res.status(409).json({ error: 'Stop and allow all active crawls to finish saving before clearing history.' });
    }
    if (req.body?.confirmation !== 'DELETE ALL') {
      return res.status(400).json({ error: 'Type DELETE ALL to confirm permanent deletion.' });
    }
    const deleted = await crawlStorage.clearAllCrawls();
    return res.json({ success: true, deleted });
  } catch (error) {
    console.error('Failed to clear saved crawl history:', error.message);
    return res.status(500).json({ error: 'Could not clear saved crawl history. Please try again.' });
  }
});

function getSessionId(req) {
  const candidate = req.get('x-crawler-session') || req.query.sessionId || req.body?.sessionId || 'default';
  return /^[a-zA-Z0-9_-]{8,128}$/.test(candidate) ? candidate : 'default';
}

function getSessionCrawler(req) {
  const sessionId = getSessionId(req);
  const record = crawlerSessions.get(sessionId);
  if (record) record.updatedAt = Date.now();
  return { sessionId, crawler: record?.crawler || null };
}

function pruneCrawlerSessions() {
  const now = Date.now();
  for (const [sessionId, record] of crawlerSessions) {
    if (!record.crawler.isRunning && now - record.updatedAt > SESSION_TTL_MS) {
      crawlerSessions.delete(sessionId);
    }
  }

  if (crawlerSessions.size <= MAX_RETAINED_SESSIONS) return;
  const removable = [...crawlerSessions.entries()]
    .filter(([, record]) => !record.crawler.isRunning)
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  while (crawlerSessions.size > MAX_RETAINED_SESSIONS && removable.length > 0) {
    crawlerSessions.delete(removable.shift()[0]);
  }
}

function getCrawlCapacity() {
  let activeCrawls = 0;
  for (const crawler of runningCrawlers) {
    if (crawler.isRunning) activeCrawls++;
  }
  return {
    activeCrawls,
    maxConcurrentCrawls: MAX_CONCURRENT_CRAWLS,
    availableSlots: Math.max(0, MAX_CONCURRENT_CRAWLS - activeCrawls),
    maxWorkersPerCrawl: MAX_WORKERS_PER_CRAWL,
    linkCheckConcurrency: LINK_CHECK_CONCURRENCY,
    linkCheckDeadlineMs: LINK_CHECK_DEADLINE_MS
  };
}

function broadcastSSE(sessionId, eventType, data) {
  const record = crawlerSessions.get(sessionId);
  if (record) record.updatedAt = Date.now();
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.filter(client => client.sessionId === sessionId).forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {}
  });
}

function broadcastCapacity() {
  const payload = `event: capacity\ndata: ${JSON.stringify(getCrawlCapacity())}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {}
  });
}

// SSE Stream for real-time crawler updates
app.get('/api/crawler/stream', (req, res) => {
  pruneCrawlerSessions();
  const { sessionId, crawler } = getSessionCrawler(req);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disables Nginx buffering on Hostinger / Cloud
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const newClient = { sessionId, res };
  sseClients.push(newClient);

  if (crawler) {
    res.write(`event: status\ndata: ${JSON.stringify({
      isRunning: crawler.isRunning,
      isPaused: crawler.isPaused,
      isStopping: crawler.isCancelled,
      stats: crawler.stats,
      queueLength: crawler.queue.length,
      config: crawler.getConfigSummary(),
      engine: crawler.getEngineStatus(),
      capacity: getCrawlCapacity()
    })}\n\n`);
  }

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== newClient);
  });
});

// Start Crawl
app.post('/api/crawler/start', async (req, res) => {
  try {
    pruneCrawlerSessions();
    const { sessionId, crawler: existingCrawler } = getSessionCrawler(req);
    if (existingCrawler?.isRunning) {
      return res.status(400).json({ error: 'A crawl is already running. Please stop or wait for it to finish.' });
    }
    const capacity = getCrawlCapacity();
    if (capacity.activeCrawls >= capacity.maxConcurrentCrawls) {
      return res.status(429).json({
        error: `All cloud-browser crawl slots are occupied (${capacity.activeCrawls}/${capacity.maxConcurrentCrawls}). Try again when another crawl finishes.`,
        capacity
      });
    }

    const {
      seedUrl: requestedSeedUrl,
      crawlScope = 'domain',
      maxDepth = 3,
      maxPages = 50,
      concurrency: requestedConcurrency = 1,
      customContentSelector = '',
      excludePatterns = [],
      includePatterns = [],
      respectRobotsTxt = false,
      autoScroll = true,
      delayBetweenRequestsMs = 500,
      region = 'auto',
      proxy = '',
      blockCrossDomainRedirects = true
    } = req.body || {};

    const seedUrl = Extractor.normalizeSeedUrl(requestedSeedUrl);
    if (!seedUrl) {
      return res.status(400).json({ error: 'Enter a valid website address, such as graduateshub.org or https://graduateshub.org.' });
    }

    const cleanProxy = (proxy && typeof proxy === 'string') ? proxy.trim() || null : null;
    const concurrency = Math.min(
      MAX_WORKERS_PER_CRAWL,
      boundedInteger(requestedConcurrency, 1, 1, MAX_WORKERS_PER_CRAWL)
    );

    const crawler = new SiteCrawler({
      seedUrl,
      crawlScope,
      maxDepth,
      maxPages,
      concurrency,
      customContentSelector,
      excludePatterns,
      includePatterns,
      respectRobotsTxt,
      autoScroll,
      delayBetweenRequestsMs,
      region,
      proxy: cleanProxy,
      blockCrossDomainRedirects,
      linkCheckConcurrency: LINK_CHECK_CONCURRENCY,
      linkCheckDeadlineMs: LINK_CHECK_DEADLINE_MS
    });
    const crawlId = randomUUID();
    let persistenceChain = Promise.resolve();
    const queuePersistence = (task) => {
      persistenceChain = persistenceChain
        .then(task)
        .catch(error => console.error(`Failed to persist crawl ${crawlId}:`, error.message));
      return persistenceChain;
    };

    if (await crawlStorage.initialize()) {
      await queuePersistence(() => crawlStorage.createCrawl({
        id: crawlId,
        sessionId,
        seedUrl,
        config: crawler.getConfigSummary()
      }));
    }

    crawlerSessions.set(sessionId, { crawler, crawlId, updatedAt: Date.now() });
    runningCrawlers.add(crawler);
    const sendCrawlerEvent = (eventType, data) => {
      if (crawlerSessions.get(sessionId)?.crawler === crawler) {
        broadcastSSE(sessionId, eventType, data);
      }
    };

    // Attach event handlers
    crawler.on('started', data => {
      sendCrawlerEvent('started', data);
      queuePersistence(() => crawlStorage.updateCrawl(crawlId, {
        status: 'running', stats: crawler.stats, engine: crawler.getEngineStatus(), started: true
      }));
    });
    crawler.on('engineSelected', data => sendCrawlerEvent('engineSelected', data));
    crawler.on('pageCrawled', data => {
      sendCrawlerEvent('pageCrawled', data);
      queuePersistence(() => crawlStorage.savePage(crawlId, data.result));
    });
    crawler.on('paused', () => {
      sendCrawlerEvent('paused', {});
      queuePersistence(() => crawlStorage.updateCrawl(crawlId, { status: 'paused', stats: crawler.stats, engine: crawler.getEngineStatus() }));
    });
    crawler.on('resumed', () => {
      sendCrawlerEvent('resumed', {});
      queuePersistence(() => crawlStorage.updateCrawl(crawlId, { status: 'running', stats: crawler.stats, engine: crawler.getEngineStatus() }));
    });
    crawler.on('stopping', () => {
      sendCrawlerEvent('stopping', {});
      queuePersistence(() => crawlStorage.updateCrawl(crawlId, { status: 'stopping', stats: crawler.stats, engine: crawler.getEngineStatus() }));
    });
    crawler.on('stopped', data => {
      sendCrawlerEvent('stopped', data);
      queuePersistence(() => crawlStorage.updateCrawl(crawlId, {
        status: 'stopped', stats: data.stats, engine: data.engine, completed: true
      }));
    });
    crawler.on('completed', data => {
      sendCrawlerEvent('completed', data);
      queuePersistence(() => crawlStorage.updateCrawl(crawlId, {
        status: 'completed', stats: data.stats, engine: data.engine, completed: true
      }));
    });
    crawler.on('error', data => sendCrawlerEvent('error', data));

    // Run in background
    const crawlPromise = crawler.start();
    broadcastCapacity();
    crawlPromise
      .catch(err => {
        console.error('Crawler engine error:', err);
        sendCrawlerEvent('error', { message: err.message });
      })
      .finally(async () => {
        await persistenceChain;
        runningCrawlers.delete(crawler);
        broadcastCapacity();
      });

    return res.json({
      success: true,
      message: 'Crawl started',
      crawlId,
      config: crawler.getConfigSummary(),
      capacity: getCrawlCapacity()
    });
  } catch (err) {
    console.error('Failed to start crawler:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Controls
app.post('/api/crawler/pause', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (crawler?.isRunning) {
    crawler.pause();
    return res.json({ success: true, message: 'Crawl paused' });
  }
  res.status(400).json({ error: 'No active running crawl to pause.' });
});

app.post('/api/crawler/resume', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (crawler?.isRunning) {
    crawler.resume();
    return res.json({ success: true, message: 'Crawl resumed' });
  }
  res.status(400).json({ error: 'No active crawl to resume.' });
});

app.post('/api/crawler/stop', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (crawler?.isRunning) {
    crawler.stop();
    return res.json({ success: true, message: 'Crawl cancellation requested' });
  }
  res.status(400).json({ error: 'No active crawl to stop.' });
});

// Clear / Reset Crawl State
app.post('/api/crawler/reset', (req, res) => {
  try {
    const { sessionId, crawler } = getSessionCrawler(req);
    if (crawler) {
      if (crawler.isRunning) {
        crawler.stop();
      }
      crawlerSessions.delete(sessionId);
    }
    broadcastSSE(sessionId, 'reset', {});
    return res.json({ success: true, message: 'Crawl state reset successfully' });
  } catch (err) {
    console.error('Failed to reset crawler:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Debug Diagnostic Endpoint
app.get('/api/debug/browser', async (req, res) => {
  let browserManager = null;
  try {
    const { BrowserManager } = await import('./src/engine/browser.js');
    browserManager = new BrowserManager({ headless: true });
    await browserManager.init();
    res.json({
      success: true,
      ...browserManager.getDiagnostics(),
      message: 'Chromium launched and closed successfully.'
    });
  } catch (err) {
    console.error('Debug launch error:', err);
    res.status(500).json({
      success: false,
      errorName: err.name,
      errorMessage: err.message,
      diagnostics: browserManager ? browserManager.getDiagnostics() : null
    });
  } finally {
    if (browserManager) await browserManager.close().catch(() => {});
  }
});

// Status & Results
app.get('/api/crawler/status', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler) {
    return res.json({ release: APP_RELEASE, isRunning: false, stats: null, resultsCount: 0, engine: null, capacity: getCrawlCapacity(), storage: crawlStorage.getStatus() });
  }
  res.json({
    release: APP_RELEASE,
    isRunning: crawler.isRunning,
    isPaused: crawler.isPaused,
    isStopping: crawler.isCancelled,
    stats: crawler.stats,
    lastError: crawler.lastError || null,
    queueLength: crawler.queue.length,
    resultsCount: crawler.results.length,
    config: crawler.getConfigSummary(),
    engine: crawler.getEngineStatus(),
    capacity: getCrawlCapacity(),
    storage: crawlStorage.getStatus()
  });
});

app.get('/api/crawler/results', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler) return res.json({ results: [] });
  res.json({ results: crawler.results });
});

app.get('/api/crawler/links', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler) return res.json({ links: [] });
  res.json({ links: crawler.allLinks });
});

// Persistent crawl history. These routes remain available after a deployment or process restart.
app.get('/api/crawler/history', async (req, res) => {
  try {
    const crawls = await crawlStorage.listCrawls(req.query.limit);
    res.json({ storage: crawlStorage.getStatus(), crawls });
  } catch (error) {
    res.status(500).json({ error: error.message, storage: crawlStorage.getStatus() });
  }
});

app.get('/api/crawler/history/:crawlId', async (req, res) => {
  try {
    const history = await crawlStorage.getCrawl(req.params.crawlId);
    if (!history) return res.status(404).json({ error: 'Saved crawl not found.' });
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message, storage: crawlStorage.getStatus() });
  }
});

// Export Endpoints
app.get(['/api/export/workbook.xlsx', '/api/export/excel'], async (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler || !crawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  try {
    const buffer = await Exporter.generateMultiSheetWorkbook(crawler.results, crawler.allLinks);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="CrawlLoom_MultiSheet_Report_${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Error generating Excel workbook:', err);
    res.status(500).send('Error generating Excel workbook: ' + err.message);
  }
});

app.get('/api/export/pages.csv', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler || !crawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  const csv = Exporter.generatePagesCSV(crawler.results);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="seo_pages_crawl_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/export/links.csv', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler || !crawler.allLinks.length) {
    return res.status(400).send('No links data available to export.');
  }
  const csv = Exporter.generateLinksCSV(crawler.allLinks);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="all_links_crawl_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/export/issues.csv', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler || !crawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  const csv = Exporter.generateIssuesCSV(crawler.results, crawler.allLinks);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="seo_issues_crawl_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/export/resources.csv', (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler || !crawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  const csv = Exporter.generateResourcesCSV(crawler.results);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="resources_assets_crawl_${Date.now()}.csv"`);
  res.send(csv);
});

app.get(['/api/export/custom-content.csv', '/api/export/kentico.csv'], (req, res) => {
  const { crawler } = getSessionCrawler(req);
  if (!crawler || !crawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  const csv = Exporter.generateCustomContentReportCSV(crawler.results);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="custom_content_report_${Date.now()}.csv"`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  🕷️ CrawlLoom is running!`);
  console.log(`  🔗 Open Dashboard: http://localhost:${PORT}`);
  console.log(`  📦 Release: ${APP_RELEASE}`);
  console.log(`  ⚙️  Crawl Capacity: ${MAX_CONCURRENT_CRAWLS} simultaneous crawl(s), ${MAX_WORKERS_PER_CRAWL} worker(s) each`);
  console.log(`======================================================\n`);
});
