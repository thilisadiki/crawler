import { useCallback, useEffect, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlHistoryRecord } from '../../types/crawl';

function date(value?: string | null) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function pages(record: CrawlHistoryRecord) { return record.stats?.pagesCrawled || 0; }

export function HistoryExplorer({ onRestore }: { onRestore: (crawlId: string) => Promise<void> }) {
  const [records, setRecords] = useState<CrawlHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setMessage(null);
    try {
      const response = await crawlerClient.history();
      setRecords(response.crawls || []);
      if (!response.storage?.connected) setMessage('Persistent history is not connected in this environment. Current crawls remain available in this tab.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load saved crawls.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function restore(record: CrawlHistoryRecord) {
    setRestoring(record.id); setMessage(null);
    try {
      await onRestore(record.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not restore this saved crawl.');
      setRestoring(null);
    }
  }

  return <section className="history-explorer"><div className="history-head"><div><p>Saved crawls remain available after a deployment or process restart. Open one to restore its full saved audit into this dashboard.</p><small>Pages, links, resources, extracted content, SEO issues, inspection details, and exports will be available again.</small></div><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh history'}</button></div>{message && <p className="history-message">{message}</p>}<div className="table-wrap"><table className="history-table"><thead><tr><th>Target</th><th>Status</th><th>Pages</th><th>Started</th><th>Completed</th><th>Action</th></tr></thead><tbody>{records.length ? records.map(record => <tr key={record.id}><td className="url" title={record.seedUrl}>{record.seedUrl}</td><td><span className={`tag ${record.status === 'completed' ? 'positive' : 'neutral'}`}>{record.status}</span></td><td>{pages(record).toLocaleString()}</td><td>{date(record.startedAt || record.createdAt)}</td><td>{date(record.completedAt)}</td><td><button className="inspect" disabled={restoring === record.id} onClick={() => void restore(record)}>{restoring === record.id ? 'Opening…' : 'Open audit'}</button></td></tr>) : <tr><td colSpan={6} className="empty">{loading ? 'Loading saved crawls…' : 'No saved crawls are available yet.'}</td></tr>}</tbody></table></div></section>;
}
