// Read-only history index and comparison endpoints.
export function registerCrawlHistoryListRoutes(app, { crawlStorage, getCrawlOwnerId, hasCrawlAccess }) {
  app.get('/api/crawler/history', async (req, res) => {
    try {
      const isAdmin = req.dashboardPrincipal?.role === 'Administrator';
      const crawls = await crawlStorage.listCrawls(req.query.limit, getCrawlOwnerId(req.dashboardPrincipal), isAdmin);
      res.json({ storage: crawlStorage.getStatus(), crawls });
    } catch (error) {
      res.status(500).json({ error: error.message, storage: crawlStorage.getStatus() });
    }
  });
  app.get('/api/crawler/history/compare', async (req, res) => {
    const previousId = typeof req.query.previousId === 'string' ? req.query.previousId : '';
    const currentId = typeof req.query.currentId === 'string' ? req.query.currentId : '';
    if (!/^[a-f0-9-]{36}$/i.test(previousId) || !/^[a-f0-9-]{36}$/i.test(currentId)) {
      return res.status(400).json({ error: 'Choose two valid saved crawls to compare.' });
    }
    try {
      if (!(await hasCrawlAccess(req, previousId)) || !(await hasCrawlAccess(req, currentId))) {
        return res.status(403).json({ error: 'You do not have access to compare one or both saved crawls.' });
      }
      return res.json(await crawlStorage.compareCrawls(previousId, currentId));
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Could not compare the saved crawls.' });
    }
  });
}
