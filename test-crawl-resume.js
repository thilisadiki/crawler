import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SiteCrawler } from './src/engine/crawler.js';
import { CrawlStorage } from './src/storage/database.js';
import { CrawlCoordinator } from './src/services/crawl-coordinator.js';

test('SiteCrawler preserves pending queue in getResumeState when stopped', () => {
  const crawler = new SiteCrawler({ seedUrl: 'https://example.com' });
  crawler.isRunning = true;
  crawler.abortController = new AbortController();
  crawler.queue = [
    { url: 'https://example.com/page1', depth: 1, sourceUrl: 'SEED' },
    { url: 'https://example.com/page2', depth: 2, sourceUrl: 'https://example.com/page1' }
  ];
  crawler.stop();
  assert.equal(crawler.isCancelled, true);
  assert.equal(crawler.queue.length, 0, 'Active queue should be cleared to halt workers');

  const resumeState = crawler.getResumeState();
  assert.equal(resumeState.queue.length, 2, 'Resume state must retain the stopped queue');
  assert.equal(resumeState.queue[0].url, 'https://example.com/page1');
  assert.equal(resumeState.queue[1].url, 'https://example.com/page2');
});

test('SiteCrawler checkpoints an interrupted in-flight URL as pending rather than visited', () => {
  const crawler = new SiteCrawler({ seedUrl: 'https://example.com' });
  const active = { url: 'https://example.com/slow-page', depth: 2, sourceUrl: 'https://example.com/parent' };
  crawler.queue = [{ url: 'https://example.com/waiting', depth: 1, sourceUrl: 'https://example.com/' }];
  crawler.visited = new Set([active.url, 'https://example.com/completed']);
  crawler.inFlightItems.set(active.url, active);

  const resumeState = crawler.getResumeState();
  assert.deepEqual(resumeState.queue.map(item => item.url), ['https://example.com/waiting', active.url]);
  assert.equal(resumeState.visited.includes(active.url), false, 'Interrupted work must not be skipped after resume');
  assert.equal(resumeState.visited.includes('https://example.com/completed'), true);
});

test('SiteCrawler retains active work after an abort has finished cleaning up', () => {
  const crawler = new SiteCrawler({ seedUrl: 'https://example.com' });
  const active = { url: 'https://example.com/interrupted', depth: 1, sourceUrl: 'https://example.com/' };
  crawler.isRunning = true;
  crawler.abortController = new AbortController();
  crawler.visited = new Set([active.url]);
  crawler.inFlightItems.set(active.url, active);
  crawler.stop();
  crawler.inFlightItems.clear();

  const resumeState = crawler.getResumeState();
  assert.equal(resumeState.queue.some(item => item.url === active.url), true);
  assert.equal(resumeState.visited.includes(active.url), false);
});

test('SiteCrawler initializes with resumed queue and visited set without re-adding seed URL', () => {
  const crawler = new SiteCrawler({
    seedUrl: 'https://example.com',
    isResumed: true,
    resumedVisited: ['https://example.com/'],
    resumedQueue: [
      { url: 'https://example.com/about', depth: 1, sourceUrl: 'https://example.com/' }
    ],
    resumedResults: [
      { id: 1, url: 'https://example.com/', title: 'Home' }
    ],
    resumedStats: { pagesCrawled: 1, internalLinksCount: 5 }
  });

  assert.equal(crawler.isResumed, true);
  assert.equal(crawler.results.length, 1);
  assert.equal(crawler.visited.has('https://example.com/'), true);
  assert.equal(crawler.queue.length, 1);
  assert.equal(crawler.queue[0].url, 'https://example.com/about');
  assert.equal(crawler.stats.pagesCrawled, 1);
});

test('SiteCrawler records paused time separately from active crawl time', () => {
  const crawler = new SiteCrawler({ seedUrl: 'https://example.com' });
  crawler.isRunning = true;

  crawler.pause(1_000);
  assert.equal(crawler.isPaused, true);
  assert.equal(crawler.stats.pausedAt, 1_000);

  crawler.resume(6_500);
  assert.equal(crawler.isPaused, false);
  assert.equal(crawler.stats.pausedAt, null);
  assert.equal(crawler.stats.pausedDurationMs, 5_500);

  crawler.pause(8_000);
  crawler.stop();
  assert.equal(crawler.stats.pausedAt, null, 'Stopping a paused crawl must finalise its paused duration');
  assert.ok(crawler.stats.pausedDurationMs >= 5_500);
});

test('CrawlCoordinator owns an active crawl lifecycle and releases its slot when complete', async () => {
  const saved = [];
  const events = [];
  const coordinator = new CrawlCoordinator({
    storage: {
      async updateCrawl(...args) { saved.push(['crawl', ...args]); },
      async updateCrawlQueue(...args) { saved.push(['queue', ...args]); },
      async savePage(...args) { saved.push(['page', ...args]); }
    },
    capacity: {
      maxConcurrentCrawls: 3,
      maxWorkersPerCrawl: 1,
      maxUnlimitedCrawlPages: 50_000,
      linkCheckConcurrency: 6,
      linkCheckDeadlineMs: 30_000
    },
    onEvent: (...args) => events.push(args)
  });
  class TestCrawler extends EventEmitter {
    constructor() {
      super();
      this.isRunning = false;
      this.isPaused = false;
      this.isSuspended = false;
      this.stats = { pagesCrawled: 0 };
      this.allLinks = [];
      this.historyAudit = null;
    }
    getEngineStatus() { return { mode: 'direct' }; }
    getResumeState() { return { queue: [] }; }
    start() {
      this.isRunning = true;
      this.emit('started', { stats: this.stats });
      return new Promise(resolve => {
        this.complete = () => {
          this.isRunning = false;
          this.emit('completed', { stats: this.stats, engine: this.getEngineStatus() });
          resolve();
        };
      });
    }
  }

  const crawler = new TestCrawler();
  const crawlPromise = coordinator.start('dashboard-1', 'crawl-1', crawler);
  assert.equal(coordinator.get('dashboard-1')?.crawler, crawler);
  assert.equal(coordinator.getCapacity().activeCrawls, 1);
  crawler.complete();
  await crawlPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.getCapacity().activeCrawls, 0);
  assert.equal(events.some(([, type]) => type === 'started'), true);
  assert.equal(events.some(([, type]) => type === 'completed'), true);
  assert.equal(saved.some(([type]) => type === 'crawl'), true);
});

test('CrawlStorage listCrawls supports isAdmin filter for legacy crawls', async () => {
  const storage = new CrawlStorage();
  let executedSql = '';
  storage.pool = {
    async execute(sql, values) {
      executedSql = sql;
      return [[]];
    }
  };
  storage.isConfigured = true;
  storage.initPromise = Promise.resolve(true);

  // Admin query should match owner_user_id or NULL
  await storage.listCrawls(25, 'administrator', true);
  assert.match(executedSql, /WHERE \(owner_user_id = \? OR owner_user_id IS NULL\)/);

  // Auditor query should only match their specific owner_user_id
  await storage.listCrawls(25, 'auditor-123', false);
  assert.match(executedSql, /WHERE owner_user_id = \?/);
  assert.doesNotMatch(executedSql, /IS NULL/);
});
