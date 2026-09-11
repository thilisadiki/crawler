// Lightweight live-crawl reads. Mutating controls and history restoration stay
// in the lifecycle route group so ownership transfer remains atomic.
export function registerCrawlerStatusRoutes(app, { getSessionCrawler, getCrawlCapacity, crawlStorage, appRelease }) {
  app.get('/api/crawler/status', (req, res) => {
    const { crawler } = getSessionCrawler(req);
    if (!crawler) return res.json({ release: appRelease, isRunning: false, stats: null, resultsCount: 0, engine: null, capacity: getCrawlCapacity(), storage: crawlStorage.getStatus() });
    return res.json({
      release: appRelease, isRunning: crawler.isRunning, isPaused: crawler.isPaused,
      isStopping: crawler.isCancelled, stats: crawler.stats, lastError: crawler.lastError || null,
      queueLength: crawler.queue.length, resultsCount: crawler.results.length,
      config: crawler.getConfigSummary(), engine: crawler.getEngineStatus(),
      capacity: getCrawlCapacity(), storage: crawlStorage.getStatus()
    });
  });
  app.get('/api/crawler/results', (req, res) => {
    const { crawler } = getSessionCrawler(req);
    res.json({ results: crawler?.results || [] });
  });
  app.get('/api/crawler/links', (req, res) => {
    const { crawler } = getSessionCrawler(req);
    res.json({ links: crawler?.allLinks || [] });
  });
}
