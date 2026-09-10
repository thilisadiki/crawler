import path from 'path';

// Public product/information pages and the protected dashboard entry point.
// Keeping these routes together leaves server.js to compose dependencies.
export function registerPublicRoutes(app, { publicDir, publicAppUrl, requireDashboardAccess, staticMiddleware }) {
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'home.html')));
  app.get('/app', requireDashboardAccess, (req, res) => res.sendFile(path.join(publicDir, 'next', 'index.html')));
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
