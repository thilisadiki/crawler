import { useMemo, useState } from 'react';
import type { CrawledLink } from '../../types/crawl';

type LinkFilter = 'all' | 'internal' | 'external' | 'in-content' | '200' | 'errors' | 'nofollow';
type SortKey = 'index' | 'status' | 'anchor' | 'destination' | 'type' | 'content' | 'nofollow' | 'source';

function destination(link: CrawledLink) { return link.targetUrl || link.url || ''; }
function isInternal(link: CrawledLink) { return link.isInternal === true || link.linkType === 'Internal'; }
function status(link: CrawledLink) { return link.statusCode ?? 0; }
function safeUrl(value: string) { return /^https?:\/\//i.test(value); }

function LinkInspector({ link, onClose }: { link: CrawledLink; onClose: () => void }) {
  const href = destination(link);
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="inspector link-inspector" role="dialog" aria-modal="true" aria-label="Discovered link details" onMouseDown={event => event.stopPropagation()}>
      <header><div><p className="eyebrow">Discovered link</p><h2>{link.anchorText || '[No anchor text]'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close inspection">×</button></header>
      <div className="detail-grid"><div><span>Status</span><strong>{link.statusCode ?? 'Not checked'}</strong></div><div><span>Type</span><strong>{link.linkType || 'Unknown'}</strong></div><div><span>Content area</span><strong>{link.isInsideCustom ? 'Yes' : 'No'}</strong></div><div><span>Directive</span><strong>{link.isNofollow ? 'nofollow' : 'dofollow'}</strong></div></div>
      <section className="detail-section"><h3>Destination</h3><p className="breakable">{safeUrl(href) ? <a href={href} target="_blank" rel="noreferrer">{href}</a> : href || 'No usable destination'}</p><h3>Source page</h3><p className="breakable">{link.sourceUrl || 'Not recorded'}</p><dl><dt>Raw href</dt><dd>{link.rawHref || '—'}</dd><dt>rel attribute</dt><dd>{link.rel || '—'}</dd><dt>target attribute</dt><dd>{link.target || '—'}</dd></dl></section>
    </section>
  </div>;
}

export function LinksExplorer({ links, sharedSearch }: { links: CrawledLink[]; sharedSearch: string }) {
  const [filter, setFilter] = useState<LinkFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'index', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<CrawledLink | null>(null);
  const counts = useMemo(() => ({
    all: links.length,
    internal: links.filter(isInternal).length,
    external: links.filter(link => link.linkType === 'External').length,
    'in-content': links.filter(link => link.isInsideCustom).length,
    '200': links.filter(link => status(link) === 200).length,
    errors: links.filter(link => status(link) === 0 || status(link) >= 400).length,
    nofollow: links.filter(link => link.isNofollow).length
  }), [links]);
  const filtered = useMemo(() => {
    const query = sharedSearch.trim().toLowerCase();
    const matches = links.filter(link => {
      const content = `${link.anchorText || ''} ${destination(link)} ${link.sourceUrl || ''} ${link.statusCode ?? ''}`.toLowerCase();
      if (query && !content.includes(query)) return false;
      if (filter === 'internal') return isInternal(link);
      if (filter === 'external') return link.linkType === 'External';
      if (filter === 'in-content') return Boolean(link.isInsideCustom);
      if (filter === '200') return status(link) === 200;
      if (filter === 'errors') return status(link) === 0 || status(link) >= 400;
      if (filter === 'nofollow') return Boolean(link.isNofollow);
      return true;
    });
    const value = (link: CrawledLink, index: number): string | number => {
      if (sort.key === 'index') return index;
      if (sort.key === 'status') return status(link);
      if (sort.key === 'anchor') return link.anchorText || '';
      if (sort.key === 'destination') return destination(link);
      if (sort.key === 'type') return link.linkType || '';
      if (sort.key === 'content') return link.isInsideCustom ? 1 : 0;
      if (sort.key === 'nofollow') return link.isNofollow ? 1 : 0;
      return link.sourceUrl || '';
    };
    return matches.map((link, index) => ({ link, index })).sort((left, right) => {
      const a = value(left.link, left.index); const b = value(right.link, right.index);
      const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [links, filter, sharedSearch, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  function selectFilter(value: LinkFilter) { setFilter(value); setPage(1); }
  function changeSort(key: SortKey) { setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' })); setPage(1); }
  function header(label: string, key: SortKey) { return <th><button className="sort-button" onClick={() => changeSort(key)}>{label} <span>{sort.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>; }

  const filters: Array<[LinkFilter, string]> = [['all', 'All links'], ['internal', 'Internal'], ['external', 'External'], ['in-content', 'In content area'], ['200', '200 OK'], ['errors', 'Errors & broken'], ['nofollow', 'Nofollow']];
  return <>
    <div className="sub-tabs" aria-label="Link filters">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'pill active' : 'pill'} onClick={() => selectFilter(value)}>{label} ({counts[value]})</button>)}</div>
    <div className="table-wrap"><table><thead><tr>{header('#', 'index')}{header('Status', 'status')}{header('Anchor text', 'anchor')}{header('Destination URL', 'destination')}{header('Type', 'type')}{header('Content area', 'content')}{header('Nofollow', 'nofollow')}{header('Source page', 'source')}<th /></tr></thead><tbody>
      {rows.length ? rows.map(({ link }, index) => { const href = destination(link); const code = status(link); return <tr key={`${link.sourceUrl}|${href}|${link.anchorText}|${index}`}><td>{(currentPage - 1) * pageSize + index + 1}</td><td><span className={code === 200 ? 'code success' : code >= 400 || code === 0 ? 'code failure' : 'code neutral'}>{link.statusCode ?? '—'}</span></td><td title={link.anchorText}>{link.anchorText || '[No Text]'}</td><td className="url" title={href}>{safeUrl(href) ? <a href={href} target="_blank" rel="noreferrer">{href}</a> : href || '—'}</td><td><span className={isInternal(link) ? 'tag positive' : 'tag neutral'}>{link.linkType || 'Unknown'}</span></td><td>{link.isInsideCustom ? <span className="tag positive">Yes</span> : 'No'}</td><td>{link.isNofollow ? 'nofollow' : 'dofollow'}</td><td className="url" title={link.sourceUrl}>{link.sourceUrl || '—'}</td><td><button className="inspect" onClick={() => setSelected(link)}>Inspect</button></td></tr>; }) : <tr><td colSpan={9} className="empty">{links.length ? 'No links match the current search or filters.' : 'No links discovered yet. Run a crawl to extract on-page links.'}</td></tr>}
    </tbody></table></div>
    {filtered.length > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>}
    {selected && <LinkInspector link={selected} onClose={() => setSelected(null)} />}
  </>;
}
