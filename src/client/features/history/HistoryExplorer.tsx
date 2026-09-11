import { useCallback, useEffect, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlHistoryRecord } from '../../types/crawl';

function date(value?: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function pages(record: CrawlHistoryRecord) {
  return record.stats?.pagesCrawled || 0;
}

export function HistoryExplorer({ onRestore, onResume, onCompare }: {
  onRestore: (record: CrawlHistoryRecord) => Promise<void>;
  onResume?: (record: CrawlHistoryRecord) => Promise<void>;
  onCompare: (previous: CrawlHistoryRecord, current: CrawlHistoryRecord) => Promise<void>;
}) {
  const [records, setRecords] = useState<CrawlHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [previousId, setPreviousId] = useState('');
  const [currentId, setCurrentId] = useState('');
  const [comparing, setComparing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await crawlerClient.history();
      const crawls = response.crawls || [];
      setRecords(crawls);
      setPreviousId(selected => crawls.some(record => record.id === selected) ? selected : (crawls[1]?.id || ''));
      setCurrentId(selected => crawls.some(record => record.id === selected) ? selected : (crawls[0]?.id || ''));
      if (!response.storage?.connected) {
        setMessage('Persistent history is not connected in this environment. Current crawls remain available in this tab.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load saved crawls.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function restore(record: CrawlHistoryRecord) {
    if (restoring || comparing) return;
    setRestoring(record.id);
    setMessage(null);
    try {
      await onRestore(record);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not restore this saved crawl.');
      setRestoring(null);
    }
  }

  async function compare() {
    const previous = records.find(record => record.id === previousId);
    const current = records.find(record => record.id === currentId);
    if (!previous || !current || previous.id === current.id) {
      setMessage('Choose two different saved crawls to compare.');
      return;
    }
    setComparing(true);
    setMessage(null);
    try {
      await onCompare(previous, current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not compare these saved crawls.');
      setComparing(false);
    }
  }

  async function resume(record: CrawlHistoryRecord) {
    if (!onResume || restoring || resuming || comparing) return;
    setResuming(record.id);
    setMessage(null);
    try {
      await onResume(record);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not resume this saved crawl.');
    } finally {
      setResuming(null);
    }
  }

  return (
    <section className="history-explorer">
      <div className="history-head">
        <div><small>Compare two completed audits to find new, missing and changed URLs without replacing the current workspace.</small></div>
        <button className="secondary" onClick={() => void load()} disabled={loading || Boolean(restoring) || Boolean(resuming) || comparing}>
          {loading ? 'Refreshing…' : 'Refresh history'}
        </button>
      </div>
      {records.length >= 2 && (
        <section className="history-comparison-controls" aria-label="Compare saved crawls">
          <div><strong>Compare saved audits</strong><small>Select an earlier crawl as the baseline and a later crawl as the current version.</small></div>
          <label>Previous audit<select value={previousId} onChange={event => setPreviousId(event.target.value)} disabled={comparing}>{records.map(record => <option key={record.id} value={record.id}>{date(record.completedAt || record.startedAt || record.createdAt)} — {record.seedUrl} ({pages(record)} pages)</option>)}</select></label>
          <label>Current audit<select value={currentId} onChange={event => setCurrentId(event.target.value)} disabled={comparing}>{records.map(record => <option key={record.id} value={record.id}>{date(record.completedAt || record.startedAt || record.createdAt)} — {record.seedUrl} ({pages(record)} pages)</option>)}</select></label>
          <button className="primary" type="button" onClick={() => void compare()} disabled={comparing || !previousId || !currentId || previousId === currentId}>{comparing ? 'Comparing…' : 'Compare crawls'}</button>
        </section>
      )}
      {message && <p className="history-message">{message}</p>}
      <div className="table-wrap">
        <table className="history-table">
          <thead><tr><th>Target</th><th>Status</th><th>Pages</th><th>Started</th><th>Completed</th><th>Action</th></tr></thead>
          <tbody>
            {records.length ? records.map(record => (
              <tr key={record.id}>
                <td className="url" title={record.seedUrl}>{record.seedUrl}</td>
                <td><span className={`tag ${record.status === 'completed' ? 'positive' : 'neutral'}`}>{record.status}</span></td>
                <td>{pages(record).toLocaleString()}</td>
                <td>{date(record.startedAt || record.createdAt)}</td>
                <td>{date(record.completedAt)}</td>
                <td>
                  <button className="inspect" disabled={Boolean(restoring) || Boolean(resuming) || comparing} onClick={() => void restore(record)}>{restoring === record.id ? 'Loading…' : 'Open audit'}</button>
                  {record.status !== 'completed' && onResume && <button className="inspect" disabled={Boolean(restoring) || Boolean(resuming) || comparing} onClick={() => void resume(record)}>{resuming === record.id ? 'Resuming…' : 'Resume'}</button>}
                </td>
              </tr>
            )) : <tr><td colSpan={6} className="empty">{loading ? 'Loading saved crawls…' : 'No saved crawls are available yet.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
