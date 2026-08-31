process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

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
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disables Nginx buffering on Hostinger / Cloud
  res.setHeader('Access-Control-Allow-Origin', '*');
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

// Start Crawl
app.post('/api/crawler/start', (req, res) => {
  try {
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
    } = req.body || {};

    if (!seedUrl) {
      return res.status(400).json({ error: 'Seed URL is required.' });
    }

    const cleanProxy = (proxy && typeof proxy === 'string') ? proxy.trim() || null : null;

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
      proxy: cleanProxy,
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
  } catch (err) {
    console.error('Failed to start crawler:', err);
    return res.status(500).json({ error: err.message });
  }
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

// Clear / Reset Crawl State
app.post('/api/crawler/reset', (req, res) => {
  try {
    if (activeCrawler) {
      if (activeCrawler.isRunning) {
        activeCrawler.stop();
      }
      activeCrawler = null;
    }
    broadcastSSE('reset', {});
    return res.json({ success: true, message: 'Crawl state reset successfully' });
  } catch (err) {
    console.error('Failed to reset crawler:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Debug Diagnostic Endpoint
app.get('/api/debug/browser', async (req, res) => {
  try {
    const { chromium } = await import('playwright');
    const { findChromiumExecutable } = await import('./src/engine/browser.js');
    
    const detectedExe = findChromiumExecutable();
    console.log('Attempting debug chromium launch with detected executable:', detectedExe);
    
    const launchOptions = {
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    };
    if (detectedExe) launchOptions.executablePath = detectedExe;

    const b = await chromium.launch(launchOptions);
    const v = b.version();
    await b.close();
    res.json({ success: true, chromiumVersion: v, detectedExecutable: detectedExe, message: 'Chromium launched and closed successfully!' });
  } catch (err) {
    console.error('Debug launch error:', err);
    res.status(500).json({
      success: false,
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack
    });
  }
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
    lastError: activeCrawler.lastError || null,
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
app.get(['/api/export/workbook.xlsx', '/api/export/excel'], async (req, res) => {
  if (!activeCrawler || !activeCrawler.results.length) {
    return res.status(400).send('No crawl data available to export.');
  }
  try {
    const buffer = await Exporter.generateMultiSheetWorkbook(activeCrawler.results, activeCrawler.allLinks);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="OmniCrawl_MultiSheet_Report_${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Error generating Excel workbook:', err);
    res.status(500).send('Error generating Excel workbook: ' + err.message);
  }
});

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
