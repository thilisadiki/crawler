import type { CrawlCapacity, CrawlPage, CrawlState, CrawlStats, CrawledLink, CrawlerSnapshot, EngineStatus } from '../../types/crawl';

const emptyStats = (): CrawlStats => ({ pagesCrawled: 0, pagesQueued: 0, internalLinksCount: 0, externalLinksCount: 0, errorsCount: 0, customDetectedCount: 0 });
const POLL_INTERVAL_MS = 2000;
const STALE_STREAM_MS = 25000;

interface LiveState {
  state: CrawlState;
  stats: CrawlStats;
  queueLength: number;
  pages: CrawlPage[];
  links: CrawledLink[];
  engine: EngineStatus | null;
  capacity?: CrawlCapacity;
  error: string | null;
}

interface Stream {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

interface Transport {
  snapshot(signal?: AbortSignal): Promise<CrawlerSnapshot>;
  streamUrl(): Promise<string>;
}

type LiveEvent = {
  revision?: number;
  result?: CrawlPage;
  links?: CrawledLink[];
  stats?: CrawlStats | null;
  queueLength?: number;
  engine?: EngineStatus | null;
  capacity?: CrawlCapacity;
  isRunning?: boolean;
  isPaused?: boolean;
  isStopping?: boolean;
  message?: string;
} & EngineStatus;

function deriveState(data: LiveEvent): CrawlState {
  return data.isRunning ? (data.isStopping ? 'stopping' : data.isPaused ? 'paused' : 'running') : data.stats ? 'completed' : 'ready';
}

// Transport coordination lives outside React so races, reconnects and buffering
// can be tested without launching a crawler or relying on real network timing.
export class LiveCrawler {
  private value: LiveState = { state: 'ready', stats: emptyStats(), queueLength: 0, pages: [], links: [], engine: null, error: null };
  private listeners = new Set<() => void>();
  private transport: Transport;
  private createStream: (url: string) => Stream;
  private now: () => number;
  private stream: Stream | null = null;
  private connecting = false;
  private connected = false;
  private lastMessage = 0;
  private active = false;
  private revoked = false;
  private busy = false;
  private needsSnapshot = true;
  private generation = 0;
  private connectionVersion = 0;
  private revision = -1;
  private pending: { controller: AbortController; promise: Promise<void> } | null = null;
  private buffered: Array<{ type: string; data: LiveEvent }> = [];

  constructor(transport: Transport, createStream: (url: string) => Stream, now = Date.now) {
    this.transport = transport;
    this.createStream = createStream;
    this.now = now;
  }

  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<LiveState>) {
    this.value = { ...this.value, ...change };
    this.listeners.forEach(listener => listener());
  }

  start() { this.active = true; void this.connect(); }
  stop() { this.active = false; this.invalidate(); this.closeStream(); }

  private invalidate() {
    this.generation++;
    this.pending?.controller.abort();
    this.pending = null;
    this.buffered = [];
  }

  private closeStream() {
    this.connectionVersion++;
    this.stream?.close();
    this.stream = null;
    this.connecting = false;
    this.connected = false;
  }

  // Called every two seconds, but makes no requests while heartbeat messages
  // are arriving. Only unavailable or stalled streams activate fallback reads.
  tick = () => {
    if (!this.active || this.busy || this.revoked) return;
    if (this.connected && this.now() - this.lastMessage <= STALE_STREAM_MS) {
      if (this.needsSnapshot) void this.sync();
      return;
    }
    if (this.connected) this.closeStream();
    void this.sync();
    if (!this.stream && !this.connecting) void this.connect();
  };

  private async connect() {
    if (!this.active || this.busy || this.revoked || this.stream || this.connecting) return;
    const version = this.connectionVersion;
    this.connecting = true;
    try {
      const url = await this.transport.streamUrl();
      if (!this.active || this.busy || version !== this.connectionVersion) return;
      const stream = this.createStream(url);
      this.stream = stream;
      const current = () => this.active && !this.busy && version === this.connectionVersion;
      stream.addEventListener('open', () => {
        if (!current()) return;
        this.connected = true;
        this.lastMessage = this.now();
        // A reconnect has no event replay on the server; catch up from storage
        // in the current session and then apply events received during the read.
        this.invalidate();
        void this.sync();
      });
      for (const type of ['status', 'pageCrawled', 'capacity', 'heartbeat', 'started', 'engineSelected', 'paused', 'resumed', 'stopping', 'completed', 'stopped', 'restored', 'reset', 'revoked', 'error']) {
        stream.addEventListener(type, event => {
          if (!current()) return;
          if (type === 'error' && !event.data) { this.closeStream(); void this.sync(); return; }
          try {
            const data = JSON.parse(event.data) as LiveEvent;
            this.lastMessage = this.now();
            this.receive(type, data);
          } catch {
            this.update({ error: 'A live update could not be read. Reconnecting…' });
            this.closeStream();
          }
        });
      }
    } catch (error) {
      if (this.active && version === this.connectionVersion) this.update({ error: error instanceof Error ? error.message : 'Could not connect to live updates.' });
    } finally {
      if (version === this.connectionVersion) this.connecting = false;
    }
  }

  sync = (): Promise<void> => {
    if (!this.active || this.busy || this.revoked) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    const generation = this.generation;
    this.needsSnapshot = true;
    const controller = new AbortController();
    const promise = this.transport.snapshot(controller.signal).then(snapshot => {
      if (!this.active || generation !== this.generation) return;
      this.revision = snapshot.revision;
      this.needsSnapshot = false;
      this.update({ state: deriveState(snapshot), stats: snapshot.stats || emptyStats(), queueLength: snapshot.queueLength || 0,
        pages: snapshot.results, links: snapshot.links, engine: snapshot.engine || null, capacity: snapshot.capacity });
    }).catch(error => {
      if (this.active && generation === this.generation && !controller.signal.aborted) {
        this.update({ error: error instanceof Error ? error.message : 'Could not refresh crawl results.' });
      }
    }).finally(() => {
      if (generation !== this.generation) return;
      this.pending = null;
      const events = this.buffered;
      this.buffered = [];
      events.forEach(({ type, data }) => this.receive(type, data));
    });
    this.pending = { controller, promise };
    return promise;
  };

  private receive(type: string, data: LiveEvent) {
    if (type === 'revoked') {
      this.revoked = true;
      this.invalidate();
      this.closeStream();
      this.update({ state: 'ready', pages: [], links: [], stats: emptyStats(), queueLength: 0, engine: null, error: data.message || 'This dashboard session was revoked by an administrator.' });
      return;
    }
    if (type === 'heartbeat' || type === 'capacity') {
      this.update({ capacity: type === 'capacity' ? data as CrawlCapacity : data.capacity });
      return;
    }
    if (type === 'reset') {
      if (data.revision !== undefined && data.revision <= this.revision) return;
      this.invalidate();
      this.needsSnapshot = false;
      this.revision = data.revision ?? this.revision;
      this.update({ state: 'ready', pages: [], links: [], stats: emptyStats(), queueLength: 0, engine: null, error: null });
      return;
    }
    if (this.pending) { this.buffered.push({ type, data }); return; }
    // The snapshot may already contain an event that arrived while it loaded.
    if (data.revision !== undefined && data.revision <= this.revision) return;
    if (data.revision !== undefined) this.revision = data.revision;
    if (type === 'status') this.update({ state: deriveState(data), stats: data.stats || emptyStats(), queueLength: data.queueLength || 0, engine: data.engine || null, capacity: data.capacity });
    else if (type === 'pageCrawled' && data.result) {
      this.update({ pages: [...this.value.pages, data.result], links: [...this.value.links, ...(data.links || [])], stats: data.stats || this.value.stats, queueLength: data.queueLength || 0 });
    } else if (type === 'started') this.update({ state: 'running', pages: [], links: [], stats: emptyStats(), engine: null, error: null });
    else if (type === 'paused') this.update({ state: 'paused' });
    else if (type === 'resumed') this.update({ state: 'running' });
    else if (type === 'stopping') this.update({ state: 'stopping', queueLength: 0 });
    else if (type === 'engineSelected') this.update({ engine: data });
    else if (type === 'completed' || type === 'stopped') {
      this.update({ state: 'completed', stats: data.stats || this.value.stats, engine: data.engine || this.value.engine });
      void this.sync();
    } else if (type === 'restored') void this.sync();
    else if (type === 'error') { this.update({ error: data.message || 'The crawler encountered an error.' }); void this.sync(); }
  }

  // Suspend the old stream and invalidate all reads before changing the audit.
  // Closing and reopening also discards buffered messages from the old crawl.
  async command<T>(action: () => Promise<T>, starting = false): Promise<T> {
    if (this.busy) throw new Error('Please wait for the current crawl command to finish.');
    this.busy = true;
    this.invalidate();
    this.closeStream();
    this.update({ error: null, ...(starting ? { state: 'running' as const, pages: [], links: [], stats: emptyStats(), queueLength: 0, engine: null } : {}) });
    try { return await action(); }
    catch (error) {
      if (this.active) this.update({ error: error instanceof Error ? error.message : 'Crawler request failed.' });
      throw error;
    } finally {
      this.busy = false;
      if (this.active) { await this.sync(); void this.connect(); }
    }
  }
}

export { POLL_INTERVAL_MS };
