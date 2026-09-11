import { useEffect, useState } from 'react';
import { crawlerClient } from '../../api/crawler-client';
import type { CrawlHistoryResourceWindow, CrawledResource } from '../../types/crawl';
import { formatBytes, ResourceInspector } from '../resources/ResourcesExplorer';

type ResourceFilter = 'all' | 'stylesheet' | 'script' | 'image' | 'media-font' | 'loaded' | 'blocked' | 'errors';
type SortKey = 'index' | 'type' | 'url' | 'status' | 'size' | 'source';

const FILTERS: Array<[ResourceFilter, string]> = [
  ['all', 'All'], ['stylesheet', 'CSS'], ['script', 'JavaScript'], ['image', 'Images'], ['media-font', 'Media & fonts'],
  ['loaded', 'Loaded'], ['blocked', 'Blocked'], ['errors', 'Errors']
];

function isLoaded(resource: CrawledResource) {
  return resource.discoveryStatus === 'Loaded' || ((resource.statusCode || 0) >= 200 && (resource.statusCode || 0) < 400);
}

function isError(resource: CrawledResource) {
  return resource.statusCode === 0 || (resource.statusCode || 0) >= 400;
}

export function SavedAuditResourcesExplorer({ crawlId, sharedSearch }: { crawlId: string; sharedSearch: string }) {
  const [filter, setFilter] = useState<ResourceFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [resourceWindow, setResourceWindow] = useState<CrawlHistoryResourceWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CrawledResource | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      void crawlerClient.historyResources(crawlId, {
        offset: (page - 1) * pageSize, limit: pageSize, filter, sort: sort.key, direction: sort.direction, query: sharedSearch.trim()
      }).then(result => {
        if (!controller.signal.aborted) setResourceWindow(result);
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load saved audit resources.');
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, sharedSearch ? 200 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [crawlId, page, pageSize, filter, sort, sharedSearch]);

  const counts = resourceWindow?.counts || { all: 0, stylesheet: 0, script: 0, image: 0, 'media-font': 0, loaded: 0, blocked: 0, errors: 0 };
  const total = resourceWindow?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = resourceWindow?.resources || [];
  function selectFilter(value: ResourceFilter) { setFilter(value); setPage(1); }
  function changeSort(key: SortKey) { setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })); setPage(1); }
  function header(label: string, key: SortKey) { return <th scope="col"><button className="sort-button" onClick={() => changeSort(key)}>{label} <span>{sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>; }

  return <>
    <div className="sub-tabs" aria-label="Saved audit resource filters">{FILTERS.map(([value, label]) => <button key={value} className={filter === value ? 'pill active' : 'pill'} onClick={() => selectFilter(value)}>{label} ({counts[value]})</button>)}</div>
    {error && <p className="error-message">{error}</p>}
    <div className="table-wrap"><table><thead><tr>{header('#', 'index')}{header('Type', 'type')}{header('Resource URL', 'url')}{header('Status', 'status')}{header('Size', 'size')}{header('Source page', 'source')}<th>Action</th></tr></thead><tbody>
      {loading ? <tr><td colSpan={7} className="empty">Loading saved audit resources…</td></tr> : rows.length ? rows.map((resource, index) => {
        const status = resource.statusCode || resource.discoveryStatus || 'Not checked';
        const problem = isError(resource);
        return <tr key={`${resource.sourceUrl}|${resource.resourceType}|${resource.url}|${index}`}><td>{(currentPage - 1) * pageSize + index + 1}</td><td><span className="tag positive">{resource.resourceType || 'Other'}</span></td><td className="url" title={resource.url}><a href={resource.url} target="_blank" rel="noreferrer">{resource.url}</a></td><td><span className={isLoaded(resource) ? 'code success' : problem ? 'code failure' : 'code neutral'}>{status}</span></td><td>{formatBytes(resource.sizeBytes)}</td><td className="url" title={resource.sourceUrl}>{resource.sourceUrl || '—'}</td><td><button className="inspect" onClick={() => setSelected(resource)}>Inspect</button></td></tr>;
      }) : <tr><td colSpan={7} className="empty">No saved resources match the selected filter.</td></tr>}
    </tbody></table></div>
    {total > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, total)} of {total.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1 || loading} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages || loading} onClick={() => setPage(current => current + 1)}>Next</button></div>}
    {selected && <ResourceInspector resource={selected} onClose={() => setSelected(null)} />}
  </>;
}
