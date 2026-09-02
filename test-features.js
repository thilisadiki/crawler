import assert from 'assert';
import { RobotsParser } from './src/engine/robots.js';
import { SiteCrawler } from './src/engine/crawler.js';
import { Exporter } from './src/engine/exporter.js';

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
      error: null,
      timestamp: new Date().toISOString()
    }
  ];
  const pagesCsv = Exporter.generatePagesCSV(sampleResults);
  assert(pagesCsv.includes('https://example.com/test'), 'CSV should contain URL');
  assert(pagesCsv.includes('Content Area Detected'), 'CSV should contain the content detection header');
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

  console.log('\n🎉 ALL AUTOMATED TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
