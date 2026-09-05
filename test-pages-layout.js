import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { BrowserManager } from './src/engine/browser.js';

// Uses the compiled dashboard and synthetic API responses: no real crawl or DB.
test('all Pages fields fit without horizontal scrolling', { timeout: 60000 }, async (t) => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', PUBLIC_APP_URL: origin,
      ADMIN_PASSWORD: 'layout-test-only', ADMIN_SESSION_SECRET: 'layout-test-only-secret',
      DB_HOST: '', DB_NAME: '', DB_USER: '', DB_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('CrawlLoom is running!')) {
    assert.equal(server.exitCode, null, output);
    assert.ok(Date.now() < deadline, output);
    await delay(25);
  }
  const manager = new BrowserManager();
  t.after(() => manager.close());
  const browser = await manager.init();
  const page = await browser.newPage();
  const longText = 'A complete page value with enough text to wrap across multiple lines. '.repeat(8);
  const results = ['a', 'b'].map((letter, index) => ({
    url: `https://example.com/${letter}/${'long-path-segment-'.repeat(18)}`,
    statusCode: 200, title: `${letter.toUpperCase()} ${longText}`,
    metaDescription: longText, metaKeywords: 'keyword,'.repeat(60),
    h1List: [longText], h2List: [longText, 'Another heading'],
    totalWords: 1200, responseTimeMs: 123456 + index, links: [],
    customContent: { detected: true, wordCount: 1200, fullText: longText, headings: [longText] }
  }));
  await page.route('**/api/crawler/snapshot?*', route => route.fulfill({ json: {
    revision: 0, isRunning: false, results, links: [],
    stats: { pagesCrawled: 2, endTime: 1 }, engine: { mode: 'browser' }
  } }));
  await page.route('**/api/crawler/stream?*', route => route.abort());
  const login = await page.request.post(`${origin}/api/admin/login`, {
    headers: { Origin: origin }, data: { password: 'layout-test-only' }
  });
  assert.equal(login.status(), 200);
  await page.goto(`${origin}/app`);
  await page.locator('.pages-table tbody tr').first().waitFor();

  for (const width of [1920, 1440, 1024, 860, 768, 390, 320]) {
    await t.test(`all seven data tabs fit at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      const tabs = page.locator('.page-data-tabs button');
      for (let index = 0; index < 7; index++) {
        await tabs.nth(index).click();
        const layout = await page.locator('.pages-table-wrap').evaluate(wrapper => {
          const box = wrapper.getBoundingClientRect();
          const cells = [...wrapper.querySelectorAll('tbody tr:first-child td')];
          return {
            overflow: wrapper.scrollWidth - wrapper.clientWidth,
            fields: cells.length,
            clipped: cells.some(cell => cell.scrollWidth > cell.clientWidth + 1),
            outside: cells.some(cell => {
              const bounds = cell.getBoundingClientRect();
              return bounds.left < box.left - 1 || bounds.right > box.right + 1;
            }),
            inspectVisible: wrapper.querySelector('tbody .inspect').getBoundingClientRect().right <= box.right + 1,
            value: wrapper.querySelector('.page-data-value').textContent
          };
        });
        assert.ok(layout.overflow <= 1, `tab ${index}: horizontal overflow`);
        assert.equal(layout.fields, index === 0 ? 8 : 6);
        assert.equal(layout.clipped, false, `tab ${index}: clipped cell text`);
        assert.equal(layout.outside, false, `tab ${index}: column outside panel`);
        assert.equal(layout.inspectVisible, true);
        assert.ok(layout.value.length > 100, 'Full text is retained');
      }
    });
  }

  await t.test('sorting, filtering and content inspection still work', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.page-data-tabs button').nth(0).click();
    await page.locator('.pages-table .sort-button').filter({ hasText: 'Title' }).click();
    await page.locator('.pages-table .sort-button').filter({ hasText: 'Title' }).click();
    assert.ok((await page.locator('.page-data-value').first().textContent()).startsWith('B'));
    await page.locator('.page-data-toolbar input').fill('/a/');
    assert.equal(await page.locator('.pages-table tbody tr').count(), 1);
    await page.locator('.page-data-toolbar input').fill('');
    await page.locator('.page-data-tabs button').nth(6).click();
    await page.locator('.pages-table .inspect').first().click();
    assert.match(await page.locator('.page-inspector-tabs button.active').textContent(), /Content area/i);
    await page.locator('.page-inspector-header .icon-button').click();
  });
  await page.locator('.page-data-tabs button').nth(0).click();
  if (process.env.LAYOUT_SCREENSHOTS === 'true') {
    await page.locator('.pages-table-wrap').screenshot({ path: '.tmp/pages-desktop.png' });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('.pages-table-wrap').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.tmp/pages-mobile.png' });
  }
});
