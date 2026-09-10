// Export endpoints operate on the current dashboard crawl or its saved audit.
export function registerExportRoutes(app, { getSessionCrawler, crawlStorage, Exporter }) {
  const getExportData = async crawler => {
    if (!crawler) return null;
    if (!crawler.historyAudit?.crawlId) return { results: crawler.results, links: crawler.allLinks };
    try {
      const history = await crawlStorage.getCrawl(crawler.historyAudit.crawlId);
      if (!history) return null;
      return {
        results: history.results,
        links: history.results.flatMap(page => (page.links || []).map(link => ({
          ...link,
          sourceUrl: page.url,
          targetUrl: link.targetUrl || link.url || ''
        })))
      };
    } catch (error) {
      console.error('Could not load the full saved audit for export:', error.message);
      return null;
    }
  };
  const withData = handler => async (req, res) => {
    const { crawler } = getSessionCrawler(req);
    const exportData = await getExportData(crawler);
    return handler(req, res, exportData);
  };

  app.get(['/api/export/workbook.xlsx', '/api/export/excel'], withData(async (req, res, data) => {
    if (!data?.results.length) return res.status(400).send('No crawl data available to export.');
    try {
      const buffer = await Exporter.generateMultiSheetWorkbook(data.results, data.links);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="CrawlLoom_MultiSheet_Report_${Date.now()}.xlsx"`);
      res.send(buffer);
    } catch (error) {
      console.error('Error generating Excel workbook:', error);
      res.status(500).send(`Error generating Excel workbook: ${error.message}`);
    }
  }));
  app.get('/api/export/pages.csv', withData((req, res, data) => {
    if (!data?.results.length) return res.status(400).send('No crawl data available to export.');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="seo_pages_crawl_${Date.now()}.csv"`);
    res.send(Exporter.generatePagesCSV(data.results));
  }));
  app.get('/api/export/links.csv', withData((req, res, data) => {
    if (!data?.links.length) return res.status(400).send('No links data available to export.');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="all_links_crawl_${Date.now()}.csv"`);
    res.send(Exporter.generateLinksCSV(data.links));
  }));
  app.get('/api/export/issues.csv', withData((req, res, data) => {
    if (!data?.results.length) return res.status(400).send('No crawl data available to export.');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="seo_issues_crawl_${Date.now()}.csv"`);
    res.send(Exporter.generateIssuesCSV(data.results, data.links));
  }));
  app.get('/api/export/resources.csv', withData((req, res, data) => {
    if (!data?.results.length) return res.status(400).send('No crawl data available to export.');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="resources_assets_crawl_${Date.now()}.csv"`);
    res.send(Exporter.generateResourcesCSV(data.results));
  }));
  app.get('/api/export/images.csv', withData((req, res, data) => {
    if (!data?.results.length) return res.status(400).send('No crawl data available to export.');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="image_seo_crawl_${Date.now()}.csv"`);
    res.send(Exporter.generateImagesCSV(data.results));
  }));
  app.get(['/api/export/custom-content.csv', '/api/export/kentico.csv'], withData((req, res, data) => {
    if (!data?.results.length) return res.status(400).send('No crawl data available to export.');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="custom_content_report_${Date.now()}.csv"`);
    res.send(Exporter.generateCustomContentReportCSV(data.results));
  }));
}
