import { useMemo, useState } from 'react';
import type { CrawlPage } from '../../types/crawl';
import './pages.css';

type PageTab = 'all' | 'title' | 'description' | 'keywords' | 'h1' | 'h2' | 'content';
type PageFilter = 'all' | '200' | 'content' | 'missing' | 'errors';
type SortKey = 'index' | 'status' | 'url' | 'value' | 'length' | 'content' | 'links' | 'latency';

const TABS: Array<{ value: PageTab; label: string }> = [
  { value: 'all', label: 'All pages' },
  { value: 'title', label: 'Page title' },
  { value: 'description', label: 'Meta description' },
  { value: 'keywords', label: 'Meta keywords' },
  { value: 'h1', label: 'H1' },
  { value: 'h2', label: 'H2' },
  { value: 'content', label: 'Content' }
];

function contentText(page: CrawlPage) { return page.customContent?.fullText || page.customContent?.textSnippet || page.fullPageText || ''; }
function contentFound(page: CrawlPage) { return Boolean(page.customContent?.detected); }
function valueFor(page: CrawlPage, tab: PageTab) {
  if (tab === 'all' || tab === 'title') return page.title || '';
  if (tab === 'description') return page.metaDescription || '';
  if (tab === 'keywords') return page.metaKeywords || '';
  if (tab === 'h1') return page.h1List?.filter(Boolean).join(' • ') || page.h1 || '';
  if (tab === 'h2') return page.h2List?.filter(Boolean).join(' • ') || '';
  return contentText(page);
}
function countFor(page: CrawlPage, tab: PageTab, value: string) {
  if (tab === 'h1') return page.h1List?.filter(Boolean).length || (page.h1 ? 1 : 0);
  if (tab === 'h2') return page.h2List?.filter(Boolean).length || 0;
  if (tab === 'content') return page.customContent?.wordCount || page.totalWords || page.wordCount || 0;
  return value.length;
}
function countLabel(tab: PageTab) {
  if (tab === 'h1' || tab === 'h2') return 'Count';
  return tab === 'content' ? 'Words' : 'Characters';
}
function tabValueLabel(tab: PageTab) { return TABS.find(item => item.value === tab)?.label || 'Value'; }

export function PagesExplorer({ pages, onInspectPage }: { pages: CrawlPage[]; onInspectPage: (page: CrawlPage, section: 'overview' | 'content') => void }) {
  const [tab, setTab] = useState<PageTab>('all');
  const [filter, setFilter] = useState<PageFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const tabCounts = useMemo(() => Object.fromEntries(TABS.map(({ value }) => [value, value === 'all' ? pages.length : pages.filter(item => Boolean(valueFor(item, value))).length])) as Record<PageTab, number>, [pages]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = pages.map((item, index) => ({ page: item, index, value: valueFor(item, tab) })).filter(item => {
      const searchable = tab === 'all'
        ? `${item.page.url} ${item.page.title || ''} ${item.page.metaDescription || ''} ${item.page.statusCode || ''}`
        : `${item.page.url} ${item.page.statusCode || ''} ${item.value}`;
      if (query && !searchable.toLowerCase().includes(query)) return false;
      if (tab !== 'all' && !item.value) return false;
      if (filter === '200') return item.page.statusCode === 200;
      if (filter === 'content') return contentFound(item.page);
      if (filter === 'missing') return !contentFound(item.page);
      if (filter === 'errors') return Boolean(item.page.error) || (item.page.statusCode || 0) >= 400;
      return true;
    });
    return matches.sort((left, right) => {
      const sortValue = (item: typeof left): string | number => {
        if (sort.key === 'index') return item.index;
        if (sort.key === 'status') return item.page.statusCode || 0;
        if (sort.key === 'url') return item.page.url;
        if (sort.key === 'length') return countFor(item.page, tab, item.value);
        if (sort.key === 'content') return contentFound(item.page) ? 1 : 0;
        if (sort.key === 'links') return item.page.links?.length || 0;
        if (sort.key === 'latency') return item.page.responseTimeMs || item.page.responseTime || 0;
        return item.value;
      };
      const a = sortValue(left); const b = sortValue(right);
      const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [pages, tab, filter, search, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function changeTab(value: PageTab) { setTab(value); setFilter('all'); setPage(1); }
  function changeFilter(value: PageFilter) { setFilter(value); setPage(1); }
  function changeSort(key: SortKey) { setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })); setPage(1); }
  function header(label: string, key: SortKey) { return <th scope="col" aria-sort={sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}><button className="sort-button" onClick={() => changeSort(key)}>{label} <span>{sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>; }

  const filters: Array<[PageFilter, string]> = tab === 'all'
    ? [['all', 'All pages'], ['200', '200 OK'], ['content', 'Content found'], ['missing', 'Content missing'], ['errors', 'Errors']]
    : [['all', 'All with data'], ['200', '200 OK'], ['errors', 'Errors']];
  return <>
    <nav className="page-data-tabs" aria-label="On-page data categories">{TABS.map(item => <button key={item.value} className={tab === item.value ? 'active' : ''} onClick={() => changeTab(item.value)}>{item.label} <span>{tabCounts[item.value]}</span></button>)}</nav>
    <div className="toolbar page-data-toolbar"><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={tab === 'all' ? 'Search URLs, titles, descriptions or status codes…' : `Search URLs or ${tabValueLabel(tab).toLowerCase()}…`} />{filters.map(([value, label]) => <button key={value} className={filter === value ? 'pill active' : 'pill'} onClick={() => changeFilter(value)}>{label}</button>)}</div>
    <div className="table-wrap pages-table-wrap">
      <table className={tab === 'all' ? 'pages-table pages-table-all' : 'pages-table pages-table-data'} aria-label={tab === 'all' ? 'All audited pages' : `Pages with ${tabValueLabel(tab).toLowerCase()}`}>
        <colgroup>
          <col className="page-column-index" /><col className="page-column-status" />
          <col className="page-column-url" /><col className="page-column-value" />
          {tab === 'all' ? <><col className="page-column-content" /><col className="page-column-links" /><col className="page-column-latency" /></> : <col className="page-column-count" />}
          <col className="page-column-action" />
        </colgroup>
        <thead><tr>
          {header('#', 'index')}{header('Status', 'status')}{header('URL', 'url')}
          {header(tab === 'all' ? 'Title' : tabValueLabel(tab), 'value')}
          {tab === 'all' ? <>{header('Content area', 'content')}{header('Links', 'links')}{header('Latency', 'latency')}</> : header(countLabel(tab), 'length')}
          <th scope="col">Action</th>
        </tr></thead>
        <tbody>{rows.length ? rows.map(({ page: item, value }, index) => <tr key={item.url}>
          <td data-label="#">{(currentPage - 1) * pageSize + index + 1}</td>
          <td data-label="Status"><span className={item.statusCode === 200 ? 'code success' : 'code failure'}>{item.statusCode ?? '—'}</span></td>
          <td data-label="URL" className="url"><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a></td>
          <td data-label={tab === 'all' ? 'Title' : tabValueLabel(tab)} className="page-data-value">{value || '—'}</td>
          {tab === 'all' ? <>
            <td data-label="Content area"><span className={contentFound(item) ? 'tag positive' : 'tag neutral'}>{contentFound(item) ? `Found (${item.customContent?.wordCount || 0}w)` : 'None'}</span></td>
            <td data-label="Links">{item.links?.length || 0}</td>
            <td data-label="Latency">{item.responseTimeMs || item.responseTime ? `${item.responseTimeMs || item.responseTime}ms` : '—'}</td>
          </> : <td data-label={countLabel(tab)}>{countFor(item, tab, value).toLocaleString()}</td>}
          <td data-label="Action"><button className="inspect" onClick={() => onInspectPage(item, tab === 'content' ? 'content' : 'overview')}>Inspect</button></td>
        </tr>) : <tr><td colSpan={tab === 'all' ? 8 : 6} className="empty">{tab === 'all' ? 'No audited pages match the selected filter.' : `No pages with ${tabValueLabel(tab).toLowerCase()} data match the selected filter.`}</td></tr>}</tbody>
      </table>
    </div>
    {filtered.length > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </>;
}
