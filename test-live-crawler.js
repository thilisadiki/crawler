import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCrawler } from './src/client/features/crawl/liveCrawler.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(revision = 0, results = [], links = [], isRunning = false) {
  return { revision, results, links, isRunning, stats: results.length ? { pagesCrawled: results.length } : null, queueLength: 0, engine: null };
}
function harness() {
  let time = 0;
  const reads = [], streams = [];
  const transport = {
    snapshot(signal) { const read = { ...deferred(), signal }; reads.push(read); return read.promise; },
    async streamUrl() { return '/stream'; }
  };
  const live = new LiveCrawler(transport, () => {
    const handlers = new Map();
    const stream = {
      closed: false,
      addEventListener(type, callback) { handlers.set(type, callback); },
      close() { this.closed = true; },
      emit(type, data) { handlers.get(type)?.({ data: data === undefined ? undefined : JSON.stringify(data) }); }
    };
    streams.push(stream);
    return stream;
  }, () => time);
  return { live, reads, streams, advance(ms) { time += ms; live.tick(); } };
}
async function connected(h, initial = snapshot()) {
  h.live.start();
  await flush();
  h.streams[0].emit('open');
  h.reads[0].resolve(initial);
  await flush();
}

test('healthy heartbeats avoid full downloads while page and control events update the dashboard', async () => {
  const h = harness();
  await connected(h);
  const stream = h.streams[0];
  for (let i = 0; i < 30; i++) {
    stream.emit('heartbeat', {});
    h.advance(10000);
  }
  assert.equal(h.reads.length, 1);
  stream.emit('started', { revision: 1 });
  stream.emit('engineSelected', { revision: 2, mode: 'browser', provider: 'test' });
  const page = { url: 'https://example.com/', title: 'Example' };
  const links = [{ sourceUrl: page.url, targetUrl: 'https://example.com/about', statusCode: 301 }];
  stream.emit('pageCrawled', { revision: 3, result: page, links, stats: { pagesCrawled: 1 }, queueLength: 2 });
  stream.emit('pageCrawled', { revision: 3, result: page, links });
  assert.deepEqual(h.live.getSnapshot().pages, [page]);
  assert.deepEqual(h.live.getSnapshot().links, links);
  assert.equal(h.live.getSnapshot().engine.mode, 'browser');
  stream.emit('paused', { revision: 4 });
  assert.equal(h.live.getSnapshot().state, 'paused');
  stream.emit('resumed', { revision: 5 });
  assert.equal(h.live.getSnapshot().state, 'running');
  stream.emit('stopping', { revision: 6 });
  assert.equal(h.live.getSnapshot().state, 'stopping');
  assert.equal(h.reads.length, 1);
  stream.emit('stopped', { revision: 7, stats: { pagesCrawled: 1, endTime: 123 } });
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve(snapshot(7, [page], links));
  await flush();
  assert.equal(h.live.getSnapshot().state, 'completed');
  h.live.stop();
});

test('a stalled open stream activates fallback without overlapping snapshots', async () => {
  const h = harness();
  await connected(h);
  h.advance(26000);
  await flush();
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.reads.length, 2);
  h.advance(2000);
  h.advance(2000);
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve(snapshot());
  await flush();
  h.advance(2000);
  assert.equal(h.reads.length, 3);
  h.live.stop();
});

test('reconnect fills missed pages and replays only events newer than its snapshot', async () => {
  const h = harness();
  await connected(h);
  h.streams[0].emit('error');
  h.advance(2000);
  await flush();
  assert.equal(h.reads.length, 2);
  const stream = h.streams[1];
  stream.emit('open');
  assert.equal(h.reads[1].signal.aborted, true);
  const pages = [1, 2, 3].map(n => ({ url: `https://example.com/${n}` }));
  stream.emit('pageCrawled', { revision: 2, result: pages[1], links: [], stats: { pagesCrawled: 2 } });
  stream.emit('pageCrawled', { revision: 3, result: pages[2], links: [], stats: { pagesCrawled: 3 } });
  h.reads[2].resolve(snapshot(2, pages.slice(0, 2), [], true));
  await flush();
  h.reads[1].resolve(snapshot(1, pages.slice(0, 1)));
  await flush();
  assert.deepEqual(h.live.getSnapshot().pages, pages);
  h.advance(2000);
  assert.equal(h.reads.length, 3);
  h.live.stop();
});

test('starting a new crawl invalidates old HTTP reads and buffered stream messages', async () => {
  const h = harness();
  await connected(h);
  h.streams[0].emit('error');
  await flush();
  const action = deferred();
  const command = h.live.command(() => action.promise, true);
  assert.equal(h.reads[1].signal.aborted, true);
  h.reads[1].resolve(snapshot(10, [{ url: 'https://old.example/' }]));
  h.streams[0].emit('pageCrawled', { revision: 11, result: { url: 'https://old.example/late' } });
  await flush();
  assert.deepEqual(h.live.getSnapshot().pages, []);
  assert.equal(h.live.getSnapshot().state, 'running');
  h.advance(30000);
  assert.equal(h.reads.length, 2);
  action.resolve();
  await flush();
  const fresh = { url: 'https://new.example/' };
  h.reads[2].resolve(snapshot(12, [fresh], [], true));
  await command;
  assert.deepEqual(h.live.getSnapshot().pages, [fresh]);
  h.live.stop();
});

test('reset event prevents a pending snapshot from restoring cleared results', async () => {
  const h = harness();
  await connected(h);
  const read = h.live.sync();
  h.streams[0].emit('reset', { revision: 2 });
  h.reads[1].resolve(snapshot(1, [{ url: 'https://old.example/' }]));
  await read;
  assert.equal(h.live.getSnapshot().state, 'ready');
  assert.deepEqual(h.live.getSnapshot().pages, []);
  h.live.stop();
});

test('failed snapshot is retried even when the stream is healthy', async () => {
  const h = harness();
  h.live.start();
  await flush();
  h.streams[0].emit('open');
  h.reads[0].reject(new Error('Temporary failure'));
  await flush();
  h.advance(2000);
  assert.equal(h.reads.length, 2);
  h.reads[1].resolve(snapshot());
  await flush();
  h.advance(2000);
  assert.equal(h.reads.length, 2);
  h.live.stop();
});

test('revocation closes the stream, clears data and stops fallback requests', async () => {
  const h = harness();
  await connected(h, snapshot(1, [{ url: 'https://example.com/' }]));
  h.streams[0].emit('revoked', { message: 'Revoked' });
  assert.equal(h.streams[0].closed, true);
  assert.deepEqual(h.live.getSnapshot().pages, []);
  h.advance(60000);
  assert.equal(h.reads.length, 1);
  assert.equal(h.live.getSnapshot().error, 'Revoked');
  h.live.stop();
});

test('unmount cancels an in-flight snapshot without publishing its results', async () => {
  const h = harness();
  await connected(h);
  const read = h.live.sync();
  const before = h.live.getSnapshot();
  h.live.stop();
  h.reads[1].resolve(snapshot(99, [{ url: 'https://late.example/' }]));
  await read;
  assert.equal(h.live.getSnapshot(), before);
  assert.equal(h.reads[1].signal.aborted, true);
});
