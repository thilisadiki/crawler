import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlConfig } from '../../types/crawl';
import { LiveCrawler, POLL_INTERVAL_MS } from './liveCrawler';

export function useCrawler() {
  const [live] = useState(() => new LiveCrawler(crawlerClient, url => new EventSource(url)));
  const state = useSyncExternalStore(live.subscribe, live.getSnapshot);

  useEffect(() => {
    live.start();
    const timer = window.setInterval(live.tick, POLL_INTERVAL_MS);
    return () => { window.clearInterval(timer); live.stop(); };
  }, [live]);

  const run = useCallback(async (action: 'start' | 'pause' | 'resume' | 'stop' | 'reset', config?: CrawlConfig) => {
    try {
      await live.command(async () => {
        if (action === 'start') {
          if (config) await crawlerClient.start(config);
        } else await crawlerClient[action]();
      }, action === 'start');
    } catch { /* The controller exposes command errors in dashboard state. */ }
  }, [live]);

  const restoreHistory = useCallback((crawlId: string) => live.command(() => crawlerClient.restoreHistory(crawlId)), [live]);
  return { ...state, run, restoreHistory };
}
