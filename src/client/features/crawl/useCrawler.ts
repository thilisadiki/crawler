import { useCallback, useEffect, useMemo, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlCapacity, CrawlConfig, CrawlPage, CrawlState, CrawlStats, EngineStatus } from '../../types/crawl';

const EMPTY_STATS: CrawlStats = { pagesCrawled: 0, pagesQueued: 0, internalLinksCount: 0, externalLinksCount: 0, errorsCount: 0, customDetectedCount: 0 };

function deriveState(status: { isRunning?: boolean; isPaused?: boolean; isStopping?: boolean; stats?: CrawlStats | null }): CrawlState {
  if (status.isRunning) return status.isStopping ? 'stopping' : status.isPaused ? 'paused' : 'running';
  return status.stats ? 'completed' : 'ready';
}

export function useCrawler() {
  const [state, setState] = useState<CrawlState>('ready');
  const [stats, setStats] = useState<CrawlStats>(EMPTY_STATS);
  const [queueLength, setQueueLength] = useState(0);
  const [pages, setPages] = useState<CrawlPage[]>([]);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [capacity, setCapacity] = useState<CrawlCapacity | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(async () => {
    const [status, resultPayload] = await Promise.all([crawlerClient.status(), crawlerClient.results()]);
    setState(deriveState(status));
    setStats(status.stats || EMPTY_STATS);
    setQueueLength(status.queueLength || 0);
    setEngine(status.engine || null);
    setCapacity(status.capacity);
    setPages(resultPayload.results || []);
  }, []);

  useEffect(() => {
    void sync().catch(() => {});
    const eventSource = new EventSource(crawlerClient.streamUrl());
    const receiveStatus = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      setState(deriveState(data)); setStats(data.stats || EMPTY_STATS); setQueueLength(data.queueLength || 0);
      setEngine(data.engine || null); setCapacity(data.capacity);
    };
    const receivePage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      setPages(current => current.some(page => page.url === data.result.url) ? current : [...current, data.result]);
      setStats(data.stats || EMPTY_STATS); setQueueLength(data.queueLength || 0);
    };
    const receiveReset = () => { setState('ready'); setStats(EMPTY_STATS); setQueueLength(0); setPages([]); setEngine(null); setError(null); };
    eventSource.addEventListener('status', receiveStatus);
    eventSource.addEventListener('pageCrawled', receivePage);
    eventSource.addEventListener('capacity', event => setCapacity(JSON.parse((event as MessageEvent).data)));
    eventSource.addEventListener('started', () => void sync());
    eventSource.addEventListener('completed', () => void sync());
    eventSource.addEventListener('stopped', () => void sync());
    eventSource.addEventListener('reset', receiveReset);
    // Hostinger proxies can temporarily buffer SSE. Polling keeps this UI live then.
    const poller = window.setInterval(() => void sync().catch(() => {}), 2000);
    return () => { eventSource.close(); window.clearInterval(poller); };
  }, [sync]);

  const run = useCallback(async (action: 'start' | 'pause' | 'resume' | 'stop' | 'reset', config?: CrawlConfig) => {
    setError(null);
    try {
      if (action === 'start' && config) {
        setPages([]); setStats(EMPTY_STATS); setQueueLength(0); setState('running');
        await crawlerClient.start(config);
      } else if (action === 'pause') await crawlerClient.pause();
      else if (action === 'resume') await crawlerClient.resume();
      else if (action === 'stop') await crawlerClient.stop();
      else if (action === 'reset') await crawlerClient.reset();
      await sync();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Crawler request failed.');
      await sync().catch(() => {});
    }
  }, [sync]);

  return useMemo(() => ({ state, stats, queueLength, pages, engine, capacity, error, run }), [state, stats, queueLength, pages, engine, capacity, error, run]);
}
