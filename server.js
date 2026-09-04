import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { SiteCrawler } from './src/engine/crawler.js';
import { Extractor } from './src/engine/extractor.js';
import { Exporter } from './src/engine/exporter.js';
import { crawlStorage } from './src/storage/database.js';
import { CrawlNetworkPolicy, UnsafeCrawlTargetError } from './src/security/network-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
app.set('trust proxy', 1);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const MAX_CONCURRENT_CRAWLS = boundedInteger(process.env.MAX_CONCURRENT_CRAWLS, 3, 1, 8);
const MAX_WORKERS_PER_CRAWL = boundedInteger(process.env.MAX_WORKERS_PER_CRAWL, 1, 1, 3);
const LINK_CHECK_CONCURRENCY = boundedInteger(process.env.LINK_CHECK_CONCURRENCY, 6, 1, 12);
const LINK_CHECK_DEADLINE_MS = boundedInteger(process.env.LINK_CHECK_DEADLINE_MS, 30000, 5000, 120000);
// A no-limit crawl runs until its queue is empty, but this ceiling prevents one
// malformed or unexpectedly huge site from consuming the whole hosting plan.
const MAX_UNLIMITED_CRAWL_PAGES = boundedInteger(process.env.MAX_UNLIMITED_CRAWL_PAGES, 50000, 1000, 250000);
const APP_RELEASE = process.env.APP_RELEASE || 'concurrent-crawls-v4';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const PRIVATE_ACCESS_CONFIGURED = Boolean(ADMIN_PASSWORD && ADMIN_SESSION_SECRET);
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ACTIVE_SESSION_WINDOW_MS = 2 * 60 * 1000;
const SESSION_ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_RECORDS = 100;
const adminLoginAttempts = new Map();
const adminSessions = new Map();
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'https://workva.co.za').replace(/\/$/, '');
const crawlNetworkPolicy = new CrawlNetworkPolicy();

function preventIndexing(req, res, next) {
  // robots.txt is advisory; this response header is the crawler-enforced layer.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
}

app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(['/admin', '/api', '/next', '/legacy'], preventIndexing);

// The public homepage explains the product. The React dashboard is isolated
// under /app so it can remain private and excluded from search indexes.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'home.html')));
app.get('/app', requireDashboardAccess, (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'next', 'index.html')));
app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/legacy', requireDashboardAccess, (req, res) => res.sendFile(path.join(__dirname, 'src', 'public', 'index.html')));
app.use('/next', requireDashboardAccess);
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Only public product and information pages are submitted to search engines.
// Administration, API and preview routes are excluded above and in robots.txt.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /api\nDisallow: /next\nDisallow: /legacy\n\nSitemap: ${PUBLIC_APP_URL}/sitemap.xml\n`);
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
const dashboardSessions = new Map();
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

function getClientIp(req) {
  return (req.ip || req.socket.remoteAddress || 'Unknown').trim();
}

function describeDevice(userAgent = '') {
  const browser = /Edg\//.test(userAgent) ? 'Microsoft Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Unknown browser';
  const device = /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad' : /Android/.test(userAgent) ? 'Android device' : /Windows/.test(userAgent) ? 'Windows device' : /Macintosh/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux device' : 'Unknown device';
  return `${browser} on ${device}`;
}

function pruneSessionRecords() {
  const cutoff = Date.now() - SESSION_ACTIVITY_RETENTION_MS;
  for (const sessions of [adminSessions, dashboardSessions]) {
    for (const [id, record] of sessions) {
      if ((record.lastSeenAt || record.createdAt) < cutoff) sessions.delete(id);
    }
    if (sessions.size > MAX_SESSION_RECORDS) {
      [...sessions.entries()]
        .sort(([, a], [, b]) => (a.lastSeenAt || a.createdAt) - (b.lastSeenAt || b.createdAt))
        .slice(0, sessions.size - MAX_SESSION_RECORDS)
        .forEach(([id]) => sessions.delete(id));
    }
  }
}

function createAdminSession(req) {
  pruneSessionRecords();
  const id = randomUUID();
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(id, {
    id,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt,
    ip: getClientIp(req),
    userAgent: req.get('user-agent') || 'Unknown user agent'
  });
  const payload = Buffer.from(JSON.stringify({ id, exp: expiresAt })).toString('base64url');
  return `${payload}.${signAdminPayload(payload)}`;
}

function getAdminSession(req, touch = true) {
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
    const { id, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const session = typeof id === 'string' ? adminSessions.get(id) : null;
    if (!session || session.revokedAt || session.endedAt || !Number.isFinite(exp) || exp <= Date.now() || session.expiresAt <= Date.now()) return false;
    if (touch) session.lastSeenAt = Date.now();
    return session;
  } catch {
    return false;
  }
}

function hasValidAdminSession(req) {
  return Boolean(getAdminSession(req));
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
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).json({ error: 'Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.' });
  if (!hasValidAdminSession(req)) return res.status(401).json({ error: 'Administrator login required.' });
  res.setHeader('Cache-Control', 'no-store');
  return next();
}

function safeNextPath(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
}

function requireDashboardAccess(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  if (!PRIVATE_ACCESS_CONFIGURED) {
    return res.status(503).type('text/plain').send('CrawlLoom private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in the hosting environment.');
  }
  if (!hasValidAdminSession(req)) {
    return res.redirect(`/admin/login?next=${encodeURIComponent(safeNextPath(req.originalUrl))}`);
  }
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
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).type('text/plain').send('Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in the hosting environment.');
  if (hasValidAdminSession(req)) return res.redirect(safeNextPath(req.query.next, '/app'));
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, 'src', 'admin', 'login.html'));
});

app.get('/admin', (req, res) => {
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).type('text/plain').send('Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in the hosting environment.');
  if (!hasValidAdminSession(req)) return res.redirect('/admin/login?next=/admin');
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, 'src', 'admin', 'index.html'));
});

app.get('/api/admin/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ configured: PRIVATE_ACCESS_CONFIGURED, authenticated: hasValidAdminSession(req) });
});

app.post('/api/admin/login', (req, res) => {
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).json({ error: 'Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.' });
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
  res.cookie('omnicrawl_admin', createAdminSession(req), adminCookieOptions(req));
  return res.json({ success: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const session = getAdminSession(req, false);
  if (session) session.endedAt = Date.now();
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

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  pruneSessionRecords();
  const currentAdminSession = getAdminSession(req, false);
  const sessions = [
    ...[...adminSessions.values()].map(session => serializeSession(session, 'Administrator', currentAdminSession?.id)),
    ...[...dashboardSessions.values()].map(session => serializeSession(session, 'Dashboard', currentAdminSession?.id))
  ].sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sessions, activeWindowSeconds: ACTIVE_SESSION_WINDOW_MS / 1000, retentionDays: SESSION_ACTIVITY_RETENTION_MS / (24 * 60 * 60 * 1000) });
});

app.post('/api/admin/sessions/:sessionId/revoke', requireAdmin, (req, res) => {
  const sessionId = req.params.sessionId;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session identifier.' });
  const currentAdminSession = getAdminSession(req, false);
  const adminSession = adminSessions.get(sessionId);
  if (adminSession) {
    if (adminSession.id === currentAdminSession?.id) return res.status(400).json({ error: 'Use Sign out to end your current administrator session.' });
    adminSession.revokedAt = Date.now();
    return res.json({ success: true, type: 'Administrator' });
  }
  if (revokeDashboardSession(sessionId)) return res.json({ success: true, type: 'Dashboard' });
  return res.status(404).json({ error: 'That session is no longer available.' });
});

function getSessionId(req) {
  const candidate = req.get('x-crawler-session') || req.query.sessionId || req.body?.sessionId || 'default';
  return /^[a-zA-Z0-9_-]{8,128}$/.test(candidate) ? candidate : 'default';
}

function trackDashboardSession(req, res, next) {
  pruneSessionRecords();
  const sessionId = getSessionId(req);
  const existing = dashboardSessions.get(sessionId);
  if (existing?.revokedAt) {
    return res.status(403).json({ error: 'This dashboard session has been revoked by an administrator.' });
  }
  const now = Date.now();
  dashboardSessions.set(sessionId, existing || {
    id: sessionId,
    createdAt: now,
    lastSeenAt: now,
    ip: getClientIp(req),
    userAgent: req.get('user-agent') || 'Unknown user agent'
  });
  dashboardSessions.get(sessionId).lastSeenAt = now;
  return next();
}

function getSessionCrawler(req) {
  const sessionId = getSessionId(req);
  const record = crawlerSessions.get(sessionId);
  if (record) record.updatedAt = Date.now();
  return { sessionId, crawler: record?.crawler || null };
}

function serializeSession(record, type, currentAdminSessionId) {
  const now = Date.now();
  const status = record.revokedAt ? 'Revoked' : record.endedAt ? 'Signed out' : now - record.lastSeenAt <= ACTIVE_SESSION_WINDOW_MS ? 'Active' : 'Recent';
  return {
    id: record.id,
    idDisplay: `${record.id.slice(0, 8)}…${record.id.slice(-4)}`,
    type,
    status,
    current: type === 'Administrator' && record.id === currentAdminSessionId,
    device: describeDevice(record.userAgent),
    ip: record.ip || 'Unknown',
    createdAt: new Date(record.createdAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null
  };
}

function revokeDashboardSession(sessionId) {
  const record = dashboardSessions.get(sessionId);
  if (!record) return false;
  record.revokedAt = Date.now();
  const crawlerRecord = crawlerSessions.get(sessionId);
  if (crawlerRecord?.crawler?.isRunning) crawlerRecord.crawler.stop();
  crawlerSessions.delete(sessionId);
  const clientsToClose = sseClients.filter(client => client.sessionId === sessionId);
  sseClients = sseClients.filter(client => client.sessionId !== sessionId);
  clientsToClose.forEach(client => {
    try {
      client.res.write(`event: revoked\ndata: ${JSON.stringify({ message: 'This dashboard session was revoked by an administrator.' })}\n\n`);
      client.res.end();
    } catch {}
  });
  return true;
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
    maxUnlimitedCrawlPages: MAX_UNLIMITED_CRAWL_PAGES,
    linkCheckConcurrency: LINK_CHECK_CONCURRENCY,
    linkCheckDeadlineMs: LINK_CHECK_DEADLINE_MS
  };
}

app.use('/api/crawler', requireAdmin, trackDashboardSession);
app.use('/api/export', requireAdmin, trackDashboardSession);

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
      maxPages: requestedMaxPages = 50,
      noPageLimit = false,
      concurrency: requestedConcurrency = 1,
      customContentSelector = '',
      excludePatterns = [],
      includePatterns = [],
      respectRobotsTxt = false,
      autoScroll = true,
      delayBetweenRequestsMs = 500,
      region = 'auto',
      blockCrossDomainRedirects = true
    } = req.body || {};

    const seedUrl = Extractor.normalizeSeedUrl(requestedSeedUrl);
    if (!seedUrl) {
      return res.status(400).json({ error: 'Enter a valid website address, such as graduateshub.org or https://graduateshub.org.' });
    }
    try {
      await crawlNetworkPolicy.assertSafePublicUrl(seedUrl);
    } catch (error) {
      const message = error instanceof UnsafeCrawlTargetError ? error.message : 'The target address could not be validated safely.';
      return res.status(400).json({ error: message });
    }

    if (typeof req.body?.proxy === 'string' && req.body.proxy.trim()) {
      return res.status(400).json({ error: 'Custom proxy endpoints are disabled for security. CrawlLoom uses the hosting provider’s own network connection.' });
    }
    const concurrency = Math.min(
      MAX_WORKERS_PER_CRAWL,
      boundedInteger(requestedConcurrency, 1, 1, MAX_WORKERS_PER_CRAWL)
    );
    const crawlWithoutPageLimit = crawlScope !== 'single-url' && noPageLimit === true;
    const maxPages = crawlWithoutPageLimit
      ? MAX_UNLIMITED_CRAWL_PAGES
      : boundedInteger(requestedMaxPages, 50, 1, MAX_UNLIMITED_CRAWL_PAGES);

    const crawler = new SiteCrawler({
      seedUrl,
      crawlScope,
      maxDepth,
      maxPages,
      noPageLimit: crawlWithoutPageLimit,
      concurrency,
      customContentSelector,
      excludePatterns,
      includePatterns,
      respectRobotsTxt,
      autoScroll,
      delayBetweenRequestsMs,
      region,
      blockCrossDomainRedirects,
      networkPolicy: crawlNetworkPolicy,
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

// Captures source and rendered HTML only on demand. This avoids persisting
// large documents for every page in an audit while still making DOM changes
// inspectable from the dashboard.
app.get('/api/crawler/page-html', async (req, res) => {
  const { crawler } = getSessionCrawler(req);
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!crawler || !url) return res.status(400).json({ error: 'Choose an audited page before viewing its HTML.' });
  if (crawler.isRunning) return res.status(409).json({ error: 'Wait for the crawl to finish before opening an HTML comparison.' });
  const auditedPage = crawler.results.find(page => page.url === url);
  if (!auditedPage) return res.status(404).json({ error: 'That page is not part of this crawl session.' });

  try {
    return res.json(await crawler.captureHtmlComparison(auditedPage.url));
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Could not capture the HTML comparison.' });
  }
});

// Debug Diagnostic Endpoint
app.get('/api/debug/browser', requireAdmin, async (req, res) => {
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

// Restores a saved MySQL crawl into the caller's dashboard session. The normal
// dashboard, inspection views, filters, issue rules and exports can then use it
// exactly like a crawl that was completed in the current browser tab.
app.post('/api/crawler/history/:crawlId/restore', async (req, res) => {
  const { sessionId, crawler: currentCrawler } = getSessionCrawler(req);
  if (currentCrawler?.isRunning) return res.status(409).json({ error: 'Pause or stop the current crawl before restoring saved history.' });
  try {
    const history = await crawlStorage.getCrawl(req.params.crawlId);
    if (!history) return res.status(404).json({ error: 'Saved crawl not found.' });
    const config = history.crawl.config || {};
    const restoredCrawler = new SiteCrawler({
      seedUrl: history.crawl.seedUrl,
      crawlScope: config.crawlScope,
      maxDepth: config.maxDepth,
      maxPages: config.maxPages,
      noPageLimit: config.noPageLimit,
      concurrency: config.concurrency,
      autoScroll: config.autoScroll,
      customContentSelector: config.customContentSelector,
      respectRobotsTxt: config.respectRobotsTxt,
      region: config.region,
      blockCrossDomainRedirects: config.blockCrossDomainRedirects
    });
    restoredCrawler.results = history.results;
    restoredCrawler.allLinks = history.results.flatMap(page => (page.links || []).map(link => ({
      ...link,
      sourceUrl: page.url,
      targetUrl: link.targetUrl || link.url || ''
    })));
    restoredCrawler.stats = history.crawl.stats || { ...restoredCrawler.stats, pagesCrawled: history.results.length, endTime: Date.now() };
    restoredCrawler.queue = [];
    restoredCrawler.isRunning = false;
    restoredCrawler.isPaused = false;
    restoredCrawler.engineMode = history.crawl.engine?.mode || 'browser';
    restoredCrawler.engineProvider = history.crawl.engine?.provider || null;
    restoredCrawler.engineError = history.crawl.engine?.error || null;
    crawlerSessions.set(sessionId, { crawler: restoredCrawler, crawlId: history.crawl.id, updatedAt: Date.now() });
    broadcastSSE(sessionId, 'restored', { crawlId: history.crawl.id, stats: restoredCrawler.stats, engine: restoredCrawler.getEngineStatus() });
    return res.json({ success: true, crawl: history.crawl, restoredPages: history.results.length });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not restore the saved crawl.' });
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
