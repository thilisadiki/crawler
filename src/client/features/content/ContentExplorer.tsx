import { useMemo, useState } from 'react';
import type { CrawlPage } from '../../types/crawl';

function extractedText(page: CrawlPage) { return page.customContent?.fullText || page.customContent?.textSnippet || page.fullPageText || ''; }

export function ContentExplorer({ pages, sharedSearch }: { pages: CrawlPage[]; sharedSearch: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const matching = useMemo(() => {
    const query = sharedSearch.trim().toLowerCase();
    return pages.filter(item => !query || `${item.url} ${item.title || ''} ${extractedText(item)}`.toLowerCase().includes(query));
  }, [pages, sharedSearch]);
  const totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const cards = matching.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  async function copy(pageRecord: CrawlPage) {
    const text = extractedText(pageRecord);
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setCopiedUrl(pageRecord.url); window.setTimeout(() => setCopiedUrl(current => current === pageRecord.url ? null : current), 1800); } catch { /* Clipboard access can be blocked by the browser. */ }
  }
  return <>
    <div className="content-list">{cards.length ? cards.map(record => {
      const content = record.customContent; const headings = content?.headings?.length ? content.headings : record.h1List || [];
      const words = content?.wordCount || record.totalWords || 0; const text = extractedText(record);
      return <article className="content-card" key={record.url}><header><div><a className="content-url" href={record.url} target="_blank" rel="noreferrer">{record.url}</a><p><strong>{record.title || 'No title tag'}</strong> · {words.toLocaleString()} words · {record.internalLinksCount || 0} internal links ({record.customLinksCount || 0} in content area)</p></div><div className="content-actions"><button className="inspect" disabled={!text} onClick={() => void copy(record)}>{copiedUrl === record.url ? '✓ Copied' : 'Copy full text'}</button><span className={content?.detected ? 'tag positive' : 'tag neutral'}>{content?.detected ? content.detectionMethod === 'heuristic' ? 'Content auto-found' : 'Content area detected' : 'Full page text'}</span></div></header><div><span className="property-label">Headings extracted ({headings.length})</span><div className="heading-list">{headings.length ? headings.map((heading, index) => <span key={`${heading}-${index}`}>{heading}</span>) : <small>No headings detected</small>}</div></div><div><span className="property-label">{content?.detected ? 'All content area text' : 'All rendered page text'} ({words.toLocaleString()} words)</span><pre className="content-text">{text || 'No content text extracted.'}</pre></div></article>;
    }) : <div className="empty content-empty">{pages.length ? 'No extracted content matches this search.' : 'No content extracted yet. Run a crawl to view rendered SEO text blocks.'}</div>}</div>
    {matching.length > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, matching.length)} of {matching.length.toLocaleString()}</span><label>Pages <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="5">5</option><option value="10">10</option><option value="25">25</option></select></label><button className="secondary" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </>;
}
