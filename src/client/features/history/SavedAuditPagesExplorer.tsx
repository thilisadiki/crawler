import { useEffect, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlHistoryPageWindow, CrawlPage } from '../../types/crawl';
import '../pages/pages.css';
import { getSavedAuditWindow, loadSavedAuditWindow } from './saved-audit-cache';

type PageTab = 'all' | 'title' | 'description' | 'keywords' | 'h1' | 'h2' | 'content';
type PageFilter = 'all' | '200' | 'content' | 'missing' | 'errors';
type SortKey = 'index' | 'status' | 'url' | 'value' | 'length' | 'content' | 'links' | 'latency';

const TABS: Array<[PageTab, string]> = [['all', 'All pages'], ['title', 'Page title'], ['description', 'Meta description'], ['keywords', 'Meta keywords'], ['h1', 'H1'], ['h2', 'H2'], ['content', 'Content']];
const INITIAL_WINDOW_OPTIONS = { offset: 0, limit: 50, tab: 'all', filter: 'all', sort: 'index', direction: 'asc', query: '' };

function valueFor(page: CrawlPage, tab: PageTab) {
  if (tab === 'all' || tab === 'title') return page.title || '';
  if (tab === 'description') return page.metaDescription || '';
  if (tab === 'keywords') return page.metaKeywords || '';
  if (tab === 'h1') return page.h1List?.filter(Boolean).join(' • ') || page.h1 || '';
  if (tab === 'h2') return page.h2List?.filter(Boolean).join(' • ') || '';
  return page.hasStoredContent ? 'Stored content — inspect to view' : '';
}
function valueLabel(tab: PageTab) { return TABS.find(([value]) => value === tab)?.[1] || 'Value'; }
function countFor(page: CrawlPage, tab: PageTab, value: string) {
  if (tab === 'h1') return page.h1List?.filter(Boolean).length || (page.h1 ? 1 : 0);
  if (tab === 'h2') return page.h2List?.filter(Boolean).length || 0;
  if (tab === 'content') return page.customContent?.wordCount || page.totalWords || 0;
  return value.length;
}

export function SavedAuditPagesExplorer({ crawlId, sharedSearch, onInspectPage }: { crawlId: string; sharedSearch: string; onInspectPage: (page: CrawlPage, section: 'overview' | 'content') => Promise<void> }) {
  const [tab, setTab] = useState<PageTab>('all');
  const [filter, setFilter] = useState<PageFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [pageWindow, setPageWindow] = useState<CrawlHistoryPageWindow | null>(() => getSavedAuditWindow('pages', crawlId, INITIAL_WINDOW_OPTIONS) || null);
  const [loading, setLoading] = useState(() => !getSavedAuditWindow('pages', crawlId, INITIAL_WINDOW_OPTIONS));
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const options = {
      offset: (page - 1) * pageSize, limit: pageSize, tab, filter, sort: sort.key, direction: sort.direction, query: sharedSearch.trim()
    };
    const cached = getSavedAuditWindow<CrawlHistoryPageWindow>('pages', crawlId, options);
    if (cached) {
      setPageWindow(cached); setLoading(false); setError(null);
      return () => controller.abort();
    }
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      void loadSavedAuditWindow('pages', crawlId, options, () => crawlerClient.historyPages(crawlId, options)).then(result => {
        if (!controller.signal.aborted) setPageWindow(result);
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load saved audit pages.');
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, sharedSearch ? 200 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [crawlId, page, pageSize, tab, filter, sort, sharedSearch]);

  const counts = pageWindow?.counts || { all: 0, title: 0, description: 0, keywords: 0, h1: 0, h2: 0, content: 0 };
  const total = pageWindow?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = pageWindow?.results || [];
  const filters: Array<[PageFilter, string]> = tab === 'all'
    ? [['all', 'All pages'], ['200', '200 OK'], ['content', 'Content found'], ['missing', 'Content missing'], ['errors', 'Errors']]
    : [['all', 'All with data'], ['200', '200 OK'], ['errors', 'Errors']];
  function selectTab(value: PageTab) { setTab(value); setFilter('all'); setPage(1); }
  function selectFilter(value: PageFilter) { setFilter(value); setPage(1); }
  function changeSort(key: SortKey) { setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })); setPage(1); }
  async function inspect(item: CrawlPage) {
    setInspecting(item.url);
    try { await onInspectPage(item, tab === 'content' ? 'content' : 'overview'); }
    finally { setInspecting(null); }
  }
  function header(label: string, key: SortKey) { return <th scope="col"><button className="sort-button" onClick={() => changeSort(key)}>{label} <span>{sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>; }

  return <>
    <div className="page-categories-row"><nav className="sub-tabs page-data-categories" aria-label="Saved audit page data categories">{TABS.map(([value, label]) => <button key={value} className={tab === value ? 'pill active' : 'pill'} onClick={() => selectTab(value)}>{label} ({counts[value]})</button>)}</nav><div className="page-filter-row"><label>Filter results<select value={filter} onChange={event => selectFilter(event.target.value as PageFilter)}>{filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></div>
    {error && <p className="error-message">{error}</p>}
    <div className="table-wrap pages-table-wrap"><table className={tab === 'all' ? 'pages-table pages-table-all' : 'pages-table pages-table-data'}><thead><tr>{header('#', 'index')}{header('Status', 'status')}{header('URL', 'url')}{header(tab === 'all' ? 'Title' : valueLabel(tab), 'value')}{tab === 'all' ? <>{header('Content area', 'content')}{header('Links', 'links')}{header('Latency', 'latency')}</> : header(tab === 'content' ? 'Words' : tab === 'h1' || tab === 'h2' ? 'Count' : 'Characters', 'length')}<th>Action</th></tr></thead><tbody>{loading ? <tr><td colSpan={tab === 'all' ? 8 : 6} className="empty">Loading saved audit pages…</td></tr> : rows.length ? rows.map((item, index) => { const value = valueFor(item, tab); return <tr key={item.url}><td data-label="#">{(currentPage - 1) * pageSize + index + 1}</td><td data-label="Status"><span className={item.statusCode === 200 ? 'code success' : 'code failure'}>{item.statusCode ?? '—'}</span></td><td data-label="URL" className="url"><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a></td><td data-label={tab === 'all' ? 'Title' : valueLabel(tab)} className="page-data-value">{value || '—'}</td>{tab === 'all' ? <><td data-label="Content area"><span className={item.customContent?.detected ? 'tag positive' : 'tag neutral'}>{item.customContent?.detected ? `Found (${item.customContent.wordCount || 0}w)` : 'None'}</span></td><td data-label="Links">{((item.internalLinksCount || 0) + (item.externalLinksCount || 0)).toLocaleString()}</td><td data-label="Latency">{item.responseTimeMs ? `${item.responseTimeMs}ms` : '—'}</td></> : <td data-label="Count">{countFor(item, tab, value).toLocaleString()}</td>}<td data-label="Action"><button className="inspect" disabled={Boolean(inspecting)} onClick={() => void inspect(item)}>{inspecting === item.url ? 'Loading…' : 'Inspect'}</button></td></tr>; }) : <tr><td colSpan={tab === 'all' ? 8 : 6} className="empty">No saved pages match the selected filters.</td></tr>}</tbody></table></div>
    {total > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, total)} of {total.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1 || loading} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages || loading} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </>;
}
