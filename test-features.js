import assert from 'assert';
import * as cheerio from 'cheerio';
import { RobotsParser } from './src/engine/robots.js';
import { SiteCrawler } from './src/engine/crawler.js';
import { Exporter } from './src/engine/exporter.js';
import { Extractor } from './src/engine/extractor.js';

async function runTests() {
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
    autoScroll: false
  });
  await singleCrawler.start();
  assert.strictEqual(singleCrawler.results.length, 1, 'Single URL scope must only crawl 1 page');
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

  console.log('--- 5. Testing Browser Disconnect Detection ---');
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

  console.log('--- 6. Testing Immediate Crawl Cancellation State ---');
  const cancellationCrawler = new SiteCrawler({ seedUrl: 'https://example.com' });
  cancellationCrawler.isRunning = true;
  cancellationCrawler.abortController = new AbortController();
  cancellationCrawler.queue = [{ url: 'https://example.com/queued', depth: 1 }];
  cancellationCrawler.stop();
  assert.strictEqual(cancellationCrawler.isCancelled, true, 'Stop should mark the crawl as cancelled');
  assert.strictEqual(cancellationCrawler.abortController.signal.aborted, true, 'Stop should abort active HTTP work');
  assert.strictEqual(cancellationCrawler.queue.length, 0, 'Stop should discard queued URLs');
  console.log('✅ Immediate cancellation state test passed');

  console.log('--- 7. Testing Content-Area Selector and Heuristic Detection ---');
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

  console.log('\n🎉 ALL AUTOMATED TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
