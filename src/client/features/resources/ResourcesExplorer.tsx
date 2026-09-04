import { useMemo, useState } from 'react';
import type { CrawlPage, CrawledResource } from '../../types/crawl';

type ResourceFilter = 'all' | 'stylesheet' | 'script' | 'image' | 'media-font' | 'loaded' | 'blocked' | 'errors';
type SortKey = 'index' | 'type' | 'url' | 'status' | 'size' | 'source';

function normalizeType(resource: CrawledResource) { return (resource.resourceType || 'Other').toLowerCase(); }
function isLoaded(resource: CrawledResource) { return resource.discoveryStatus === 'Loaded' || ((resource.statusCode || 0) >= 200 && (resource.statusCode || 0) < 400); }
function isError(resource: CrawledResource) { return resource.statusCode === 0 || (resource.statusCode || 0) >= 400; }
function formatBytes(size?: number | null) {
  if (!size || size < 1) return '—';
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}

function ResourceInspector({ resource, onClose }: { resource: CrawledResource; onClose: () => void }) {
  const status = resource.statusCode || resource.discoveryStatus || 'Not checked';
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="inspector link-inspector" role="dialog" aria-modal="true" aria-label="Resource details" onMouseDown={event => event.stopPropagation()}>
      <header><div><p className="eyebrow">Embedded resource</p><h2>{resource.resourceType || 'Other resource'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close inspection">×</button></header>
      <div className="detail-grid"><div><span>Status</span><strong>{status}</strong></div><div><span>Size</span><strong>{formatBytes(resource.sizeBytes)}</strong></div><div><span>Element</span><strong>{resource.element || '—'}</strong></div><div><span>Attribute</span><strong>{resource.attribute || '—'}</strong></div></div>
      <section className="detail-section"><h3>Resource URL</h3><p className="breakable"><a href={resource.url} target="_blank" rel="noreferrer">{resource.url}</a></p><h3>Source page</h3><p className="breakable">{resource.sourceUrl || 'Not recorded'}</p><dl><dt>Original attribute value</dt><dd>{resource.rawUrl || '—'}</dd><dt>Discovery state</dt><dd>{resource.discoveryStatus || 'Not checked'}</dd></dl></section>
    </section>
  </div>;
}

export function ResourcesExplorer({ pages, sharedSearch }: { pages: CrawlPage[]; sharedSearch: string }) {
  const [filter, setFilter] = useState<ResourceFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<CrawledResource | null>(null);
  const resources = useMemo(() => {
    const seen = new Set<string>();
    return pages.flatMap(page => (page.resources || []).map(resource => ({ ...resource, sourceUrl: page.url }))).filter(resource => {
      const key = `${resource.sourceUrl}|${resource.resourceType || 'Other'}|${resource.url}`;
      if (!resource.url || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }, [pages]);
  const counts = useMemo(() => ({
    all: resources.length,
    stylesheet: resources.filter(resource => normalizeType(resource) === 'stylesheet').length,
    script: resources.filter(resource => normalizeType(resource) === 'script').length,
    image: resources.filter(resource => normalizeType(resource) === 'image').length,
    'media-font': resources.filter(resource => ['media', 'font'].includes(normalizeType(resource))).length,
    loaded: resources.filter(isLoaded).length,
    blocked: resources.filter(resource => resource.discoveryStatus === 'Blocked by crawler').length,
    errors: resources.filter(isError).length
  }), [resources]);
  const filtered = useMemo(() => {
    const query = sharedSearch.trim().toLowerCase();
    const matches = resources.filter(resource => {
      const content = `${resource.url} ${resource.resourceType || ''} ${resource.sourceUrl || ''} ${resource.discoveryStatus || ''} ${resource.statusCode || ''}`.toLowerCase();
      if (query && !content.includes(query)) return false;
      const type = normalizeType(resource);
      if (filter === 'stylesheet') return type === 'stylesheet';
      if (filter === 'script') return type === 'script';
      if (filter === 'image') return type === 'image';
      if (filter === 'media-font') return type === 'media' || type === 'font';
      if (filter === 'loaded') return isLoaded(resource);
      if (filter === 'blocked') return resource.discoveryStatus === 'Blocked by crawler';
      if (filter === 'errors') return isError(resource);
      return true;
    });
    const value = (resource: CrawledResource, index: number): string | number => {
      if (sort.key === 'index') return index;
      if (sort.key === 'type') return resource.resourceType || '';
      if (sort.key === 'url') return resource.url;
      if (sort.key === 'status') return resource.statusCode || resource.discoveryStatus || '';
      if (sort.key === 'size') return resource.sizeBytes || 0;
      return resource.sourceUrl || '';
    };
    return matches.map((resource, index) => ({ resource, index })).sort((left, right) => {
      const a = value(left.resource, left.index); const b = value(right.resource, right.index);
      const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [resources, filter, sharedSearch, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  function changeFilter(value: ResourceFilter) { setFilter(value); setPage(1); }
  function changeSort(key: SortKey) { setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })); setPage(1); }
  function header(label: string, key: SortKey) { return <th><button className="sort-button" onClick={() => changeSort(key)}>{label} <span>{sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>; }
  const filters: Array<[ResourceFilter, string]> = [['all', 'All'], ['stylesheet', 'CSS'], ['script', 'JavaScript'], ['image', 'Images'], ['media-font', 'Media & fonts'], ['loaded', 'Loaded'], ['blocked', 'Blocked'], ['errors', 'Errors']];
  return <>
    <div className="sub-tabs" aria-label="Resource filters">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'pill active' : 'pill'} onClick={() => changeFilter(value)}>{label} ({counts[value]})</button>)}</div>
    <div className="table-wrap"><table><thead><tr>{header('#', 'index')}{header('Type', 'type')}{header('Resource URL', 'url')}{header('Status', 'status')}{header('Size', 'size')}{header('Source page', 'source')}<th /></tr></thead><tbody>
      {rows.length ? rows.map(({ resource }, index) => { const status = resource.statusCode || resource.discoveryStatus || 'Not checked'; const isBad = isError(resource); return <tr key={`${resource.sourceUrl}|${resource.resourceType}|${resource.url}|${index}`}><td>{(currentPage - 1) * pageSize + index + 1}</td><td><span className="tag positive">{resource.resourceType || 'Other'}</span></td><td className="url" title={resource.url}><a href={resource.url} target="_blank" rel="noreferrer">{resource.url}</a></td><td><span className={isLoaded(resource) ? 'code success' : isBad ? 'code failure' : 'code neutral'}>{status}</span></td><td>{formatBytes(resource.sizeBytes)}</td><td className="url" title={resource.sourceUrl}>{resource.sourceUrl || '—'}</td><td><button className="inspect" onClick={() => setSelected(resource)}>Inspect</button></td></tr>; }) : <tr><td colSpan={7} className="empty">{resources.length ? 'No resources match the current search or filters.' : 'No embedded resources discovered yet. Run a crawl to inventory CSS, JavaScript, media, fonts, and images.'}</td></tr>}
    </tbody></table></div>
    {filtered.length > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>}
    {selected && <ResourceInspector resource={selected} onClose={() => setSelected(null)} />}
  </>;
}
