import { useMemo, useState } from 'react';
import type { CrawlPage, CrawledLink } from '../../types/crawl';
import { getSeoIssues, type SeoIssue, type Severity } from './issueRules';

function severityClass(severity: Severity) { return `severity ${severity.toLowerCase()}`; }

export function IssuesExplorer({ pages, links, sharedSearch, onInspectPage }: { pages: CrawlPage[]; links: CrawledLink[]; sharedSearch: string; onInspectPage: (url: string) => void }) {
  const issues = useMemo(() => getSeoIssues(pages, links), [pages, links]);
  const [activeCode, setActiveCode] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const grouped = useMemo(() => Array.from(issues.reduce((all, issue) => {
    const current = all.get(issue.code) || { issue, count: 0 };
    current.count++; all.set(issue.code, current); return all;
  }, new Map<string, { issue: SeoIssue; count: number }>())), [issues]);
  const matching = useMemo(() => {
    const query = sharedSearch.trim().toLowerCase();
    return issues.filter(issue => (activeCode === 'all' || issue.code === activeCode) && (!query || `${issue.url} ${issue.label} ${issue.detail} ${issue.severity}`.toLowerCase().includes(query)));
  }, [issues, activeCode, sharedSearch]);
  const totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = matching.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  function select(code: string) { setActiveCode(code); setPage(1); }
  return <>
    <div className="issue-summary" aria-label="SEO issue categories"><button className={activeCode === 'all' ? 'issue-card active' : 'issue-card'} onClick={() => select('all')}><strong>{issues.length.toLocaleString()}</strong><span>All issues</span></button>{grouped.map(([code, group]) => <button key={code} className={activeCode === code ? `issue-card active ${group.issue.severity.toLowerCase()}` : `issue-card ${group.issue.severity.toLowerCase()}`} onClick={() => select(code)}><strong>{group.count.toLocaleString()}</strong><span>{group.issue.label}</span></button>)}</div>
    <div className="table-wrap"><table><thead><tr><th>Severity</th><th>Issue</th><th>Page</th><th>Details</th><th /></tr></thead><tbody>{rows.length ? rows.map((issue, index) => <tr key={`${issue.code}|${issue.url}|${index}`}><td><span className={severityClass(issue.severity)}>{issue.severity}</span></td><td><strong>{issue.label}</strong><br /><small className="issue-description">{issue.description}</small></td><td className="url" title={issue.url}>{issue.url}</td><td title={issue.detail}>{issue.detail}</td><td><button className="inspect" onClick={() => onInspectPage(issue.url)}>Inspect</button></td></tr>) : <tr><td colSpan={5} className="empty">{issues.length ? 'No SEO issues match the selected category or search.' : 'No SEO issues found in the crawled pages.'}</td></tr>}</tbody></table></div>
    {matching.length > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, matching.length)} of {matching.length.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </>;
}
