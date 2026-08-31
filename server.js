import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { SiteCrawler } from './src/engine/crawler.js';
import { Exporter } from './src/engine/exporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'src', 'public')));

let activeCrawler = null;
let sseClients = [];

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {}
  });
}

// SSE Stream for real-time crawler updates
app.get('/api/crawler/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  if (activeCrawler) {
    res.write(`event: status\ndata: ${JSON.stringify({
      isRunning: activeCrawler.isRunning,
      isPaused: activeCrawler.isPaused,
      stats: activeCrawler.stats,
      queueLength: activeCrawler.queue.length,
      config: activeCrawler.getConfigSummary()
    })}\n\n`);
  }

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Start Crawl Endpoint
app.post('/api/crawler/start', async (req, res) => {
  if (activeCrawler && activeCrawler.isRunning) {
    return res.status(400).json({ error: 'A crawl is already running. Please stop or wait for it to finish.' });
  }

  const {
    seedUrl,
    crawlScope = 'domain',
    maxDepth = 3,
    maxPages = 50,
    concurrency = 2,
    customContentSelector = '',
    excludePatterns = [],
    includePatterns = [],
    respectRobotsTxt = false,
    autoScroll = true,
    delayBetweenRequestsMs = 500,
    region = 'auto',
    proxy = '',
    blockCrossDomainRedirects = true
  } = req.body;

  if (!seedUrl) {
    return res.status(400).json({ error: 'Seed URL is required.' });
  }

  activeCrawler = new SiteCrawler({
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
    proxy: proxy.trim() || null,
    blockCrossDomainRedirects
  });

  // Attach event handlers
  activeCrawler.on('started', data => broadcastSSE('started', data));
  activeCrawler.on('pageCrawled', data => broadcastSSE('pageCrawled', data));
  activeCrawler.on('paused', () => broadcastSSE('paused', {}));
  activeCrawler.on('resumed', () => broadcastSSE('resumed', {}));
  activeCrawler.on('stopped', () => broadcastSSE('stopped', {}));
  activeCrawler.on('completed', data => broadcastSSE('completed', data));
  activeCrawler.on('error', data => broadcastSSE('error', data));

  // Run in background
  activeCrawler.start().catch(err => {
    console.error('Crawler engine error:', err);
    broadcastSSE('error', { message: err.message });
  });

  return res.json({ success: true, message: 'Crawl started', config: activeCrawler.getConfigSummary() });
});

// Controls
app.post('/api/crawler/pause', (req, res) => {
  if (activeCrawler && activeCrawler.isRunning) {
    activeCrawler.pause();
    return res.json({ success: true, message: 'Crawl paused' });
  }
  res.status(400).json({ error: 'No active running crawl to pause.' });
});

app.post('/api/crawler/resume', (req, res) => {
  if (activeCrawler && activeCrawler.isRunning) {
    activeCrawler.resume();
    return res.json({ success: true, message: 'Crawl resumed' });
  }
  res.status(400).json({ error: 'No active crawl to resume.' });
});

app.post('/api/crawler/stop', (req, res) => {
  if (activeCrawler && activeCrawler.isRunning) {
    activeCrawler.stop();
    return res.json({ success: true, message: 'Crawl stopped' });
  }
  res.status(400).json({ error: 'No active crawl to stop.' });
});

// Status & Results
app.get('/api/crawler/status', (req, res) => {
  if (!activeCrawler) {
    return res.json({ isRunning: false, stats: null, resultsCount: 0 });
  }
  res.json({
    isRunning: activeCrawler.isRunning,
    isPaused: activeCrawler.isPaused,
    stats: activeCrawler.stats,
    queueLength: activeCrawler.queue.length,
    resultsCount: activeCrawler.results.length,
    config: activeCrawler.getConfigSummary()
  });
});

app.get('/api/crawler/results', (req, res) => {
  if (!activeCrawler) return res.json({ results: [] });
  res.json({ results: activeCrawler.results });
});

app.get('/api/crawler/links', (req, res) => {
  if (!activeCrawler) return res.json({ links: [] });
  res.json({ links: activeCrawler.allLinks });
});

// Export Endpoints
app.get('/api/export/pages.csv', (req, res) => {
  if (!activeCrawler || !activeCrawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  const csv = Exporter.generatePagesCSV(activeCrawler.results);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="seo_pages_crawl_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/export/links.csv', (req, res) => {
  if (!activeCrawler || !activeCrawler.allLinks.length) {
    return res.status(400).send('No links data available to export.');
  }
  const csv = Exporter.generateLinksCSV(activeCrawler.allLinks);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="all_links_crawl_${Date.now()}.csv"`);
  res.send(csv);
});

app.get(['/api/export/custom-content.csv', '/api/export/kentico.csv'], (req, res) => {
  if (!activeCrawler || !activeCrawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  const csv = Exporter.generateCustomContentReportCSV(activeCrawler.results);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="custom_content_report_${Date.now()}.csv"`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  🕷️ Browser SEO Spider is running!`);
  console.log(`  🔗 Open Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
