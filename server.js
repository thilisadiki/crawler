import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { SiteCrawler } from './src/engine/crawler.js';
import { Extractor } from './src/engine/extractor.js';
import { Exporter } from './src/engine/exporter.js';
import { crawlStorage } from './src/storage/database.js';
import { CrawlNetworkPolicy, UnsafeCrawlTargetError } from './src/security/network-policy.js';
import { validateCrawlRequest, CrawlRequestValidationError } from './src/security/crawl-request-validation.js';
import { GEO_PRESETS } from './src/engine/geoPresets.js';
import { CrawlCoordinator } from './src/services/crawl-coordinator.js';
import { SseHub } from './src/services/sse-hub.js';
import { registerPublicRoutes } from './src/routes/public-routes.js';
import { registerAdminManagementRoutes } from './src/routes/admin-management-routes.js';
import { registerExportRoutes } from './src/routes/export-routes.js';
import { registerCrawlerStatusRoutes } from './src/routes/crawler-status-routes.js';
import { registerCrawlHistoryListRoutes } from './src/routes/crawl-history-list-routes.js';
import { registerHtmlComparisonRoute } from './src/routes/html-comparison-route.js';

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
const auditorSessions = new Map();
const scryptAsync = promisify(scrypt);
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'https://workva.co.za').replace(/\/$/, '');
const crawlNetworkPolicy = new CrawlNetworkPolicy();
const ALLOWED_CRAWL_REGIONS = new Set(['auto', ...Object.keys(GEO_PRESETS)]);
const STRICT_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; font-src 'self'";

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
  res.setHeader('Content-Security-Policy', STRICT_CONTENT_SECURITY_POLICY);
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(['/admin', '/api', '/next'], preventIndexing);
registerPublicRoutes(app, {
  publicDir: path.join(__dirname, 'src', 'public'),
  publicAppUrl: PUBLIC_APP_URL,
  requireDashboardAccess,
  staticMiddleware: express.static(path.join(__dirname, 'src', 'public'))
});

// Database persistence is optional locally, but enabled automatically when the
// Hostinger database environment variables are configured.
crawlStorage.initialize().catch(() => {});

const dashboardSessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RETAINED_SESSIONS = 25;
const sseHub = new SseHub();
const crawlCoordinator = new CrawlCoordinator({
  storage: crawlStorage,
  capacity: {
    maxConcurrentCrawls: MAX_CONCURRENT_CRAWLS,
    maxWorkersPerCrawl: MAX_WORKERS_PER_CRAWL,
    maxUnlimitedCrawlPages: MAX_UNLIMITED_CRAWL_PAGES,
    linkCheckConcurrency: LINK_CHECK_CONCURRENCY,
    linkCheckDeadlineMs: LINK_CHECK_DEADLINE_MS
  },
  onEvent: broadcastSSE,
  onCapacityChange: broadcastCapacity
});

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
  for (const sessions of [adminSessions, auditorSessions, dashboardSessions]) {
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
  const session = {
    id,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt,
    ip: getClientIp(req),
    userAgent: req.get('user-agent') || 'Unknown user agent'
  };
  adminSessions.set(id, session);
  const payload = Buffer.from(JSON.stringify({ id, exp: expiresAt })).toString('base64url');
  return { token: `${payload}.${signAdminPayload(payload)}`, session };
}

function createAuditorSession(req, user) {
  pruneSessionRecords();
  const id = randomUUID();
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const session = {
    id,
    userId: user.id,
    username: user.username,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt,
    ip: getClientIp(req),
    userAgent: req.get('user-agent') || 'Unknown user agent'
  };
  auditorSessions.set(id, session);
  const payload = Buffer.from(JSON.stringify({ id, exp: expiresAt })).toString('base64url');
  return { token: `${payload}.${signAdminPayload(payload)}`, session };
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

function getAuditorSession(req, touch = true) {
  if (!ADMIN_SESSION_SECRET) return false;
  const token = parseCookies(req).omnicrawl_auditor;
  if (!token) return false;
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) return false;
  const expected = signAdminPayload(payload);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) return false;
  try {
    const { id, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const session = typeof id === 'string' ? auditorSessions.get(id) : null;
    if (!session || session.revokedAt || session.endedAt || !Number.isFinite(exp) || exp <= Date.now() || session.expiresAt <= Date.now()) return false;
    if (touch) session.lastSeenAt = Date.now();
    return session;
  } catch {
    return false;
  }
}

function getDashboardPrincipal(req, touch = true) {
  const admin = getAdminSession(req, touch);
  if (admin) return { role: 'Administrator', id: admin.id, session: admin };
  const auditor = getAuditorSession(req, touch);
  if (auditor) return { role: 'Auditor', id: auditor.id, userId: auditor.userId, username: auditor.username, session: auditor };
  return null;
}

function getCrawlOwnerId(principal) {
  return principal?.role === 'Auditor' ? principal.userId : 'administrator';
}

function canAccessCrawl(req, crawl) {
  if (!crawl) return false;
  return crawl.ownerUserId === getCrawlOwnerId(req.dashboardPrincipal);
}

async function hasCrawlAccess(req, crawlId) {
  const ownerUserId = await crawlStorage.getCrawlOwner(crawlId);
  return canAccessCrawl(req, { ownerUserId });
}

// Logging is deliberately best-effort: an unavailable database must never
// block a login, crawl, or emergency session revocation. Metadata excludes
// passwords, cookies, and all other credentials.
function auditSecurityEvent(req, eventType, outcome = 'success', metadata = {}, context = {}) {
  const adminSession = context.adminSession || getAdminSession(req, false);
  const dashboardSession = context.dashboardSession || req.dashboardSession;
  crawlStorage.recordSecurityEvent({
    eventType,
    outcome,
    adminSessionId: adminSession?.id || null,
    dashboardSessionId: dashboardSession?.id || null,
    ipAddress: getClientIp(req),
    userAgent: req.get('user-agent') || 'Unknown user agent',
    metadata
  }).catch(error => console.error(`Could not record security event (${eventType}):`, error.message));
}

function auditTarget(seedUrl) {
  try {
    const url = new URL(seedUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'Invalid target';
  }
}

function hasValidAdminSession(req) {
  return Boolean(getAdminSession(req));
}

function hasValidDashboardAccess(req) {
  return Boolean(getDashboardPrincipal(req));
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

function clearAdminCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(req),
    path: '/'
  };
}

function auditorCookieOptions(req) {
  return { ...adminCookieOptions(req), maxAge: ADMIN_SESSION_TTL_MS };
}

function clearAuditorCookieOptions(req) {
  return { ...clearAdminCookieOptions(req) };
}

function requireAdmin(req, res, next) {
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).json({ error: 'Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.' });
  if (!hasValidAdminSession(req)) return res.status(401).json({ error: 'Administrator login required.' });
  res.setHeader('Cache-Control', 'no-store');
  return next();
}

function requireDashboardUser(req, res, next) {
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).json({ error: 'Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.' });
  const principal = getDashboardPrincipal(req);
  if (!principal) return res.status(401).json({ error: 'Sign in is required.' });
  req.dashboardPrincipal = principal;
  res.setHeader('Cache-Control', 'no-store');
  return next();
}

function safeNextPath(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
}

function requestOrigin(req) {
  const forwardedHost = req.get('x-forwarded-host');
  const host = (forwardedHost || req.get('host') || '').split(',')[0].trim();
  const forwardedProtocol = req.get('x-forwarded-proto');
  const protocol = (forwardedProtocol || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

// SameSite cookies already mitigate CSRF. This adds an Origin check for normal
// browser requests, while keeping command-line diagnostics possible when no
// Origin header is sent at all.
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  const allowedOrigins = new Set([requestOrigin(req), PUBLIC_APP_URL]);
  if (!allowedOrigins.has(origin)) return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  return next();
}

function requireDashboardAccess(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  if (!PRIVATE_ACCESS_CONFIGURED) {
    return res.status(503).type('text/plain').send('CrawlLoom private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in the hosting environment.');
  }
  if (!hasValidDashboardAccess(req)) {
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

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validAuditorUsername(value) {
  return /^[a-z][a-z0-9._-]{2,63}$/.test(value);
}

async function hashAuditorPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(hash).toString('base64url')}`;
}

async function auditorPasswordMatches(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const [algorithm, salt, encodedHash, ...extra] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !encodedHash || extra.length) return false;
  try {
    const expected = Buffer.from(encodedHash, 'base64url');
    const actual = Buffer.from(await scryptAsync(password, salt, expected.length));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sendAdminAsset(filename) {
  return (req, res) => res.sendFile(path.join(__dirname, 'src', 'admin', filename));
}

// The history-management screen is intentionally separate from the crawler UI.
// It is unavailable until an administrator password is configured in the hosting
// environment, and every data-changing endpoint requires its signed HTTP-only cookie.
app.get('/admin/login.css', sendAdminAsset('login.css'));
app.get('/admin/login.js', sendAdminAsset('login.js'));
app.get('/admin/admin.css', requireAdmin, sendAdminAsset('admin.css'));
app.get('/admin/admin.js', requireAdmin, sendAdminAsset('admin.js'));

app.get('/admin/login', (req, res) => {
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).type('text/plain').send('Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in the hosting environment.');
  const principal = getDashboardPrincipal(req);
  if (principal) {
    const requested = safeNextPath(req.query.next, '/app');
    return res.redirect(principal.role === 'Administrator' ? requested : (requested.startsWith('/admin') ? '/app' : requested));
  }
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
  const principal = getDashboardPrincipal(req, false);
  res.json({ configured: PRIVATE_ACCESS_CONFIGURED, authenticated: Boolean(principal), administrator: principal?.role === 'Administrator', role: principal?.role || null });
});

app.post('/api/admin/login', requireSameOrigin, async (req, res) => {
  if (!PRIVATE_ACCESS_CONFIGURED) return res.status(503).json({ error: 'Private access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET.' });
  const { key, attempt } = getLoginAttempt(req);
  if (attempt.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', retryAfterSeconds);
    auditSecurityEvent(req, 'admin.login', 'denied', { reason: 'rate-limited' });
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).` });
  }
  const username = normalizeUsername(req.body?.username);
  let auditor = null;
  let authenticated = false;
  if (username) {
    try {
      auditor = await crawlStorage.findActiveAuditor(username);
      authenticated = Boolean(auditor && await auditorPasswordMatches(req.body?.password, auditor.passwordHash));
    } catch (error) {
      console.error('Could not verify auditor account:', error.message);
    }
  } else {
    authenticated = passwordsMatch(req.body?.password);
  }
  if (!authenticated) {
    attempt.count++;
    auditSecurityEvent(req, 'access.login', 'denied', { reason: 'incorrect-credentials', accountType: username ? 'auditor' : 'administrator' });
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  adminLoginAttempts.delete(key);
  res.setHeader('Cache-Control', 'no-store');
  if (auditor) {
    // A browser can only operate as one account at a time. Clearing an owner
    // cookie here prevents a test sign-in from silently retaining owner access.
    const existingAdmin = getAdminSession(req, false);
    if (existingAdmin) existingAdmin.endedAt = Date.now();
    res.clearCookie('omnicrawl_admin', clearAdminCookieOptions(req));
    const created = createAuditorSession(req, auditor);
    await crawlStorage.markAuditorLoggedIn(auditor.id).catch(() => {});
    auditSecurityEvent(req, 'auditor.login', 'success', { username: auditor.username });
    res.cookie('omnicrawl_auditor', created.token, auditorCookieOptions(req));
    return res.json({ success: true, role: 'Auditor' });
  }
  const existingAuditor = getAuditorSession(req, false);
  if (existingAuditor) existingAuditor.endedAt = Date.now();
  res.clearCookie('omnicrawl_auditor', clearAuditorCookieOptions(req));
  const created = createAdminSession(req);
  auditSecurityEvent(req, 'admin.login', 'success', {}, { adminSession: created.session });
  res.cookie('omnicrawl_admin', created.token, adminCookieOptions(req));
  return res.json({ success: true, role: 'Administrator' });
});

app.post('/api/admin/logout', requireAdmin, requireSameOrigin, (req, res) => {
  const session = getAdminSession(req, false);
  if (session) session.endedAt = Date.now();
  auditSecurityEvent(req, 'admin.logout', 'success', {}, { adminSession: session });
  res.clearCookie('omnicrawl_admin', clearAdminCookieOptions(req));
  res.json({ success: true });
});

registerAdminManagementRoutes(app, {
  requireAdmin, requireSameOrigin, crawlStorage, randomUUID, normalizeUsername,
  validAuditorUsername, hashAuditorPassword, auditSecurityEvent, getAdminSession,
  auditorSessions, dashboardSessions, adminSessions, crawlCoordinator,
  revokeDashboardSession, pruneSessionRecords, serializeSession,
  activeSessionWindowMs: ACTIVE_SESSION_WINDOW_MS,
  sessionActivityRetentionMs: SESSION_ACTIVITY_RETENTION_MS
});

// The dashboard is available to both account types, so it has its own
// sign-out route. Running crawls are suspended and checkpointed before the
// dashboard session is revoked, allowing the account to resume later.
app.post('/api/access/logout', requireDashboardUser, requireSameOrigin, async (req, res) => {
  const principal = req.dashboardPrincipal;
  principal.session.endedAt = Date.now();
  for (const [dashboardId, dashboard] of dashboardSessions) {
    if (dashboard.ownerRole !== principal.role || dashboard.ownerSessionId !== principal.id) continue;
    const crawlerRecord = crawlCoordinator.get(dashboardId);
    if (crawlerRecord?.crawler?.isRunning) {
      await crawlerRecord.crawler.pauseAndWait();
      await crawlStorage.updateCrawl(crawlerRecord.crawlId, {
        status: 'paused', stats: crawlerRecord.crawler.stats, engine: crawlerRecord.crawler.getEngineStatus()
      }).catch(error => console.error('Could not persist paused crawl status:', error.message));
      await crawlStorage.updateCrawlQueue(crawlerRecord.crawlId, crawlerRecord.crawler.getResumeState())
        .catch(error => console.error('Could not persist paused crawl queue:', error.message));
      crawlerRecord.crawler.suspend();
    }
    revokeDashboardSession(dashboardId);
  }
  auditSecurityEvent(req, 'access.logout', 'success', { accountType: principal.role, ...(principal.username ? { username: principal.username } : {}) }, {
    adminSession: principal.role === 'Administrator' ? principal.session : null
  });
  if (principal.role === 'Administrator') res.clearCookie('omnicrawl_admin', clearAdminCookieOptions(req));
  else res.clearCookie('omnicrawl_auditor', clearAuditorCookieOptions(req));
  res.json({ success: true });
});

function getRequestedDashboardSessionId(req) {
  const candidate = req.get('x-crawler-session') || req.query.sessionId || '';
  return /^[a-zA-Z0-9_-]{8,128}$/.test(candidate) ? candidate : null;
}

function createDashboardSession(req, principal) {
  const now = Date.now();
  const session = {
    id: randomUUID(),
    ownerRole: principal.role,
    ownerSessionId: principal.id,
    ownerUserId: principal.userId || null,
    createdAt: now,
    lastSeenAt: now,
    ip: getClientIp(req),
    userAgent: req.get('user-agent') || 'Unknown user agent'
  };
  dashboardSessions.set(session.id, session);
  return session;
}

function isSameDashboardAccount(session, principal) {
  if (!session || !principal) return false;
  if (session.ownerRole !== principal.role) return false;
  if (principal.role === 'Administrator') return true;
  return session.ownerUserId === principal.userId;
}

function requireDashboardSession(req, res, next) {
  pruneSessionRecords();
  const sessionId = getRequestedDashboardSessionId(req);
  if (!sessionId) return res.status(400).json({ error: 'A server-issued dashboard session is required. Refresh the dashboard and try again.' });
  const existing = dashboardSessions.get(sessionId);
  if (!existing || existing.revokedAt) {
    return res.status(403).json({ error: 'This dashboard session has been revoked by an administrator.' });
  }
  const principal = req.dashboardPrincipal || getDashboardPrincipal(req, false);
  if (!principal || !isSameDashboardAccount(existing, principal)) {
    return res.status(403).json({ error: 'This dashboard session belongs to a different signed-in account.' });
  }
  if (existing.ownerSessionId !== principal.id) {
    existing.ownerSessionId = principal.id;
  }
  existing.lastSeenAt = Date.now();
  req.dashboardSession = existing;
  return next();
}

function getSessionCrawler(req) {
  const sessionId = req.dashboardSession?.id || getRequestedDashboardSessionId(req);
  const record = crawlCoordinator.get(sessionId);
  return { sessionId, crawler: record?.crawler || null };
}

// A crawl has exactly one controlling dashboard session. Moving it first
// removes the old mapping, then revokes that session so it cannot retain
// controls or receive a second copy of the live events.
function moveCrawlerToDashboardSession(fromSessionId, toSessionId, record) {
  if (!record || fromSessionId === toSessionId) return;
  crawlCoordinator.move(fromSessionId, toSessionId, record);
  revokeDashboardSession(fromSessionId);
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
  const crawlerRecord = crawlCoordinator.get(sessionId);
  if (crawlerRecord?.crawler?.isRunning && !crawlerRecord.crawler.isSuspended) crawlerRecord.crawler.stop();
  crawlCoordinator.remove(sessionId);
  sseHub.closeSession(sessionId, 'revoked', { message: 'This dashboard session was revoked by an administrator.' });
  return true;
}

function pruneCrawlerSessions() {
  crawlCoordinator.prune({ ttlMs: SESSION_TTL_MS, maxRetainedSessions: MAX_RETAINED_SESSIONS });
}

function getCrawlCapacity() {
  return crawlCoordinator.getCapacity();
}

// Dashboard IDs are created by the server, retained in one browser tab, and
// bound to the signed-in account session. They are not accepted simply
// because a client supplied a UUID.
app.post('/api/crawler/session', requireDashboardUser, requireSameOrigin, async (req, res) => {
  pruneSessionRecords();
  const principal = req.dashboardPrincipal;
  const requestedId = getRequestedDashboardSessionId(req);
  if (requestedId) {
    const existing = dashboardSessions.get(requestedId);
    if (existing?.revokedAt) return res.status(403).json({ error: 'This dashboard session has been revoked by an administrator.' });
    if (existing && !isSameDashboardAccount(existing, principal)) {
      return res.status(403).json({ error: 'This dashboard session belongs to a different signed-in account.' });
    }
    if (existing) {
      existing.ownerSessionId = principal.id;
      existing.lastSeenAt = Date.now();
      return res.json({ sessionId: existing.id, resumed: true });
    }
  }
  const created = createDashboardSession(req, principal);
  auditSecurityEvent(req, 'dashboard.session.created', 'success', { accountType: principal?.role }, { adminSession: principal?.role === 'Administrator' ? principal.session : null, dashboardSession: created });
  return res.status(201).json({ sessionId: created.id, resumed: false });
});

app.use('/api/crawler', requireDashboardUser, requireDashboardSession, requireSameOrigin);
app.use('/api/export', requireDashboardUser, requireDashboardSession);

function broadcastSSE(sessionId, eventType, data) {
  const session = dashboardSessions.get(sessionId);
  if (session) session.eventRevision = (session.eventRevision || 0) + 1;
  sseHub.broadcast(sessionId, eventType, { ...data, revision: session?.eventRevision || 0 });
}

function broadcastCapacity() {
  sseHub.broadcastAll('capacity', getCrawlCapacity());
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

  const newClient = sseHub.add(sessionId, res);

  sseHub.send(newClient, 'status', getDashboardStatus(sessionId, crawler));

  // Named events (not SSE comments) let the client detect proxy buffering as
  // well as broken connections. Re-check authentication on long-lived streams.
  const heartbeat = setInterval(() => {
    const session = dashboardSessions.get(sessionId);
    const principal = getDashboardPrincipal(req, false);
    if (!session || session.revokedAt || !principal || session.ownerRole !== principal.role || session.ownerSessionId !== principal.id) {
      sseHub.send(newClient, 'revoked', { message: 'Your dashboard session is no longer active. Please sign in again.' });
      res.end();
      return;
    }
    session.lastSeenAt = Date.now();
    sseHub.send(newClient, 'heartbeat', { capacity: getCrawlCapacity() });
  }, 10000);

  res.on('close', () => {
    clearInterval(heartbeat);
    sseHub.remove(newClient);
  });
});

function getDashboardStatus(sessionId, crawler) {
  return {
    revision: dashboardSessions.get(sessionId)?.eventRevision || 0,
    isRunning: crawler?.isRunning || false,
    isPaused: crawler?.isPaused || false,
    isStopping: crawler?.isCancelled || false,
    stats: crawler?.stats || null,
    queueLength: crawler?.queue.length || 0,
    config: crawler?.getConfigSummary() || null,
    engine: crawler?.getEngineStatus() || null,
    historyAudit: crawler?.historyAudit || null,
    capacity: getCrawlCapacity()
  };
}

// One synchronous snapshot keeps status, pages, links and event revision in
// agreement. Individual endpoints remain available for focused dashboard reads.
app.get('/api/crawler/snapshot', (req, res) => {
  const { sessionId, crawler } = getSessionCrawler(req);
  res.json({ ...getDashboardStatus(sessionId, crawler), results: crawler?.results || [], links: crawler?.allLinks || [] });
});

function startManagedCrawler(sessionId, crawlId, crawler) {
  return crawlCoordinator.start(sessionId, crawlId, crawler);
}

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

    let crawlRequest;
    try {
      crawlRequest = validateCrawlRequest(req.body, {
        maxWorkersPerCrawl: MAX_WORKERS_PER_CRAWL,
        maxUnlimitedCrawlPages: MAX_UNLIMITED_CRAWL_PAGES,
        allowedRegions: ALLOWED_CRAWL_REGIONS
      });
    } catch (error) {
      const message = error instanceof CrawlRequestValidationError ? error.message : 'Invalid crawl configuration.';
      return res.status(400).json({ error: message });
    }
    const {
      crawlScope,
      maxDepth,
      maxPages: requestedMaxPages,
      noPageLimit,
      concurrency: requestedConcurrency,
      customContentSelector,
      excludePatterns,
      includePatterns,
      respectRobotsTxt,
      autoScroll,
      delayBetweenRequestsMs,
      region,
      blockCrossDomainRedirects
    } = crawlRequest;
    const requestedSeedUrl = req.body.seedUrl;

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

    const concurrency = requestedConcurrency;
    const crawlWithoutPageLimit = crawlScope !== 'single-url' && noPageLimit === true;
    const maxPages = crawlWithoutPageLimit
      ? MAX_UNLIMITED_CRAWL_PAGES
      : requestedMaxPages;

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
    if (await crawlStorage.initialize()) {
      await crawlStorage.createCrawl({
        id: crawlId,
        sessionId,
        ownerUserId: getCrawlOwnerId(req.dashboardPrincipal),
        seedUrl,
        config: crawler.getConfigSummary()
      });
    }

    const crawlPromise = startManagedCrawler(sessionId, crawlId, crawler);
    auditSecurityEvent(req, 'crawl.started', 'success', {
      crawlId,
      target: auditTarget(seedUrl),
      scope: crawlScope,
      noPageLimit: crawlWithoutPageLimit,
      requestedPageLimit: crawlWithoutPageLimit ? null : maxPages,
      maxDepth,
      workerThreads: concurrency
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
  const { sessionId, crawler } = getSessionCrawler(req);
  if (crawler?.isRunning) {
    crawler.pause();
    auditSecurityEvent(req, 'crawl.paused', 'success', { crawlId: crawlCoordinator.get(sessionId)?.crawlId || null });
    return res.json({ success: true, message: 'Crawl paused' });
  }
  res.status(400).json({ error: 'No active running crawl to pause.' });
});

app.post('/api/crawler/resume', (req, res) => {
  const { sessionId, crawler } = getSessionCrawler(req);
  if (crawler?.isRunning) {
    crawler.resume();
    auditSecurityEvent(req, 'crawl.resumed', 'success', { crawlId: crawlCoordinator.get(sessionId)?.crawlId || null });
    return res.json({ success: true, message: 'Crawl resumed' });
  }
  res.status(400).json({ error: 'No active crawl to resume.' });
});

app.post('/api/crawler/stop', (req, res) => {
  const { sessionId, crawler } = getSessionCrawler(req);
  if (crawler?.isRunning) {
    crawler.stop();
    auditSecurityEvent(req, 'crawl.stop-requested', 'success', { crawlId: crawlCoordinator.get(sessionId)?.crawlId || null });
    return res.json({ success: true, message: 'Crawl cancellation requested' });
  }
  res.status(400).json({ error: 'No active crawl to stop.' });
});

// Clear / Reset Crawl State
app.post('/api/crawler/reset', (req, res) => {
  try {
    const { sessionId, crawler } = getSessionCrawler(req);
    const crawlId = crawlCoordinator.get(sessionId)?.crawlId || null;
    const wasRunning = Boolean(crawler?.isRunning);
    if (crawler) {
      if (crawler.isRunning) {
        crawler.stop();
      }
      crawlCoordinator.remove(sessionId);
    }
    broadcastSSE(sessionId, 'reset', {});
    auditSecurityEvent(req, 'crawl.reset', 'success', { crawlId, wasRunning });
    return res.json({ success: true, message: 'Crawl state reset successfully' });
  } catch (err) {
    console.error('Failed to reset crawler:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Captures source and rendered HTML only on demand. This avoids persisting
// large documents for every page in an audit while still making DOM changes
// inspectable from the dashboard.
registerHtmlComparisonRoute(app, { getSessionCrawler, crawlStorage });

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
registerCrawlerStatusRoutes(app, { getSessionCrawler, getCrawlCapacity, crawlStorage, appRelease: APP_RELEASE });

// Persistent crawl history remains available after a deployment or process restart.
registerCrawlHistoryListRoutes(app, { crawlStorage, getCrawlOwnerId, hasCrawlAccess });

// Saved audits use small database-backed windows instead of sending every
// stored page and LONGTEXT field to the browser in one restore response.
app.get('/api/crawler/history/:crawlId/pages', async (req, res) => {
  const crawlId = req.params.crawlId;
  if (!/^[a-f0-9-]{36}$/i.test(crawlId)) return res.status(400).json({ error: 'Invalid saved crawl identifier.' });
  try {
    if (!(await hasCrawlAccess(req, crawlId))) return res.status(403).json({ error: 'You do not have access to this saved crawl.' });
    const window = await crawlStorage.getCrawlPageWindow(crawlId, {
      offset: req.query.offset,
      limit: req.query.limit,
      tab: req.query.tab,
      filter: req.query.filter,
      query: req.query.query,
      sort: req.query.sort,
      direction: req.query.direction
    });
    if (!window) return res.status(404).json({ error: 'Saved crawl not found.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(window);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load saved audit pages.' });
  }
});

app.get('/api/crawler/history/:crawlId/page', async (req, res) => {
  const crawlId = req.params.crawlId;
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!/^[a-f0-9-]{36}$/i.test(crawlId) || !url) return res.status(400).json({ error: 'Choose a valid saved page.' });
  try {
    if (!(await hasCrawlAccess(req, crawlId))) return res.status(403).json({ error: 'You do not have access to this saved crawl.' });
    const page = await crawlStorage.getCrawlPage(crawlId, url);
    if (!page) return res.status(404).json({ error: 'Saved page not found.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ page });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load the saved page.' });
  }
});

app.get('/api/crawler/history/:crawlId/links', async (req, res) => {
  const crawlId = req.params.crawlId;
  if (!/^[a-f0-9-]{36}$/i.test(crawlId)) return res.status(400).json({ error: 'Invalid saved crawl identifier.' });
  try {
    if (!(await hasCrawlAccess(req, crawlId))) return res.status(403).json({ error: 'You do not have access to this saved crawl.' });
    const window = await crawlStorage.getCrawlLinkWindow(crawlId, {
      offset: req.query.offset,
      limit: req.query.limit,
      filter: req.query.filter,
      query: req.query.query,
      sort: req.query.sort,
      direction: req.query.direction
    });
    if (!window) return res.status(404).json({ error: 'Saved crawl not found.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(window);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load saved audit links.' });
  }
});

// Resource inventories can be much larger than their parent page list. Read
// them in database-backed windows so opening a saved audit never downloads
// every CSS, JavaScript, image, font and media record at once.
app.get('/api/crawler/history/:crawlId/resources', async (req, res) => {
  const crawlId = req.params.crawlId;
  if (!/^[a-f0-9-]{36}$/i.test(crawlId)) return res.status(400).json({ error: 'Invalid saved crawl identifier.' });
  try {
    if (!(await hasCrawlAccess(req, crawlId))) return res.status(403).json({ error: 'You do not have access to this saved crawl.' });
    const window = await crawlStorage.getCrawlResourceWindow(crawlId, {
      offset: req.query.offset,
      limit: req.query.limit,
      filter: req.query.filter,
      query: req.query.query,
      sort: req.query.sort,
      direction: req.query.direction
    });
    if (!window) return res.status(404).json({ error: 'Saved crawl not found.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(window);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load saved audit resources.' });
  }
});

app.get('/api/crawler/history/:crawlId', async (req, res) => {
  try {
    const ownerUserId = await crawlStorage.getCrawlOwner(req.params.crawlId);
    if (ownerUserId === null && !(await crawlStorage.getCrawl(req.params.crawlId))) return res.status(404).json({ error: 'Saved crawl not found.' });
    if (!canAccessCrawl(req, { ownerUserId })) return res.status(403).json({ error: 'You do not have access to this saved crawl.' });
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
    const ownerUserId = await crawlStorage.getCrawlOwner(req.params.crawlId);
    if (ownerUserId === null && !(await crawlStorage.getCrawl(req.params.crawlId))) return res.status(404).json({ error: 'Saved crawl not found.' });
    if (!canAccessCrawl(req, { ownerUserId })) return res.status(403).json({ error: 'You do not have access to restore this saved crawl.' });
    const historyWindow = await crawlStorage.getCrawlPageWindow(req.params.crawlId, { limit: 50 });
    if (!historyWindow) return res.status(404).json({ error: 'Saved crawl not found.' });
    const { crawl } = historyWindow;
    const config = crawl.config || {};
    const restoredCrawler = new SiteCrawler({
      seedUrl: crawl.seedUrl,
      crawlScope: config.crawlScope,
      maxDepth: config.maxDepth,
      maxPages: config.maxPages,
      noPageLimit: config.noPageLimit,
      concurrency: config.concurrency,
      delayBetweenRequestsMs: config.delayBetweenRequestsMs,
      autoScroll: config.autoScroll,
      customContentSelector: config.customContentSelector,
      excludePatterns: config.excludePatterns || [],
      includePatterns: config.includePatterns || [],
      respectRobotsTxt: config.respectRobotsTxt,
      region: config.region,
      blockCrossDomainRedirects: config.blockCrossDomainRedirects
    });
    restoredCrawler.results = historyWindow.results;
    restoredCrawler.allLinks = [];
    restoredCrawler.historyAudit = {
      crawlId: crawl.id, totalPages: historyWindow.counts.all, loadedPages: historyWindow.results.length,
      totalResources: historyWindow.resourceTotal || 0
    };
    restoredCrawler.stats = crawl.stats || { ...restoredCrawler.stats, pagesCrawled: historyWindow.counts.all, endTime: Date.now() };
    restoredCrawler.queue = [];
    restoredCrawler.isRunning = false;
    restoredCrawler.isPaused = false;
    restoredCrawler.engineMode = crawl.engine?.mode || 'browser';
    restoredCrawler.engineProvider = crawl.engine?.provider || null;
    restoredCrawler.engineError = crawl.engine?.error || null;
    crawlCoordinator.attach(sessionId, crawl.id, restoredCrawler);
    broadcastSSE(sessionId, 'restored', { crawlId: crawl.id, stats: restoredCrawler.stats, engine: restoredCrawler.getEngineStatus(), historyAudit: restoredCrawler.historyAudit });
    return res.json({ success: true, crawl, restoredPages: historyWindow.counts.all, loadedPages: historyWindow.results.length });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not restore the saved crawl.' });
  }
});

app.post('/api/crawler/history/:crawlId/resume', async (req, res) => {
  const { sessionId, crawler: currentCrawler } = getSessionCrawler(req);
  if (currentCrawler?.isRunning) return res.status(409).json({ error: 'Pause or stop the current crawl before resuming saved history.' });
  try {
    const history = await crawlStorage.getCrawlResumeData(req.params.crawlId);
    if (!history) return res.status(404).json({ error: 'Saved crawl not found.' });
    if (!canAccessCrawl(req, history.crawl)) return res.status(403).json({ error: 'You do not have access to resume this crawl.' });
    if (history.crawl.status === 'completed') return res.status(409).json({ error: 'Completed crawls cannot be resumed.' });

    // A valid owner can reclaim a still-running in-memory crawl after an
    // expired browser session. Transfer ownership rather than leaving two
    // dashboard sessions able to control the same worker pool.
    const activeCrawl = crawlCoordinator.findActiveByCrawlId(history.crawl.id);
    if (activeCrawl) {
      moveCrawlerToDashboardSession(activeCrawl.sessionId, sessionId, activeCrawl.record);
      broadcastSSE(sessionId, 'resumed', { reconnected: true });
      return res.json({ success: true, crawlId: activeCrawl.record.crawlId, message: 'Reconnected to active crawl', reconnected: true });
    }

    const capacity = getCrawlCapacity();
    if (capacity.activeCrawls >= capacity.maxConcurrentCrawls) {
      return res.status(429).json({ error: 'All crawl slots are occupied. Try again when another crawl finishes.', capacity });
    }

    const pendingQueue = Array.isArray(history.crawl.queue) ? history.crawl.queue : [];
    if (pendingQueue.length === 0) {
      return res.status(409).json({ error: 'This crawl has no saved pending queue. Start a new crawl instead.' });
    }
    const config = history.crawl.config || {};
    const resumedCrawler = new SiteCrawler({
      seedUrl: history.crawl.seedUrl,
      crawlScope: config.crawlScope,
      maxDepth: config.maxDepth,
      maxPages: config.maxPages,
      noPageLimit: config.noPageLimit,
      concurrency: config.concurrency,
      delayBetweenRequestsMs: config.delayBetweenRequestsMs,
      autoScroll: config.autoScroll,
      customContentSelector: config.customContentSelector,
      excludePatterns: config.excludePatterns || [],
      includePatterns: config.includePatterns || [],
      respectRobotsTxt: config.respectRobotsTxt,
      region: config.region,
      blockCrossDomainRedirects: config.blockCrossDomainRedirects,
      networkPolicy: crawlNetworkPolicy,
      linkCheckConcurrency: LINK_CHECK_CONCURRENCY,
      linkCheckDeadlineMs: LINK_CHECK_DEADLINE_MS,
      isResumed: true,
      resumedQueue: pendingQueue,
      resumedVisited: history.crawl.visited,
      resumedResults: history.results,
      resumedAllLinks: [],
      resumedStats: history.crawl.stats,
      resumedNextPageId: history.crawl.nextPageId || history.totalPages + 1,
      resumedRedirectAliases: history.crawl.redirectAliases
    });
    resumedCrawler.historyAudit = {
      crawlId: history.crawl.id, totalPages: history.totalPages, loadedPages: history.results.length,
      totalResources: history.totalResources
    };
    startManagedCrawler(sessionId, history.crawl.id, resumedCrawler);
    auditSecurityEvent(req, 'crawl.resumed-from-history', 'success', { crawlId: history.crawl.id });
    return res.json({ success: true, crawlId: history.crawl.id, message: 'Crawl resumed' });
  } catch (error) {
    console.error('Failed to resume saved crawl:', error.message);
    return res.status(500).json({ error: error.message || 'Could not resume the saved crawl.' });
  }
});

// Export routes share dashboard-session access middleware registered above.
registerExportRoutes(app, { getSessionCrawler, crawlStorage, Exporter });

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  🕷️ CrawlLoom is running!`);
  console.log(`  🔗 Open Dashboard: http://localhost:${PORT}`);
  console.log(`  📦 Release: ${APP_RELEASE}`);
  console.log(`  ⚙️  Crawl Capacity: ${MAX_CONCURRENT_CRAWLS} simultaneous crawl(s), ${MAX_WORKERS_PER_CRAWL} worker(s) each`);
  console.log(`======================================================\n`);
});
