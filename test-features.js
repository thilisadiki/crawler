import assert from 'assert';
import http from 'http';
import * as cheerio from 'cheerio';
import { RobotsParser } from './src/engine/robots.js';
import { SiteCrawler } from './src/engine/crawler.js';
import { Exporter } from './src/engine/exporter.js';
import { Extractor } from './src/engine/extractor.js';
import { LinkStatusChecker } from './src/engine/statusChecker.js';
import { CrawlNetworkPolicy, isBlockedIpAddress } from './src/security/network-policy.js';
import { CrawlRequestValidationError, validateCrawlRequest } from './src/security/crawl-request-validation.js';

async function runTests() {
  const publicTestPolicy = new CrawlNetworkPolicy({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  console.log('--- 1. Testing RobotsParser ---');
  const sampleRobots = `
    User-agent: *
    Disallow: /admin/
    Disallow: /private/
    Allow: /admin/public/
    Disallow: /*.pdf$
  `;
  const parser = new RobotsParser(sampleRobots);
  assert.strictEqual(parser.isAllowed('https://example.com/'), true, 'Root should be allowed');
  assert.strictEqual(parser.isAllowed('https://example.com/blog/article'), true, 'Blog should be allowed');
  assert.strictEqual(parser.isAllowed('https://example.com/admin/settings'), false, 'Admin should be disallowed');
  assert.strictEqual(parser.isAllowed('https://example.com/admin/public/page'), true, 'Allowed subpath under admin should be allowed');
  assert.strictEqual(parser.isAllowed('https://example.com/document.pdf'), false, 'PDF should be disallowed');
  console.log('✅ RobotsParser tests passed');

  console.log('--- 2. Testing Exporter CSV Generation ---');
  const sampleResults = [
    {
      url: 'https://example.com/test',
      statusCode: 200,
      responseTimeMs: 120,
      title: 'Test Page, with "Quotes"',
      metaDescription: 'Description',
      canonical: 'https://example.com/test',
      metaRobots: 'index, follow',
      h1: 'Header 1',
      h2List: ['Subheader A', 'Subheader B'],
      totalWords: 450,
      imagesCount: 3,
      customContent: { detected: true, wordCount: 150, headings: ['H2: Features'], textSnippet: 'Snippet' },
      customLinksCount: 2,
      internalLinksCount: 5,
      externalLinksCount: 1,
      renderComparison: { available: true, domChanged: true, sourceHtmlBytes: 120, renderedHtmlBytes: 280, sourceWordCount: 2, renderedWordCount: 8, renderedOnlyWordCount: 4 },
      resources: [{
        url: 'https://example.com/assets/site.css', resourceType: 'Stylesheet', element: 'link', attribute: 'href',
        statusCode: 200, sizeBytes: 2048, discoveryStatus: 'Loaded'
      }],
      error: null,
      timestamp: new Date().toISOString()
    }
  ];
  const pagesCsv = Exporter.generatePagesCSV(sampleResults);
  assert(pagesCsv.includes('https://example.com/test'), 'CSV should contain URL');
  assert(pagesCsv.includes('Content Area Detected'), 'CSV should contain the content detection header');
  assert(pagesCsv.includes('DOM Changed After Rendering'), 'CSV should include source-versus-rendered comparison fields');
  const issuesCsv = Exporter.generateIssuesCSV(sampleResults);
  assert(issuesCsv.includes('Severity,Issue,Issue Code'), 'Issues CSV should contain issue headers');
  assert(issuesCsv.includes('Title is too short'), 'Issues CSV should contain detected issues');
  const resourcesCsv = Exporter.generateResourcesCSV(sampleResults);
  assert(resourcesCsv.includes('Type,URL,Discovery Status'), 'Resources CSV should contain resource headers');
  assert(resourcesCsv.includes('site.css'), 'Resources CSV should contain the asset URL');
  const duplicateText = Array.from({ length: 120 }, () => 'identical editorial content').join(' ');
  const duplicatePages = ['one', 'two'].map(path => ({
    url: `https://example.com/${path}`, statusCode: 200, title: `A distinct descriptive title for ${path}`,
    metaDescription: `A distinct meta description for ${path} that is long enough for this duplicate-content test fixture.`,
    canonical: `https://example.com/${path}`, h1: `Heading ${path}`, totalWords: 360, fullPageText: duplicateText
  }));
  const duplicateIssues = Exporter.getSEOIssues(duplicatePages);
  assert.strictEqual(duplicateIssues.filter(issue => issue.code === 'duplicate-content').length, 2, 'Every exact duplicate page should receive a duplicate-content issue');
  console.log('✅ Exporter tests passed');

  console.log('--- 3. Testing Single URL Scope Crawl ---');
  const singleCrawler = new SiteCrawler({
    seedUrl: 'https://example.com',
    crawlScope: 'single-url',
    autoScroll: false,
    networkPolicy: publicTestPolicy
  });
  await singleCrawler.start();
  assert.strictEqual(singleCrawler.results.length, 1, 'Single URL scope must only crawl 1 page');
  if (singleCrawler.isBrowserMode) {
    assert.strictEqual(singleCrawler.results[0].renderComparison?.available, true, 'Browser crawls should retain source-versus-rendered DOM metrics');
  } else {
    assert.strictEqual(singleCrawler.results[0].renderMode, 'direct-dom', 'A browser-unavailable environment should use the direct DOM fallback');
  }
  console.log('✅ Single URL Scope test passed');

  console.log('--- 4. Testing Exclusion Regex Filter ---');
  const excludeCrawler = new SiteCrawler({
    seedUrl: 'https://example.com',
    crawlScope: 'domain',
    excludePatterns: ['/cart', '.*\\.pdf$']
  });
  assert.strictEqual(excludeCrawler.isUrlAllowedInScope('https://example.com/cart/checkout'), false, 'Should be excluded by pattern');
  assert.strictEqual(excludeCrawler.isUrlAllowedInScope('https://example.com/other/page'), true, 'Should be allowed');
  console.log('✅ Exclusion filter tests passed');

  console.log('--- 5. Testing Bare-Domain to WWW Redirect Scope ---');
  const redirectScopeCrawler = new SiteCrawler({
    seedUrl: 'https://example.co.za',
    crawlScope: 'domain'
  });
  assert.strictEqual(
    redirectScopeCrawler.adoptSeedRedirect('https://www.example.co.za/', 0),
    true,
    'A same-site www redirect should become the effective crawl origin'
  );
  assert.strictEqual(redirectScopeCrawler.baseHostname, 'www.example.co.za', 'The effective hostname should be adopted');
  assert.strictEqual(
    redirectScopeCrawler.isUrlAllowedInScope('https://www.example.co.za/next-page'),
    true,
    'Links on the effective www hostname should remain in domain scope'
  );
  assert.strictEqual(
    redirectScopeCrawler.isUrlAllowedInScope('https://example.co.za/alternate'),
    true,
    'Bare and www hostname aliases should be treated as one site'
  );
  assert.strictEqual(
    redirectScopeCrawler.isUrlAllowedInScope('https://account.example.co.za/login'),
    false,
    'Unrelated subdomains must remain outside hostname scope'
  );
  assert.strictEqual(
    redirectScopeCrawler.adoptSeedRedirect('https://unrelated-site.example/', 0),
    false,
    'A cross-site redirect must never expand the crawl scope'
  );
  redirectScopeCrawler.visited.add('https://example.co.za/');
  redirectScopeCrawler.registerRedirectDestination('https://example.co.za/', 'https://www.example.co.za/');
  assert.strictEqual(
    redirectScopeCrawler.addToQueue('https://www.example.co.za/', 1, 'https://www.example.co.za/'),
    false,
    'The final URL of an already-audited redirect must not be queued a second time'
  );
  const normalizedAliases = redirectScopeCrawler.normalizeInternalLinkAliases([{
    url: 'https://example.co.za/contact', linkType: 'External', isInternal: false, isValidHttp: true
  }]);
  assert.strictEqual(normalizedAliases[0].linkType, 'Internal', 'Bare/www alias links should be reclassified as internal');
  console.log('✅ Redirect scope tests passed');

  console.log('--- 6. Testing Redirect Chain Recording ---');
  const redirectServer = http.createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(301, { Location: '/middle' });
    } else if (req.url === '/middle') {
      res.writeHead(302, { Location: '/final' });
    } else if (req.url === '/final') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Final destination');
      return;
    } else {
      res.writeHead(404);
    }
    res.end();
  });
  await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = redirectServer.address();
    const redirectUrl = `http://127.0.0.1:${port}/old`;
    const checked = await new LinkStatusChecker({ timeoutMs: 3000 }).checkUrl(redirectUrl);
    assert.strictEqual(checked.statusCode, 301, 'The requested URL must retain its redirect status');
    assert.strictEqual(checked.finalStatusCode, 200, 'The destination response status must be retained separately');
    assert.strictEqual(checked.finalUrl, `http://127.0.0.1:${port}/final`, 'The final redirect destination should be recorded');
    assert.strictEqual(checked.redirectChain.length, 2, 'Every redirect hop should be retained');
    assert.strictEqual(checked.redirectChain[1].statusCode, 302, 'Intermediate redirect status should be retained');
  } finally {
    await new Promise(resolve => redirectServer.close(resolve));
  }
  console.log('✅ Redirect chain tests passed');

  console.log('--- 7. Testing Source vs Rendered DOM Comparison ---');
  const comparison = SiteCrawler.compareSourceAndRenderedHtml(
    '<html><body><main><p>Static introduction</p></main><script src="app.js"></script></body></html>',
    '<html><body><main><p>Static introduction</p><p>Client rendered promotion</p></main><script src="app.js"></script><div id="app"></div></body></html>'
  );
  assert.strictEqual(comparison.available, true, 'Browser HTML comparison should be available for two documents');
  assert.strictEqual(comparison.domChanged, true, 'Rendered DOM changes should be identified');
  assert(comparison.renderedWordCount > comparison.sourceWordCount, 'Rendered text should have a higher word count');
  assert(comparison.renderedOnlyWordCount > 0, 'Client-rendered words should be identified');
  const recoveredLinks = singleCrawler.mergeDiscoveredLinks(
    [{ url: 'https://example.com/visible', rawHref: '/visible', anchorText: 'Visible', isValidHttp: true }],
    [
      { url: 'https://example.com/visible', rawHref: '/visible', anchorText: 'Visible', isValidHttp: true },
      { url: 'https://example.com/source-only', rawHref: '/source-only', anchorText: 'Source only', isValidHttp: true }
    ]
  );
  assert.strictEqual(recoveredLinks.length, 2, 'Source-only navigation should supplement a sparse rendered DOM without duplicates');
  console.log('✅ Source/rendered DOM comparison tests passed');

  console.log('--- 8. Testing Browser Disconnect Detection ---');
  assert.strictEqual(
    excludeCrawler.isBrowserDisconnectError(new Error('browserContext.newPage: Target page, context or browser has been closed')),
    true,
    'Closed browser contexts should trigger Chromium recovery'
  );
  assert.strictEqual(
    excludeCrawler.isBrowserDisconnectError(new Error('Navigation timed out after 30000ms')),
    false,
    'Ordinary page errors should not restart the shared browser'
  );
  console.log('✅ Browser disconnect detection tests passed');

  console.log('--- 9. Testing Immediate Crawl Cancellation State ---');
  const cancellationCrawler = new SiteCrawler({ seedUrl: 'https://example.com' });
  cancellationCrawler.isRunning = true;
  cancellationCrawler.abortController = new AbortController();
  cancellationCrawler.queue = [{ url: 'https://example.com/queued', depth: 1 }];
  cancellationCrawler.stop();
  assert.strictEqual(cancellationCrawler.isCancelled, true, 'Stop should mark the crawl as cancelled');
  assert.strictEqual(cancellationCrawler.abortController.signal.aborted, true, 'Stop should abort active HTTP work');
  assert.strictEqual(cancellationCrawler.queue.length, 0, 'Stop should discard queued URLs');
  console.log('✅ Immediate cancellation state test passed');

  console.log('--- 10. Testing Content-Area Selector and Heuristic Detection ---');
  const contentWords = Array.from({ length: 180 }, () => 'meaningful').join(' ');
  const selectorResult = Extractor.extractFromHtml(`
    <html><body><nav>Home Casino Sport</nav><div class="copy-section"><h2>Download the app</h2><p>${contentWords}</p><p>Useful editorial copy.</p></div><footer>Terms Privacy</footer></body></html>
  `, 'https://example.com/app', 'https://example.com', { cheerio });
  assert.strictEqual(selectorResult.customContent.detected, true, 'Known content-block aliases should be detected');
  assert.strictEqual(selectorResult.customContent.selectorUsed, '.copy-section', 'The copy-section selector should be recorded');
  assert.strictEqual(selectorResult.customContent.detectionMethod, 'selector', 'Known selectors should be marked as selector detection');

  const heuristicResult = Extractor.extractFromHtml(`
    <html><body><nav>${Array.from({ length: 100 }, () => 'navigation').join(' ')}</nav><section class="campaign-panel"><h2>Useful campaign guide</h2><p>${contentWords}</p><p>Additional explanatory editorial content. <a href="/inside-content">Read more</a></p></section><footer><a href="/terms">Terms</a> Privacy</footer></body></html>
  `, 'https://example.com/campaign', 'https://example.com', { cheerio });
  assert.strictEqual(heuristicResult.customContent.detected, true, 'Text-rich unknown containers should use heuristic detection');
  assert.strictEqual(heuristicResult.customContent.detectionMethod, 'heuristic', 'Unknown containers should be marked as heuristic detection');
  assert(heuristicResult.customContent.fullText.includes('Useful campaign guide'), 'Heuristic extraction should retain the focused content block');
  assert.strictEqual(heuristicResult.links.find(link => link.url === 'https://example.com/inside-content')?.isInsideCustom, true, 'Links inside heuristic content should be identified as in-content');
  assert.strictEqual(heuristicResult.links.find(link => link.url === 'https://example.com/terms')?.isInsideCustom, false, 'Links outside heuristic content should not be identified as in-content');
  const resourceResult = Extractor.extractFromHtml(`
    <html><head><link rel="stylesheet" href="/assets/site.css"><script src="/assets/app.js"></script><link rel="preload" as="font" href="/assets/site.woff2"></head>
    <body><img src="/assets/logo.png"><video src="/media/intro.mp4"></video></body></html>
  `, 'https://example.com/assets', 'https://example.com', { cheerio });
  assert(resourceResult.resources.some(resource => resource.resourceType === 'Stylesheet' && resource.url.endsWith('/assets/site.css')), 'Stylesheets should be extracted as resources');
  assert(resourceResult.resources.some(resource => resource.resourceType === 'Script' && resource.url.endsWith('/assets/app.js')), 'Scripts should be extracted as resources');
  assert(resourceResult.resources.some(resource => resource.resourceType === 'Image' && resource.url.endsWith('/assets/logo.png')), 'Images should be extracted as resources');
  assert(resourceResult.resources.some(resource => resource.resourceType === 'Media' && resource.url.endsWith('/media/intro.mp4')), 'Media should be extracted as resources');
  console.log('✅ Content-area selector and heuristic tests passed');

  console.log('--- 8. Testing Root-Domain Seed URL Normalization ---');
  assert.strictEqual(
    Extractor.normalizeSeedUrl('graduateshub.org'),
    'https://graduateshub.org/',
    'A root domain should receive an HTTPS scheme automatically'
  );
  assert.strictEqual(
    Extractor.normalizeSeedUrl('http://graduateshub.org/about'),
    'http://graduateshub.org/about',
    'An explicit HTTP URL should be preserved'
  );
  assert.strictEqual(Extractor.normalizeSeedUrl('mailto:test@example.com'), null, 'Non-web URLs should be rejected');
  console.log('✅ Root-domain seed URL normalization tests passed');

  console.log('--- 11. Testing Internal Network Crawl Protection ---');
  const networkPolicy = new CrawlNetworkPolicy();
  assert.strictEqual(isBlockedIpAddress('127.0.0.1'), true, 'IPv4 loopback must be blocked');
  assert.strictEqual(isBlockedIpAddress('169.254.169.254'), true, 'Cloud metadata link-local IP must be blocked');
  assert.strictEqual(isBlockedIpAddress('10.0.0.8'), true, 'Private IPv4 addresses must be blocked');
  assert.strictEqual(isBlockedIpAddress('8.8.8.8'), false, 'Public IPv4 addresses must remain allowed');
  assert.strictEqual(isBlockedIpAddress('::1'), true, 'IPv6 loopback must be blocked');
  await assert.rejects(
    networkPolicy.assertSafePublicUrl('http://127.0.0.1:3000/'),
    /Private, loopback and internal network addresses cannot be crawled/,
    'A local target must never be accepted as a crawl seed'
  );
  await assert.rejects(
    networkPolicy.assertSafePublicUrl('http://localhost/'),
    /Private, loopback and internal network addresses cannot be crawled/,
    'localhost must never be accepted as a crawl seed'
  );
  const privateDnsPolicy = new CrawlNetworkPolicy({
    lookup: async () => [{ address: '10.20.30.40', family: 4 }]
  });
  await assert.rejects(
    privateDnsPolicy.assertSafePublicUrl('https://rebound.example/'),
    /Private, loopback and internal network addresses cannot be crawled/,
    'A hostname resolving to a private address must be blocked'
  );
  console.log('✅ Internal network protection tests passed');

  console.log('--- 12. Testing Crawl Request Limits ---');
  const validationOptions = {
    maxWorkersPerCrawl: 3,
    maxUnlimitedCrawlPages: 50000,
    allowedRegions: new Set(['auto', 'ZA', 'GH'])
  };
  const validated = validateCrawlRequest({
    crawlScope: 'domain', maxDepth: 3, maxPages: 50, concurrency: 2,
    customContentSelector: '.page-content', excludePatterns: ['/account'],
    includePatterns: ['/news'], region: 'za', respectRobotsTxt: true
  }, validationOptions);
  assert.strictEqual(validated.region, 'ZA', 'Supported regions should normalize to their canonical code');
  assert.strictEqual(validated.concurrency, 2, 'A valid worker value should be retained');
  await assert.rejects(
    async () => validateCrawlRequest({ crawlScope: 'domain', maxDepth: 99 }, validationOptions),
    CrawlRequestValidationError,
    'Depth above the server maximum must be rejected'
  );
  await assert.rejects(
    async () => validateCrawlRequest({ crawlScope: 'domain', excludePatterns: ['(a+)+'] }, validationOptions),
    CrawlRequestValidationError,
    'Obvious catastrophic regular expressions must be rejected'
  );
  await assert.rejects(
    async () => validateCrawlRequest({ crawlScope: 'domain', proxy: 'http://proxy.internal:8080' }, validationOptions),
    CrawlRequestValidationError,
    'Request-supplied proxies must be rejected'
  );
  console.log('✅ Crawl request limit tests passed');

  console.log('\n🎉 ALL AUTOMATED TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
