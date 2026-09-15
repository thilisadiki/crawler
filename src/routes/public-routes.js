import path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';

// Public product/information pages and the protected dashboard entry point.
// Keeping these routes together leaves server.js to compose dependencies.
export function registerPublicRoutes(app, { publicDir, publicAppUrl, requireDashboardAccess, staticMiddleware, crawlStorage, hashAuditorPassword }) {
  const emailFrom = process.env.EMAIL_FROM || 'CrawlLoom <hello@crawler.thilisadiki.com>';
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'home.html')));
  app.get('/app', requireDashboardAccess, (req, res) => res.sendFile(path.join(publicDir, 'next', 'index.html')));
  app.get('/signup', (req, res) => res.sendFile(path.join(publicDir, 'signup.html')));
  app.get('/set-password', (req, res) => res.sendFile(path.join(publicDir, 'set-password.html')));
  app.post('/api/public/signup', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (name.length < 2 || name.length > 160 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid name and email address.' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Sign-up email is not configured yet.' });
    try {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await crawlStorage.createSignup({ id: randomUUID(), name, email, tokenHash, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
      const verifyUrl = `${publicAppUrl}/set-password?token=${encodeURIComponent(token)}`;
      const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: emailFrom, to: [email], subject: 'Verify your CrawlLoom email', text: `Hi ${name},\n\nVerify your CrawlLoom email and create your auditor password here:\n${verifyUrl}\n\nThis link expires in 24 hours.` }) });
      if (!response.ok) throw new Error('Email provider rejected the message.');
      return res.json({ success: true });
    } catch (error) { console.error('Signup email failed:', error.message); return res.status(503).json({ error: 'We could not send the verification email. Please try again.' }); }
  });
  app.post('/api/public/set-password', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < 12) return res.status(400).json({ error: 'Use a password of at least 12 characters.' });
    try {
      const signup = await crawlStorage.findSignupByToken(createHash('sha256').update(token).digest('hex'));
      if (!signup || signup.usedAt || new Date(signup.expiresAt).getTime() <= Date.now()) return res.status(400).json({ error: 'This verification link is invalid or expired.' });
      await crawlStorage.completeSignup({ signupId: signup.id, userId: randomUUID(), username: signup.email, passwordHash: await hashAuditorPassword(password) });
      return res.json({ success: true });
    } catch (error) { return res.status(400).json({ error: error.message || 'Could not create your account.' }); }
  });
  app.get('/index.html', (req, res) => res.redirect(301, '/'));
  app.use('/next', requireDashboardAccess);
  app.use(staticMiddleware);

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /api\nDisallow: /next\n\nSitemap: ${publicAppUrl}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    const pages = ['', '/about', '/privacy', '/terms', '/acceptable-use', '/docs'];
    const urls = pages.map(page => `  <url><loc>${publicAppUrl}${page}/</loc></url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  });

  const sendInformationPage = filename => (req, res) => res.sendFile(path.join(publicDir, 'info', filename));
  app.get('/about', sendInformationPage('about.html'));
  app.get('/docs', sendInformationPage('docs.html'));
  app.get('/privacy', sendInformationPage('privacy.html'));
  app.get('/terms', sendInformationPage('terms.html'));
  app.get('/acceptable-use', sendInformationPage('acceptable-use.html'));
}
