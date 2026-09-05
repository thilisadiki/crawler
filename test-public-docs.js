import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { load } from 'cheerio';

test('public documentation is readable without exposing private application routes', { timeout: 20000 }, async (t) => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', PUBLIC_APP_URL: origin,
      ADMIN_PASSWORD: 'docs-test-only', ADMIN_SESSION_SECRET: 'docs-test-only-signing-secret',
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
  const get = (path) => fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  const deadline = Date.now() + 10000;
  while (!output.includes('CrawlLoom is running!')) {
    assert.equal(server.exitCode, null, output);
    assert.ok(Date.now() < deadline, `Server did not start: ${output}`);
    await delay(25);
  }

  await t.test('guide and trailing-slash route are public, indexable HTML', async () => {
    for (const path of ['/docs', '/docs/']) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.doesNotMatch(response.headers.get('x-robots-tag') || '', /noindex/);
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
      const $ = load(await response.text());
      assert.equal($('h1').text(), 'CrawlLoom documentation');
      assert.ok($('meta[name="description"]').attr('content'));
      assert.equal($('script').length, 0, 'Documentation must work without scripts');
      assert.equal($('[style]').length, 0, 'Avoid inline styles under strict CSP');
      const ids = $('[id]').map((_, element) => $(element).attr('id')).get();
      assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
      for (const link of $('a[href^="#"]').toArray()) {
        assert.ok(ids.includes($(link).attr('href').slice(1)), 'Contents link must resolve');
      }
      for (const link of $('link[rel="stylesheet"]').toArray()) {
        const css = await get($(link).attr('href'));
        assert.equal(css.status, 200);
        assert.match(css.headers.get('content-type'), /text\/css/);
      }
    }
  });

  await t.test('public pages and sitemap link to the guide', async () => {
    for (const path of ['/', '/about', '/privacy', '/terms', '/acceptable-use']) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.ok(load(await response.text())('a[href="/docs"]').length, path);
    }
    const sitemap = await get('/sitemap.xml');
    assert.ok((await sitemap.text()).includes(`${origin}/docs/`));
  });

  await t.test('dashboard and administration still require sign-in and stay noindex', async () => {
    for (const path of ['/app', '/admin', '/next/', '/legacy']) {
      const response = await get(path);
      assert.equal(response.status, 302, path);
      assert.match(response.headers.get('location'), /^\/admin\/login/);
      assert.match(response.headers.get('x-robots-tag'), /noindex/);
    }
  });

  await t.test('crawler data, exports and admin data remain unauthorized', async () => {
    for (const path of ['/api/crawler/history', '/api/crawler/results', '/api/export/pages.csv', '/api/admin/database-overview']) {
      const response = await get(path);
      assert.equal(response.status, 401, path);
      assert.match(response.headers.get('x-robots-tag'), /noindex/);
    }
  });
});
