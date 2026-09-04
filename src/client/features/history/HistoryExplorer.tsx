import { useCallback, useEffect, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlHistoryDetail, CrawlHistoryRecord } from '../../types/crawl';

function date(value?: string | null) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function pages(record: CrawlHistoryRecord) { return record.stats?.pagesCrawled || 0; }

export function HistoryExplorer() {
  const [records, setRecords] = useState<CrawlHistoryRecord[]>([]);
  const [detail, setDetail] = useState<CrawlHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setMessage(null);
    try { const response = await crawlerClient.history(); setRecords(response.crawls || []); if (!response.storage?.connected) setMessage('Persistent history is not connected in this environment. Current crawls remain available in this tab.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load saved crawls.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function inspect(id: string) {
    setLoadingDetail(id); setMessage(null);
    try { setDetail(await crawlerClient.historyDetail(id)); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load this saved crawl.'); }
    finally { setLoadingDetail(null); }
  }
  return <div className="history-layout"><section><div className="history-head"><p>Saved crawls are stored in the existing MySQL database and remain available after a deployment or process restart.</p><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh history'}</button></div>{message && <p className="history-message">{message}</p>}<div className="table-wrap"><table><thead><tr><th>Target</th><th>Status</th><th>Pages</th><th>Started</th><th>Completed</th><th /></tr></thead><tbody>{records.length ? records.map(record => <tr key={record.id}><td className="url" title={record.seedUrl}>{record.seedUrl}</td><td><span className={`tag ${record.status === 'completed' ? 'positive' : 'neutral'}`}>{record.status}</span></td><td>{pages(record).toLocaleString()}</td><td>{date(record.startedAt || record.createdAt)}</td><td>{date(record.completedAt)}</td><td><button className="inspect" disabled={loadingDetail === record.id} onClick={() => void inspect(record.id)}>{loadingDetail === record.id ? 'Loading…' : 'View'}</button></td></tr>) : <tr><td colSpan={6} className="empty">{loading ? 'Loading saved crawls…' : 'No saved crawls are available yet.'}</td></tr>}</tbody></table></div></section>{detail && <section className="history-detail"><div className="section-heading"><div><p className="eyebrow">Saved crawl details</p><h3>{detail.crawl.seedUrl}</h3></div><button className="icon-button" onClick={() => setDetail(null)} aria-label="Close saved crawl details">×</button></div><div className="detail-grid"><div><span>Status</span><strong>{detail.crawl.status}</strong></div><div><span>Pages</span><strong>{(detail.crawl.stats?.pagesCrawled || detail.results.length).toLocaleString()}</strong></div><div><span>Engine</span><strong>{detail.crawl.engine?.mode || '—'}</strong></div><div><span>Completed</span><strong>{date(detail.crawl.completedAt)}</strong></div></div><div className="history-pages"><h4>Audited pages</h4>{detail.results.map(page => <div key={page.url}><span className={page.statusCode === 200 ? 'code success' : 'code failure'}>{page.statusCode ?? '—'}</span><a href={page.url} target="_blank" rel="noreferrer">{page.url}</a><small>{page.title || 'No title tag'}</small></div>)}</div></section>}</div>;
}
