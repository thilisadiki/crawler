export function registerHtmlComparisonRoute(app, { getSessionCrawler, crawlStorage }) {
  app.get('/api/crawler/page-html', async (req, res) => {
    const { crawler } = getSessionCrawler(req);
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!crawler || !url) return res.status(400).json({ error: 'Choose an audited page before viewing its HTML.' });
    if (crawler.isRunning) return res.status(409).json({ error: 'Wait for the crawl to finish before opening an HTML comparison.' });
    let auditedPage = crawler.results.find(page => page.url === url);
    if (!auditedPage && crawler.historyAudit?.crawlId) {
      try { auditedPage = await crawlStorage.getCrawlPage(crawler.historyAudit.crawlId, url); }
      catch (error) { return res.status(500).json({ error: error.message || 'Could not verify the saved page.' }); }
    }
    if (!auditedPage) return res.status(404).json({ error: 'That page is not part of this crawl session.' });
    try { return res.json(await crawler.captureHtmlComparison(auditedPage.url)); }
    catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : 'Could not capture the HTML comparison.' }); }
  });
}
