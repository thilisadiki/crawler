import { FormEvent, useMemo, useState } from 'react';
import { crawlerClient } from './api/crawler-client';
import { useCrawler } from './features/crawl/useCrawler';
import { LinksExplorer } from './features/links/LinksExplorer';
import { ResourcesExplorer } from './features/resources/ResourcesExplorer';
import { IssuesExplorer } from './features/issues/IssuesExplorer';
import { getSeoIssues } from './features/issues/issueRules';
import { ContentExplorer } from './features/content/ContentExplorer';
import { HistoryExplorer } from './features/history/HistoryExplorer';
import type { CrawlConfig, CrawlPage, CrawlScope } from './types/crawl';
import './styles.css';

const DEFAULT_CONFIG: CrawlConfig = {
  seedUrl: '', crawlScope: 'single-url', maxPages: 1, maxDepth: 0,
  concurrency: 1, delayBetweenRequestsMs: 500, autoScroll: true,
  customContentSelector: '', excludePatterns: [], includePatterns: [],
  respectRobotsTxt: false, region: 'auto', proxy: '', blockCrossDomainRedirects: true
};

function numberValue(value: string, fallback: number) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : fallback;
}

function statusLabel(state: string, engine?: string) {
  if (state === 'ready') return 'System ready';
  if (state === 'paused') return 'Paused';
  if (state === 'stopping') return 'Stopping…';
  if (state === 'completed') return 'Audit complete';
  return engine === 'http' ? 'Direct DOM engine active' : engine === 'browser' ? 'Browser engine active' : 'Starting engine';
}

function contentFound(page: CrawlPage) {
  return Boolean(page.customContent?.detected);
}

function formatBytes(value?: number) {
  if (!value) return '—';
  return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
}

function PageInspector({ page, onClose }: { page: CrawlPage; onClose: () => void }) {
  const content = page.customContent;
  const comparison = page.renderComparison;
  const [tab, setTab] = useState<'overview' | 'content' | 'links'>('overview');
  const h1s = page.h1List?.filter(Boolean).join(' • ') || page.h1 || '[No H1 tag found]';
  const h2s = page.h2List?.filter(Boolean).join(' • ') || '[No H2 sub-headings found]';
  const contentText = content?.fullText || content?.textSnippet || page.fullPageText || 'No rendered text was returned.';
  const links = page.links || [];
  const contentLabel = content?.detected ? 'Content area • Active' : 'Content area';

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="inspector page-inspector" role="dialog" aria-modal="true" aria-label="Audited page details" onMouseDown={event => event.stopPropagation()}>
      <header className="page-inspector-header"><div><span className={page.statusCode === 200 ? 'code success' : 'code failure'}>{page.statusCode ?? '—'}</span><a className="page-inspector-url" href={page.url} target="_blank" rel="noreferrer">{page.url}</a></div><button className="icon-button" onClick={onClose} aria-label="Close inspection">×</button></header>
      <nav className="page-inspector-tabs" aria-label="Page inspection sections"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview &amp; SEO directives</button><button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>{contentLabel}</button><button className={tab === 'links' ? 'active' : ''} onClick={() => setTab('links')}>Discovered links ({links.length})</button></nav>
      <div className="page-inspector-body">
        {tab === 'overview' && <div className="overview-grid">
          <article className="overview-card"><span>Page title (&lt;title&gt;)</span><strong>{page.title || '[No title tag found]'}</strong></article>
          <article className="overview-card"><span>Meta description</span><strong>{page.metaDescription || '[No meta description found]'}</strong></article>
          <article className="overview-card"><span>Canonical URL</span><a href={page.canonical || page.url} target="_blank" rel="noreferrer">{page.canonical || '[No canonical URL found]'}</a></article>
          <article className="overview-card"><span>Meta robots directive</span><strong className="monospace">{page.metaRobots || '[No robots directive found]'}</strong></article>
          <article className="overview-card"><span>H1 heading(s)</span><strong>{h1s}</strong></article>
          <article className="overview-card"><span>H2 sub-headings</span><strong>{h2s}</strong></article>
          <article className="overview-card compact"><span>Word &amp; asset count</span><strong>{(page.totalWords ?? page.wordCount ?? 0).toLocaleString()} words • {page.imagesCount ?? 0} images</strong></article>
          <article className="overview-card compact"><span>Response time</span><strong className="accent">{(page.responseTimeMs ?? page.responseTime) ? `${page.responseTimeMs ?? page.responseTime} ms` : '—'}</strong></article>
          <article className="overview-card comparison-card"><span>Source HTML vs rendered DOM</span>{comparison?.available ? <><strong className={comparison.domChanged ? 'comparison-changed' : ''}>{comparison.domChanged ? 'DOM changed after rendering' : 'No meaningful DOM change detected'}</strong><small>{formatBytes(comparison.sourceHtmlBytes)} → {formatBytes(comparison.renderedHtmlBytes)} • {comparison.sourceWordCount?.toLocaleString() || 0} → {comparison.renderedWordCount?.toLocaleString() || 0} words • {comparison.renderedOnlyWordCount?.toLocaleString() || 0} rendered-only words</small></> : <strong>{comparison?.reason || 'This page has not been compared yet.'}</strong>}</article>
        </div>}
        {tab === 'content' && <section className="content-inspection"><div className="content-inspection-summary"><span className={content?.detected ? 'tag positive' : 'tag neutral'}>{content?.detected ? 'Content area detected' : 'Content area not detected'}</span><span>{content?.selectorUsed || 'No selector matched'}</span><span>{content?.wordCount?.toLocaleString() || page.totalWords?.toLocaleString() || 0} words</span></div><div className="content-inspection-grid"><article><span>Extracted sub-headings</span><p>{[...new Set([...(content?.headings || []), ...(page.h2List || [])])].join(' • ') || '[No sub-headings found]'}</p></article><article><span>Extracted rendered content</span><pre>{contentText}</pre></article></div></section>}
        {tab === 'links' && <section className="inspection-links"><div className="table-wrap"><table><thead><tr><th>Status</th><th>Anchor text</th><th>Destination URL</th><th>Type</th><th>In content area</th></tr></thead><tbody>{links.length ? links.map((link, index) => <tr key={`${link.url || link.targetUrl}-${index}`}><td><span className={link.statusCode === 200 ? 'code success' : (link.statusCode || 0) >= 400 ? 'code failure' : 'code neutral'}>{link.statusCode ?? '—'}</span></td><td>{link.anchorText || '[No text]'}</td><td className="url">{link.url || link.targetUrl || link.rawHref || '—'}</td><td>{link.linkType || 'Unknown'}</td><td>{link.isInsideCustom ? 'Yes' : 'No'}</td></tr>) : <tr><td colSpan={5} className="empty">No links were discovered on this page.</td></tr>}</tbody></table></div></section>}
      </div>
    </section>
  </div>;
}

export default function App() {
  const crawler = useCrawler();
  const [config, setConfig] = useState<CrawlConfig>(DEFAULT_CONFIG);
  const [advanced, setAdvanced] = useState(false);
  const [filter, setFilter] = useState<'all' | '200' | 'content' | 'missing' | 'errors'>('all');
  const [search, setSearch] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selectedPage, setSelectedPage] = useState<CrawlPage | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [explorerView, setExplorerView] = useState<'pages' | 'links' | 'resources' | 'issues' | 'content' | 'history'>('pages');
  const running = crawler.state === 'running' || crawler.state === 'paused' || crawler.state === 'stopping';
  const maxWorkers = crawler.capacity?.maxWorkersPerCrawl || 1;
  const pages = useMemo(() => crawler.pages.filter(page => {
    const query = search.trim().toLowerCase();
    const searchable = `${page.url} ${page.title || ''} ${page.statusCode || ''}`.toLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (filter === '200') return page.statusCode === 200;
    if (filter === 'content') return contentFound(page);
    if (filter === 'missing') return !contentFound(page);
    if (filter === 'errors') return Boolean(page.error) || (page.statusCode || 0) >= 400;
    return true;
  }), [crawler.pages, filter, search]);
  const contentPages = crawler.pages.filter(contentFound).length;
  const totalResultPages = Math.max(1, Math.ceil(pages.length / pageSize));
  const currentResultPage = Math.min(pageNumber, totalResultPages);
  const visiblePages = pages.slice((currentResultPage - 1) * pageSize, currentResultPage * pageSize);
  const resourceCount = useMemo(() => crawler.pages.reduce((count, page) => count + (page.resources?.length || 0), 0), [crawler.pages]);
  const issueCount = useMemo(() => getSeoIssues(crawler.pages, crawler.links).length, [crawler.pages, crawler.links]);
  const errors = (crawler.stats.errorsCount || 0) + (crawler.stats.blockedByRobotsCount || 0);
  const primaryAction = crawler.state === 'running'
    ? { label: 'Ⅱ Pause crawl', action: 'pause' as const }
    : crawler.state === 'paused'
      ? { label: '▶ Resume crawl', action: 'resume' as const }
      : { label: '▶ Execute crawl', action: 'start' as const };

  function update<K extends keyof CrawlConfig>(key: K, value: CrawlConfig[K]) {
    setConfig(current => ({ ...current, [key]: value }));
  }
  function setScope(scope: CrawlScope) {
    const single = scope === 'single-url';
    setConfig(current => ({
      ...current,
      crawlScope: scope,
      // The dashboard begins in single-URL mode (1 page). Restore the legacy
      // 50-page default the first time the user changes to a broader scope.
      maxPages: single ? 1 : (current.crawlScope === 'single-url' ? 50 : Math.max(2, current.maxPages)),
      // Keep a single-page audit at depth 0, but restore the legacy default
      // of three link levels when entering a multi-page crawl scope.
      maxDepth: single ? 0 : (current.crawlScope === 'single-url' ? 3 : Math.max(1, current.maxDepth))
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await crawler.run('start', config);
  }

  return <div className="app-shell">
    <header className="topbar"><div><span className="brand-mark">⌘</span><span className="brand">CrawlLoom <small>Browser-rendered SEO crawler</small></span></div><span className={`status ${crawler.state}`}><i />{statusLabel(crawler.state, crawler.engine?.mode)}</span></header>
    <main>
      <section className="card config-card">
        <div className="section-heading"><div><p className="eyebrow">Crawl target</p><h1>Start a browser-rendered audit</h1></div><button className="secondary" type="button" onClick={() => setAdvanced(open => !open)}>{advanced ? 'Hide advanced' : 'Advanced directives'}</button></div>
        <form onSubmit={submit}>
          <div className="core-fields">
            <label className="wide">Target address<input required value={config.seedUrl} onChange={event => update('seedUrl', event.target.value)} placeholder="graduateshub.org or https://www.example.com/section/" disabled={running} /></label>
            <label>Scope<select value={config.crawlScope} onChange={event => setScope(event.target.value as CrawlScope)} disabled={running}><option value="single-url">Single URL audit</option><option value="domain">Exact hostname</option><option value="subpath">Subfolder / path only</option><option value="subdomains">Domain & subdomains</option></select></label>
            <label>Page limit<input type="number" min="1" max="10000" value={config.maxPages} disabled={running || config.crawlScope === 'single-url'} onChange={event => update('maxPages', numberValue(event.target.value, 1))} /></label>
          </div>
          {advanced && <div className="advanced-grid">
            <label>Max crawl depth<input type="number" min="0" max="20" value={config.maxDepth} disabled={running || config.crawlScope === 'single-url'} onChange={event => update('maxDepth', numberValue(event.target.value, 0))} /></label>
            <label>Worker threads<input type="number" min="1" max={maxWorkers} value={config.concurrency} disabled={running} onChange={event => update('concurrency', Math.min(maxWorkers, numberValue(event.target.value, 1)))} /></label>
            <label>Rate limiter (ms)<input type="number" min="0" max="5000" step="50" value={config.delayBetweenRequestsMs} disabled={running} onChange={event => update('delayBetweenRequestsMs', numberValue(event.target.value, 500))} /></label>
            <label className="check"><input type="checkbox" checked={config.autoScroll} disabled={running} onChange={event => update('autoScroll', event.target.checked)} /> Dynamic auto-scroll</label>
            <label className="wide-advanced">Custom content selector<input value={config.customContentSelector} disabled={running} onChange={event => update('customContentSelector', event.target.value)} placeholder="Auto-detect, or e.g. .page-text" /></label>
            <label>Region<select value={config.region} disabled={running} onChange={event => update('region', event.target.value)}><option value="auto">Auto-detect from TLD</option><option value="ZA">South Africa</option><option value="GH">Ghana</option><option value="KE">Kenya</option><option value="NG">Nigeria</option><option value="GB">United Kingdom</option><option value="US">United States</option></select></label>
            <label>Proxy endpoint<input value={config.proxy} disabled={running} onChange={event => update('proxy', event.target.value)} placeholder="Optional proxy URL" /></label>
            <label className="wide-advanced">Disallow paths or regex<textarea rows={3} value={config.excludePatterns.join('\n')} disabled={running} onChange={event => update('excludePatterns', event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} placeholder={'/checkout\n/account\n.*\\.pdf$'} /></label>
            <label className="wide-advanced">Allow only paths or regex<textarea rows={3} value={config.includePatterns.join('\n')} disabled={running} onChange={event => update('includePatterns', event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} placeholder={'/sports/\n/casino/'} /></label>
            <label className="check"><input type="checkbox" checked={config.blockCrossDomainRedirects} disabled={running} onChange={event => update('blockCrossDomainRedirects', event.target.checked)} /> Lock target domain (block geo redirects)</label>
            <label className="check"><input type="checkbox" checked={config.respectRobotsTxt} disabled={running} onChange={event => update('respectRobotsTxt', event.target.checked)} /> Enforce robots.txt</label>
          </div>}
          <div className="actions"><button className="primary" type={primaryAction.action === 'start' ? 'submit' : 'button'} disabled={crawler.state === 'stopping'} onClick={primaryAction.action === 'start' ? undefined : () => void crawler.run(primaryAction.action)}>{primaryAction.label}</button><button className="danger" type="button" disabled={!running || crawler.state === 'stopping'} onClick={() => void crawler.run('stop')}>■ Abort</button><button className="secondary" type="button" onClick={() => void crawler.run('reset')}>↻ Clear / reset</button></div>
        </form>
        {crawler.error && <p className="error-message" role="alert">{crawler.error}</p>}
      </section>
      <section className="stat-grid" aria-label="Crawl summary">
        <Stat label="Pages audited" value={crawler.stats.pagesCrawled} detail={`${Math.min(100, Math.round((crawler.stats.pagesCrawled / Math.max(1, config.maxPages)) * 100))}% of limit`} />
        <Stat label="Pending queue" value={crawler.queueLength} detail={`${crawler.capacity?.availableSlots ?? '—'} crawl slot(s) free`} />
        <Stat label="Discovered links" value={(crawler.stats.internalLinksCount || 0) + (crawler.stats.externalLinksCount || 0)} detail={`${crawler.stats.externalLinksCount || 0} external`} />
        <Stat label="Content area coverage" value={`${crawler.pages.length ? Math.round((contentPages / crawler.pages.length) * 100) : 0}%`} detail={`${contentPages} pages verified`} />
        <Stat label="Errors & exclusions" value={errors} detail={crawler.engine?.mode === 'http' ? 'Direct DOM engine' : 'Browser-rendered crawl'} />
      </section>
      <section className="card explorer">
        <div className="explorer-head"><div><p className="eyebrow">{explorerView === 'pages' ? 'Audited pages' : explorerView === 'links' ? 'Discovered links & anchors' : explorerView === 'resources' ? 'Resources & assets' : explorerView === 'issues' ? 'SEO issues' : explorerView === 'content' ? 'Extracted content area text' : 'Saved crawl history'}</p><h2>{explorerView === 'pages' ? `${crawler.pages.length.toLocaleString()} page${crawler.pages.length === 1 ? '' : 's'} collected` : explorerView === 'links' ? `${crawler.links.length.toLocaleString()} link${crawler.links.length === 1 ? '' : 's'} collected` : explorerView === 'resources' ? 'Embedded resource inventory' : explorerView === 'issues' ? `${issueCount.toLocaleString()} issue${issueCount === 1 ? '' : 's'} identified` : explorerView === 'content' ? `${crawler.pages.length.toLocaleString()} extracted text block${crawler.pages.length === 1 ? '' : 's'}` : 'Crawls retained in MySQL'}</h2></div><div className="export-wrap"><button className="secondary" onClick={() => setExportOpen(open => !open)}>Export ▾</button>{exportOpen && <div className="export-menu">{[
          ['Excel workbook (.xlsx)', '/api/export/workbook.xlsx'], ['Pages CSV', '/api/export/pages.csv'], ['All links CSV', '/api/export/links.csv'], ['Resources CSV', '/api/export/resources.csv'], ['SEO issues CSV', '/api/export/issues.csv'], ['Content area CSV', '/api/export/custom-content.csv']
        ].map(([label, path]) => <a key={path} href={crawlerClient.exportUrl(path)}>{label}</a>)}</div>}</div></div>
        <nav className="explorer-tabs" aria-label="Dashboard data views"><button className={explorerView === 'pages' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('pages')}>Pages <span>{crawler.pages.length}</span></button><button className={explorerView === 'links' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('links')}>Discovered links & anchors <span>{crawler.links.length}</span></button><button className={explorerView === 'resources' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('resources')}>Resources & assets <span>{resourceCount}</span></button><button className={explorerView === 'issues' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('issues')}>SEO issues <span>{issueCount}</span></button><button className={explorerView === 'content' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('content')}>Extracted content</button><button className={explorerView === 'history' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('history')}>History</button></nav>
        {explorerView !== 'history' && <div className="toolbar"><input value={search} onChange={event => { setSearch(event.target.value); setPageNumber(1); }} placeholder={explorerView === 'pages' ? 'Search URLs, titles or status codes…' : explorerView === 'links' ? 'Search anchor text, URLs or status codes…' : explorerView === 'resources' ? 'Search resource URLs, types, source pages or status…' : explorerView === 'issues' ? 'Search issue names, URLs, details or severity…' : 'Search URLs, titles, or extracted text…'} />{explorerView === 'pages' && (['all', '200', 'content', 'missing', 'errors'] as const).map(item => <button key={item} className={filter === item ? 'pill active' : 'pill'} onClick={() => { setFilter(item); setPageNumber(1); }}>{item === 'all' ? `All (${crawler.pages.length})` : item === '200' ? '200 OK' : item === 'content' ? `Content found (${contentPages})` : item === 'missing' ? `Content missing (${crawler.pages.length - contentPages})` : `Errors (${errors})`}</button>)}</div>}
        {explorerView === 'pages' ? <><div className="table-wrap"><table><thead><tr><th>#</th><th>Status</th><th>URL</th><th>Title</th><th>Content area</th><th>Links</th><th>Latency</th><th /></tr></thead><tbody>{visiblePages.length ? visiblePages.map((page, index) => <tr key={page.url}><td>{(currentResultPage - 1) * pageSize + index + 1}</td><td><span className={page.statusCode === 200 ? 'code success' : 'code failure'}>{page.statusCode ?? '—'}</span></td><td className="url"><a href={page.url} target="_blank" rel="noreferrer">{page.url}</a></td><td>{page.title || '—'}</td><td><span className={contentFound(page) ? 'tag positive' : 'tag neutral'}>{contentFound(page) ? `Found (${page.customContent?.wordCount || 0}w)` : 'None'}</span></td><td>{page.links?.length || 0}</td><td>{page.responseTimeMs ? `${page.responseTimeMs}ms` : '—'}</td><td><button className="inspect" onClick={() => setSelectedPage(page)}>Inspect</button></td></tr>) : <tr><td colSpan={8} className="empty">No audited pages match these filters.</td></tr>}</tbody></table></div>{pages.length > 0 && <div className="pagination"><span>Showing {(currentResultPage - 1) * pageSize + 1}–{Math.min(currentResultPage * pageSize, pages.length)} of {pages.length.toLocaleString()}</span><label>Rows <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPageNumber(1); }}><option value="50">50</option><option value="100">100</option><option value="250">250</option></select></label><button className="secondary" disabled={currentResultPage === 1} onClick={() => setPageNumber(current => current - 1)}>Previous</button><span>Page {currentResultPage} of {totalResultPages}</span><button className="secondary" disabled={currentResultPage === totalResultPages} onClick={() => setPageNumber(current => current + 1)}>Next</button></div>}</> : explorerView === 'links' ? <LinksExplorer links={crawler.links} sharedSearch={search} /> : explorerView === 'resources' ? <ResourcesExplorer pages={crawler.pages} sharedSearch={search} /> : explorerView === 'issues' ? <IssuesExplorer pages={crawler.pages} links={crawler.links} sharedSearch={search} onInspectPage={url => { const target = crawler.pages.find(page => page.url === url); if (target) setSelectedPage(target); }} /> : explorerView === 'content' ? <ContentExplorer pages={crawler.pages} sharedSearch={search} /> : <HistoryExplorer />}
      </section>
    </main>
    {selectedPage && <PageInspector page={selectedPage} onClose={() => setSelectedPage(null)} />}
  </div>;
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="stat"><span>{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong><small>{detail}</small></article>;
}
