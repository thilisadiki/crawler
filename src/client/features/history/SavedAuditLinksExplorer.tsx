import { useEffect, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlHistoryLinkWindow, CrawledLink } from '../../types/crawl';
import '../links/links.css';
import { getSavedAuditWindow, loadSavedAuditWindow } from './saved-audit-cache';

type LinkFilter = 'all' | 'internal' | 'external' | 'redirects' | 'in-content' | '200' | 'errors' | 'nofollow';
type SortKey = 'index' | 'status' | 'anchor' | 'destination' | 'type' | 'content' | 'nofollow' | 'source';
const FILTERS: Array<[LinkFilter, string]> = [['all', 'All links'], ['internal', 'Internal'], ['external', 'External'], ['redirects', 'Redirects'], ['in-content', 'In content area'], ['200', '200 OK'], ['errors', 'Errors & broken'], ['nofollow', 'Nofollow']];
const INITIAL_WINDOW_OPTIONS = { offset: 0, limit: 50, filter: 'all', sort: 'index', direction: 'asc', query: '' };
function destination(link: CrawledLink) { return link.targetUrl || link.url || ''; }
function redirects(link: CrawledLink) { return link.redirectCount || link.redirectChain?.length || 0; }

export function SavedAuditLinksExplorer({ crawlId, sharedSearch }: { crawlId: string; sharedSearch: string }) {
  const [filter, setFilter] = useState<LinkFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [linkWindow, setLinkWindow] = useState<CrawlHistoryLinkWindow | null>(() => getSavedAuditWindow('links', crawlId, INITIAL_WINDOW_OPTIONS) || null);
  const [loading, setLoading] = useState(() => !getSavedAuditWindow('links', crawlId, INITIAL_WINDOW_OPTIONS));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const options = { offset: (page - 1) * pageSize, limit: pageSize, filter, sort: sort.key, direction: sort.direction, query: sharedSearch.trim() };
    const cached = getSavedAuditWindow<CrawlHistoryLinkWindow>('links', crawlId, options);
    if (cached) {
      setLinkWindow(cached); setLoading(false); setError(null);
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      void loadSavedAuditWindow('links', crawlId, options, () => crawlerClient.historyLinks(crawlId, options))
        .then(result => { if (!controller.signal.aborted) setLinkWindow(result); })
        .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load saved audit links.'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, sharedSearch ? 200 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [crawlId, page, pageSize, filter, sort, sharedSearch]);
  const counts = linkWindow?.counts || { all: 0, internal: 0, external: 0, redirects: 0, 'in-content': 0, '200': 0, errors: 0, nofollow: 0 };
  const total = linkWindow?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  function selectFilter(value: LinkFilter) { setFilter(value); setPage(1); }
  function changeSort(key: SortKey) { setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })); setPage(1); }
  function header(label: string, key: SortKey) { return <th scope="col"><button className="sort-button" onClick={() => changeSort(key)}>{label} <span>{sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>; }
  return <>
    <div className="sub-tabs" aria-label="Saved audit link filters">{FILTERS.map(([value, label]) => <button key={value} className={filter === value ? 'pill active' : 'pill'} onClick={() => selectFilter(value)}>{label} ({counts[value]})</button>)}</div>
    {error && <p className="error-message">{error}</p>}
    <div className="table-wrap links-table-wrap"><table className="links-table"><thead><tr>{header('#', 'index')}{header('Status', 'status')}{header('Anchor text', 'anchor')}{header('Destination URL', 'destination')}{header('Type', 'type')}{header('Content area', 'content')}{header('Nofollow', 'nofollow')}{header('Source page', 'source')}</tr></thead><tbody>{loading ? <tr><td colSpan={8} className="empty">Loading saved audit links…</td></tr> : linkWindow?.links.length ? linkWindow.links.map((link, index) => { const href = destination(link); const status = link.statusCode ?? 0; const hops = redirects(link); return <tr key={`${link.sourceUrl}|${href}|${index}`}><td>{(currentPage - 1) * pageSize + index + 1}</td><td><span className={status === 200 ? 'code success' : status >= 400 || status === 0 ? 'code failure' : 'code neutral'}>{link.statusCode ?? '—'}</span></td><td>{link.anchorText || '[No text]'}</td><td className="url"><div>{/^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{href}</a> : href || '—'}{hops > 0 && <small className="redirect-destination">↳ {link.finalUrl || 'Redirect destination unavailable'} ({hops} hop{hops === 1 ? '' : 's'})</small>}</div></td><td><span className={link.isInternal ? 'tag positive' : 'tag neutral'}>{link.linkType || 'Unknown'}</span></td><td>{link.isInsideCustom ? <span className="tag positive">Yes</span> : 'No'}</td><td>{link.isNofollow ? 'nofollow' : 'dofollow'}</td><td className="url">{link.sourceUrl || '—'}</td></tr>; }) : <tr><td colSpan={8} className="empty">No saved links match the selected filter.</td></tr>}</tbody></table></div>
    {total > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, total)} of {total.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1 || loading} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages || loading} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </>;
}
