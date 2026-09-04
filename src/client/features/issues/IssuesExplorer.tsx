import { useMemo, useState } from 'react';
import type { CrawlPage, CrawledLink } from '../../types/crawl';
import { getSeoIssues, type SeoIssue, type Severity } from './issueRules';

function severityClass(severity: Severity) { return `severity ${severity.toLowerCase()}`; }

type IssueGroup = { code: string; issue: SeoIssue; count: number };

export function IssuesExplorer({ pages, links, sharedSearch, onInspectPage }: { pages: CrawlPage[]; links: CrawledLink[]; sharedSearch: string; onInspectPage: (url: string) => void }) {
  const issues = useMemo(() => getSeoIssues(pages, links), [pages, links]);
  const [activeCode, setActiveCode] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const grouped = useMemo<IssueGroup[]>(() => Array.from(issues.reduce((all, issue) => {
    const current = all.get(issue.code) || { code: issue.code, issue, count: 0 };
    current.count++;
    all.set(issue.code, current);
    return all;
  }, new Map<string, IssueGroup>()).values()).sort((a, b) => b.count - a.count || a.issue.label.localeCompare(b.issue.label)), [issues]);
  const activeGroup = grouped.find(group => group.code === activeCode);
  const matching = useMemo(() => {
    const query = sharedSearch.trim().toLowerCase();
    return issues.filter(issue => (activeCode === 'all' || issue.code === activeCode) && (!query || `${issue.url} ${issue.label} ${issue.detail} ${issue.severity}`.toLowerCase().includes(query)));
  }, [issues, activeCode, sharedSearch]);
  const totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = matching.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function select(code: string) {
    setActiveCode(code);
    setPage(1);
  }

  const detailTitle = activeGroup?.issue.label || 'All issues';
  const detailDescription = activeGroup?.issue.description || 'Select an issue from the list to see why it was reported and filter its affected URLs.';
  const detailSeverity = activeGroup?.issue.severity;
  const detailCount = activeGroup?.count || issues.length;

  return <>
    <section className="issue-workbench" aria-label="SEO issue summary">
      <div className="issue-catalogue">
        <div className="issue-catalogue-head"><span>Issue name</span><span>Priority</span><span>URLs</span></div>
        <div className="issue-catalogue-list" role="listbox" aria-label="SEO issue types">
          <button type="button" role="option" aria-selected={activeCode === 'all'} className={activeCode === 'all' ? 'issue-group-row active' : 'issue-group-row'} onClick={() => select('all')}>
            <strong>All issues</strong><span>—</span><b>{issues.length.toLocaleString()}</b>
          </button>
          {grouped.map(group => <button key={group.code} type="button" role="option" aria-selected={activeCode === group.code} className={activeCode === group.code ? 'issue-group-row active' : 'issue-group-row'} onClick={() => select(group.code)}>
            <strong>{group.issue.label}</strong><span className={severityClass(group.issue.severity)}>{group.issue.severity}</span><b>{group.count.toLocaleString()}</b>
          </button>)}
          {!grouped.length && <p className="empty">No SEO issues found in the crawled pages.</p>}
        </div>
      </div>
      <aside className="issue-detail" aria-live="polite">
        <small>Issue details</small>
        <h3>{detailTitle}</h3>
        {detailSeverity && <span className={severityClass(detailSeverity)}>{detailSeverity}</span>}
        <p>{detailDescription}</p>
        <dl><div><dt>Affected URLs</dt><dd>{detailCount.toLocaleString()}</dd></div><div><dt>Filtered results</dt><dd>{matching.length.toLocaleString()}</dd></div></dl>
        <p className="issue-detail-note">Review the affected URLs below, then use Inspect to see the page-level evidence.</p>
      </aside>
    </section>
    <div className="issue-results-head"><strong>Affected URLs</strong><span>{matching.length.toLocaleString()} result{matching.length === 1 ? '' : 's'}</span></div>
    <div className="table-wrap"><table><thead><tr><th>Priority</th><th>Issue</th><th>Page</th><th>Details</th><th /></tr></thead><tbody>{rows.length ? rows.map((issue, index) => <tr key={`${issue.code}|${issue.url}|${index}`}><td><span className={severityClass(issue.severity)}>{issue.severity}</span></td><td><strong>{issue.label}</strong></td><td className="url" title={issue.url}>{issue.url}</td><td title={issue.detail}>{issue.detail}</td><td><button className="inspect" onClick={() => onInspectPage(issue.url)}>Inspect</button></td></tr>) : <tr><td colSpan={5} className="empty">{issues.length ? 'No SEO issues match the selected issue or search.' : 'No SEO issues found in the crawled pages.'}</td></tr>}</tbody></table></div>
    {matching.length > 0 && <div className="pagination"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, matching.length)} of {matching.length.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {currentPage} of {totalPages}</span><button className="secondary" disabled={currentPage === totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </>;
}
