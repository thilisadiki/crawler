import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { crawlerClient } from './api/crawler-client';
import { useCrawler } from './features/crawl/useCrawler';
import { PagesExplorer } from './features/pages/PagesExplorer';
import { LinksExplorer } from './features/links/LinksExplorer';
import { ResourcesExplorer } from './features/resources/ResourcesExplorer';
import { IssuesExplorer } from './features/issues/IssuesExplorer';
import { getSeoIssues } from './features/issues/issueRules';
import { HistoryExplorer } from './features/history/HistoryExplorer';
import { ComparisonExplorer } from './features/history/ComparisonExplorer';
import { SavedAuditPagesExplorer } from './features/history/SavedAuditPagesExplorer';
import { SavedAuditLinksExplorer } from './features/history/SavedAuditLinksExplorer';
import { SavedAuditResourcesExplorer } from './features/history/SavedAuditResourcesExplorer';
import type { CrawlComparison, CrawlConfig, CrawlHistoryRecord, CrawlPage, CrawlScope, HtmlComparisonCapture } from './types/crawl';
import './styles.css';

const DEFAULT_CONFIG: CrawlConfig = {
  seedUrl: '', crawlScope: 'single-url', maxPages: 1, noPageLimit: false, maxDepth: 0,
  concurrency: 1, delayBetweenRequestsMs: 500, autoScroll: true,
  customContentSelector: '', excludePatterns: [], includePatterns: [],
  respectRobotsTxt: false, region: 'auto', blockCrossDomainRedirects: true
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

function formatDuration(startTime?: number, endTime?: number | null, pausedDurationMs = 0, pausedAt?: number | null) {
  if (!startTime || !endTime) return '';
  const currentPauseMs = pausedAt ? Math.max(0, endTime - pausedAt) : 0;
  const seconds = Math.max(0, Math.round((endTime - startTime - pausedDurationMs - currentPauseMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function afterNextPaint() {
  return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function PageInspector({ page, onClose, initialTab = 'overview' }: { page: CrawlPage; onClose: () => void; initialTab?: 'overview' | 'content' }) {
  const content = page.customContent;
  const comparison = page.renderComparison;
  const [tab, setTab] = useState<'overview' | 'content' | 'links' | 'code'>(initialTab);
  const [htmlCapture, setHtmlCapture] = useState<HtmlComparisonCapture | null>(null);
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [htmlComparisonRequested, setHtmlComparisonRequested] = useState(false);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const [contentCopyState, setContentCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [linkFilter, setLinkFilter] = useState<'all' | 'internal' | 'external' | 'redirects' | 'in-content' | '200' | 'errors' | 'nofollow'>('all');
  const [linkSort, setLinkSort] = useState<{ key: 'status' | 'anchor' | 'destination' | 'type' | 'content' | 'source'; direction: 'asc' | 'desc' }>({ key: 'status', direction: 'asc' });
  const h1s = page.h1List?.filter(Boolean).join(' • ') || page.h1 || '[No H1 tag found]';
  const h2s = page.h2List?.filter(Boolean).join(' • ') || '[No H2 sub-headings found]';
  const extractedContent = content?.fullText || content?.textSnippet || page.fullPageText || '';
  const contentText = extractedContent || 'No rendered text was returned.';
  const links = page.links || [];
  const contentLabel = content?.detected ? 'Content area • Active' : 'Content area';
  const filteredLinks = useMemo(() => {
    const matches = links.filter(link => {
      if (linkFilter === 'internal') return link.isInternal === true || link.linkType === 'Internal';
      if (linkFilter === 'external') return link.linkType === 'External';
      if (linkFilter === 'redirects') return (link.redirectCount || link.redirectChain?.length || 0) > 0;
      if (linkFilter === 'in-content') return Boolean(link.isInsideCustom);
      if (linkFilter === '200') return (link.statusCode ?? 0) === 200;
      if (linkFilter === 'errors') return (link.statusCode ?? 0) === 0 || (link.statusCode ?? 0) >= 400;
      if (linkFilter === 'nofollow') return Boolean(link.isNofollow);
      return true;
    });

    return [...matches].sort((left, right) => {
      const compare = (a: string | number, b: string | number) => typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      const leftValue = linkSort.key === 'status' ? (left.statusCode ?? 0)
        : linkSort.key === 'anchor' ? (left.anchorText || '')
          : linkSort.key === 'destination' ? (left.targetUrl || left.url || '')
            : linkSort.key === 'type' ? (left.linkType || '')
              : linkSort.key === 'content' ? (left.isInsideCustom ? 1 : 0)
                : (left.sourceUrl || '');
      const rightValue = linkSort.key === 'status' ? (right.statusCode ?? 0)
        : linkSort.key === 'anchor' ? (right.anchorText || '')
          : linkSort.key === 'destination' ? (right.targetUrl || right.url || '')
            : linkSort.key === 'type' ? (right.linkType || '')
              : linkSort.key === 'content' ? (right.isInsideCustom ? 1 : 0)
                : (right.sourceUrl || '');
      const result = compare(leftValue, rightValue);
      return linkSort.direction === 'asc' ? result : -result;
    });
  }, [linkFilter, linkSort, links]);
  const linkFilterOptions: Array<[typeof linkFilter, string]> = [
    ['all', 'All'], ['internal', 'Internal'], ['external', 'External'], ['redirects', 'Redirects'], ['in-content', 'In content'], ['200', '200 OK'], ['errors', 'Errors'], ['nofollow', 'Nofollow']
  ];
  useEffect(() => {
    setTab(initialTab);
    setContentCopyState('idle');
  }, [page.url, initialTab]);
  async function copyExtractedContent() {
    if (!extractedContent) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(extractedContent);
      } else {
        const temporaryField = document.createElement('textarea');
        temporaryField.value = extractedContent;
        temporaryField.style.position = 'fixed';
        temporaryField.style.opacity = '0';
        document.body.appendChild(temporaryField);
        temporaryField.select();
        const copied = document.execCommand('copy');
        temporaryField.remove();
        if (!copied) throw new Error('Clipboard access was not available.');
      }
      setContentCopyState('copied');
    } catch {
      setContentCopyState('failed');
    }
    window.setTimeout(() => setContentCopyState('idle'), 1800);
  }
  async function loadHtmlComparison() {
    setHtmlComparisonRequested(true);
    setHtmlLoading(true);
    setHtmlError(null);
    try {
      setHtmlCapture(await crawlerClient.pageHtml(page.url));
    } catch (error) {
      setHtmlError(error instanceof Error ? error.message : 'Could not capture the page HTML.');
    } finally {
      setHtmlLoading(false);
    }
  }
  function openCodeComparison() {
    setTab('code');
    if (!htmlCapture && !htmlLoading) void loadHtmlComparison();
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="inspector page-inspector" role="dialog" aria-modal="true" aria-label="Audited page details" onMouseDown={event => event.stopPropagation()}>
      <header className="page-inspector-header"><div><span className={page.statusCode === 200 ? 'code success' : 'code failure'}>{page.statusCode ?? '—'}</span><a className="page-inspector-url" href={page.url} target="_blank" rel="noreferrer">{page.url}</a></div><button className="icon-button" onClick={onClose} aria-label="Close inspection">×</button></header>
      <nav className="page-inspector-tabs" aria-label="Page inspection sections"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview &amp; SEO directives</button><button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>{contentLabel}</button><button className={tab === 'links' ? 'active' : ''} onClick={() => setTab('links')}>Discovered links ({links.length})</button><button className={tab === 'code' ? 'active' : ''} onClick={openCodeComparison}>HTML vs rendered DOM</button></nav>
      <div className="page-inspector-body">
        {tab === 'overview' && <div className="overview-grid">
          <article className="overview-card"><span>Page title (&lt;title&gt;)</span><strong>{page.title || '[No title tag found]'}</strong></article>
          <article className="overview-card"><span>Meta description</span><strong>{page.metaDescription || '[No meta description found]'}</strong></article>
          <article className="overview-card"><span>Meta keywords</span><strong>{page.metaKeywords || '[No meta keywords found]'}</strong></article>
          <article className="overview-card"><span>Canonical URL</span><a href={page.canonical || page.url} target="_blank" rel="noreferrer">{page.canonical || '[No canonical URL found]'}</a></article>
          <article className="overview-card"><span>Meta robots directive</span><strong className="monospace">{page.metaRobots || '[No robots directive found]'}</strong></article>
          <article className="overview-card"><span>H1 heading(s)</span><strong>{h1s}</strong></article>
          <article className="overview-card"><span>H2 sub-headings</span><strong>{h2s}</strong></article>
          <article className="overview-card compact"><span>Word &amp; asset count</span><strong>{(page.totalWords ?? page.wordCount ?? 0).toLocaleString()} words • {page.imagesCount ?? 0} images</strong></article>
          <article className="overview-card compact"><span>Response time</span><strong className="accent">{(page.responseTimeMs ?? page.responseTime) ? `${page.responseTimeMs ?? page.responseTime} ms` : '—'}</strong></article>
          <article className="overview-card comparison-card"><span>Source HTML vs rendered DOM</span>{comparison?.available ? <><strong className={comparison.domChanged ? 'comparison-changed' : ''}>{comparison.domChanged ? 'DOM changed after rendering' : 'No meaningful DOM change detected'}</strong><small>{formatBytes(comparison.sourceHtmlBytes)} → {formatBytes(comparison.renderedHtmlBytes)} • {comparison.sourceWordCount?.toLocaleString() || 0} → {comparison.renderedWordCount?.toLocaleString() || 0} words • {comparison.renderedOnlyWordCount?.toLocaleString() || 0} rendered-only words</small></> : <strong>{comparison?.reason || 'This page has not been compared yet.'}</strong>}<button className="secondary comparison-open" onClick={openCodeComparison}>View actual HTML</button></article>
        </div>}
        {tab === 'content' && <section className="content-inspection"><div className="content-inspection-summary"><span className={content?.detected ? 'tag positive' : 'tag neutral'}>{content?.detected ? 'Content area detected' : 'Content area not detected'}</span><span>{content?.selectorUsed || 'No selector matched'}</span><span>{content?.wordCount?.toLocaleString() || page.totalWords?.toLocaleString() || 0} words</span><button className="secondary copy-content-button" onClick={() => void copyExtractedContent()} disabled={!extractedContent}>{contentCopyState === 'copied' ? '✓ Copied' : contentCopyState === 'failed' ? 'Copy failed' : 'Copy all content'}</button></div><div className="content-inspection-grid"><article><span>Extracted sub-headings</span><p>{[...new Set([...(content?.headings || []), ...(page.h2List || [])])].join(' • ') || '[No sub-headings found]'}</p></article><article><span>Extracted rendered content</span><pre>{contentText}</pre></article></div></section>}
        {tab === 'links' && <section className="inspection-links"><div className="link-detail-toolbar"><div className="link-detail-filter-group" aria-label="Filter discovered links">{linkFilterOptions.map(([value, label]) => <button key={value} type="button" className={linkFilter === value ? 'pill active' : 'pill'} onClick={() => setLinkFilter(value)}>{label}</button>)}</div><label className="link-detail-sort">Sort<select value={linkSort.key} onChange={event => setLinkSort(current => ({ ...current, key: event.target.value as typeof current.key }))}><option value="status">Status</option><option value="anchor">Anchor text</option><option value="destination">Destination</option><option value="type">Type</option><option value="content">Content area</option><option value="source">Source page</option></select><button type="button" className="sort-button" onClick={() => setLinkSort(current => ({ ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' }))}>{linkSort.direction === 'asc' ? 'Ascending' : 'Descending'}</button></label></div><div className="table-wrap"><table><thead><tr><th>Status</th><th>Anchor text</th><th>Destination URL</th><th>Type</th><th>In content area</th></tr></thead><tbody>{filteredLinks.length ? filteredLinks.map((link, index) => <tr key={`${link.url || link.targetUrl}-${index}`}><td><span className={link.statusCode === 200 ? 'code success' : (link.statusCode || 0) >= 400 ? 'code failure' : 'code neutral'}>{link.statusCode ?? '—'}</span></td><td>{link.anchorText || '[No text]'}</td><td className="url">{link.url || link.targetUrl || link.rawHref || '—'}</td><td>{link.linkType || 'Unknown'}</td><td>{link.isInsideCustom ? 'Yes' : 'No'}</td></tr>) : <tr><td colSpan={5} className="empty">No links match the current filter.</td></tr>}</tbody></table></div></section>}
        {tab === 'code' && <section className="html-comparison"><p>The source and rendered DOM are captured when you open this tab. They are not stored in the crawl database.</p>{(htmlLoading || (!htmlCapture && htmlComparisonRequested && !htmlError)) && <div className="comparison-loading" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><div><strong>Preparing comparison</strong><p>Capturing the source HTML and browser-rendered DOM…</p></div></div>}{htmlError && <div className="comparison-error"><p>{htmlError}</p><button className="secondary" onClick={() => void loadHtmlComparison()}>Try again</button></div>}{htmlCapture && <><div className="html-comparison-summary"><span className={htmlCapture.comparison.available && htmlCapture.comparison.domChanged ? 'tag positive' : 'tag neutral'}>{htmlCapture.comparison.available ? (htmlCapture.comparison.domChanged ? 'DOM changed after rendering' : 'No meaningful DOM change detected') : 'Comparison unavailable'}</span><small>Captured {new Date(htmlCapture.capturedAt).toLocaleString()}</small></div><div className="html-code-grid"><article><header><div><strong>Original source HTML</strong><small>{htmlCapture.source.url}</small></div><span>{formatBytes(htmlCapture.source.totalBytes)}{htmlCapture.source.truncated ? ' • preview truncated at 2 MB' : ''}</span></header><pre>{htmlCapture.source.html || '[Source HTML could not be retrieved.]'}</pre></article><article><header><div><strong>Rendered DOM</strong><small>{htmlCapture.rendered.url}</small></div><span>{formatBytes(htmlCapture.rendered.totalBytes)}{htmlCapture.rendered.truncated ? ' • preview truncated at 2 MB' : ''}</span></header>{htmlCapture.rendered.error ? <p className="comparison-error">{htmlCapture.rendered.error}</p> : <pre>{htmlCapture.rendered.html || '[Rendered DOM could not be retrieved.]'}</pre>}</article></div></>}</section>}
      </div>
    </section>
  </div>;
}

export default function App() {
  const crawler = useCrawler();
  const [isAdministrator, setIsAdministrator] = useState(false);
  const [config, setConfig] = useState<CrawlConfig>(DEFAULT_CONFIG);
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedPage, setSelectedPage] = useState<CrawlPage | null>(null);
  const [selectedPageTab, setSelectedPageTab] = useState<'overview' | 'content'>('overview');
  const [exportOpen, setExportOpen] = useState(false);
  const [explorerView, setExplorerView] = useState<'pages' | 'links' | 'resources' | 'issues' | 'history' | 'comparison'>('pages');
  const [crawlComparison, setCrawlComparison] = useState<CrawlComparison | null>(null);
  const [comparingHistory, setComparingHistory] = useState(false);
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  const [restoringAudit, setRestoringAudit] = useState<{ pageCount: number; expectedPages: number | null; stage: 'restoring' | 'rendering' } | null>(null);
  const [commandPending, setCommandPending] = useState<'start' | 'pause' | 'resume' | 'stop' | 'reset' | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [elapsedClock, setElapsedClock] = useState(() => Date.now());
  const completionNotificationEligible = useRef(false);
  const notifiedCompletion = useRef<number | null>(null);
  const running = crawler.state === 'running' || crawler.state === 'paused' || crawler.state === 'stopping';
  const maxWorkers = crawler.capacity?.maxWorkersPerCrawl || 1;
  const unlimitedSafetyCap = crawler.capacity?.maxUnlimitedCrawlPages || 50000;
  const availableCrawlSlots = crawler.capacity?.availableSlots;
  const crawlSlotLabel = availableCrawlSlots === undefined
    ? 'Checking crawl capacity…'
    : `${availableCrawlSlots} crawl slot${availableCrawlSlots === 1 ? '' : 's'} free`;
  const crawlElapsed = crawler.stats.startTime
    ? formatDuration(
      crawler.stats.startTime,
      crawler.state === 'completed' ? crawler.stats.endTime : elapsedClock,
      crawler.stats.pausedDurationMs,
      crawler.stats.pausedAt
    )
    : crawler.state === 'running' ? 'Starting…' : '—';
  const auditedPageCount = crawler.historyAudit?.totalPages ?? crawler.pages.length;
  const discoveredLinkCount = crawler.historyAudit
    ? (crawler.stats.internalLinksCount || 0) + (crawler.stats.externalLinksCount || 0)
    : crawler.links.length;
  useEffect(() => {
    let active = true;
    void fetch('/api/admin/session', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then((session: { administrator?: boolean } | null) => {
        if (active) setIsAdministrator(session?.administrator === true);
      })
      .catch(() => { if (active) setIsAdministrator(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (crawler.state === 'paused' && crawler.stats.pausedAt) {
      setElapsedClock(crawler.stats.pausedAt);
      return;
    }
    if (crawler.state !== 'running') return;
    setElapsedClock(Date.now());
    const timer = window.setInterval(() => setElapsedClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [crawler.state, crawler.stats.pausedAt]);
  useEffect(() => {
    const completedAt = crawler.stats.endTime;
    const pageCount = crawler.stats.pagesCrawled || 0;
    if (!completionNotificationEligible.current || crawler.state !== 'completed' || pageCount < 50 || !completedAt || notifiedCompletion.current === completedAt) return;
    notifiedCompletion.current = completedAt;
    completionNotificationEligible.current = false;
    const duration = formatDuration(
      crawler.stats.startTime,
      completedAt,
      crawler.stats.pausedDurationMs,
      crawler.stats.pausedAt
    );
    const message = `Audit complete: ${pageCount.toLocaleString()} pages${duration ? ` in ${duration}` : ''}.`;
    setCompletionNotice(message);
    if ('Notification' in window && window.Notification.permission === 'granted') {
      new window.Notification('CrawlLoom audit complete', { body: message, tag: `crawlloom-audit-${completedAt}` });
    }
  }, [crawler.state, crawler.stats.endTime, crawler.stats.pagesCrawled, crawler.stats.startTime]);
  useEffect(() => {
    if (!completionNotice) return;
    const timeout = window.setTimeout(() => setCompletionNotice(null), 12000);
    return () => window.clearTimeout(timeout);
  }, [completionNotice]);
  useEffect(() => {
    if (!restoringAudit || restoringAudit.stage !== 'rendering' || restoringAudit.expectedPages === null || crawler.pages.length < restoringAudit.expectedPages) return;
    let active = true;
    void afterNextPaint().then(() => { if (active) setRestoringAudit(null); });
    return () => { active = false; };
  }, [crawler.pages.length, restoringAudit]);
  const contentPages = crawler.pages.filter(contentFound).length;
  const liveResourceCount = useMemo(() => crawler.pages.reduce((count, page) => count + (page.resources?.length || 0), 0), [crawler.pages]);
  const resourceCount = crawler.historyAudit?.totalResources ?? liveResourceCount;
  // Exact-duplicate analysis normalises every extracted page text. Defer that
  // expensive work until the Issues view is requested, so a large saved audit
  // can show its Pages view immediately after it is restored.
  const seoIssues = useMemo(() => explorerView === 'issues' ? getSeoIssues(crawler.pages, crawler.links) : [], [explorerView, crawler.pages, crawler.links]);
  const issueCount = seoIssues.length;
  const errors = (crawler.stats.errorsCount || 0) + (crawler.stats.blockedByRobotsCount || 0);
  const primaryAction = crawler.state === 'running'
    ? { label: 'Ⅱ Pause crawl', action: 'pause' as const }
    : crawler.state === 'paused'
      ? { label: '▶ Resume crawl', action: 'resume' as const }
      : crawler.historyAudit
        ? { label: '▶ Resume saved crawl', action: 'resumeHistory' as const }
        : { label: '▶ Execute crawl', action: 'start' as const };

  function update<K extends keyof CrawlConfig>(key: K, value: CrawlConfig[K]) {
    setConfig(current => ({ ...current, [key]: value }));
  }
  function setScope(scope: CrawlScope) {
    const single = scope === 'single-url';
    setConfig(current => ({
      ...current,
      crawlScope: scope,
      // The dashboard begins in single-URL mode (1 page). Restore the established
      // 50-page default the first time the user changes to a broader scope.
      maxPages: single ? 1 : (current.crawlScope === 'single-url' ? 50 : Math.max(2, current.maxPages)),
      noPageLimit: single ? false : current.noPageLimit,
      // Keep a single-page audit at depth 0, but restore the established default
      // of three link levels when entering a multi-page crawl scope.
      maxDepth: single ? 0 : (current.crawlScope === 'single-url' ? 3 : Math.max(1, current.maxDepth))
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    completionNotificationEligible.current = true;
    if ((config.noPageLimit || config.maxPages >= 50) && 'Notification' in window && window.Notification.permission === 'default') {
      void window.Notification.requestPermission();
    }
    setCommandPending('start');
    try { await crawler.run('start', config); }
    finally { setCommandPending(null); }
  }
  async function runCommand(action: 'pause' | 'resume' | 'stop' | 'reset' | 'resumeHistory') {
    if (action === 'resumeHistory') {
      if (!crawler.historyAudit?.crawlId) return;
      setCommandPending('resume');
      try {
        await crawler.resumeHistory(crawler.historyAudit.crawlId);
        setExplorerView('pages');
      } finally {
        setCommandPending(null);
      }
      return;
    }
    setCommandPending(action);
    try { await crawler.run(action); }
    finally { setCommandPending(null); }
  }
  async function signOut() {
    setSigningOut(true);
    try {
      await crawlerClient.logout();
    } finally {
      window.location.assign('/admin/login');
    }
  }

  return <div className="app-shell">
    <header className="topbar"><div><span className="brand-mark">⌘</span><span className="brand">CrawlLoom <small>Browser-rendered SEO crawler</small></span></div><div className="topbar-status"><a className="docs-link" href="/">Home</a>{isAdministrator && <a className="docs-link" href="/admin">Administration</a>}<a className="docs-link" href="/docs" target="_blank" rel="noopener noreferrer" aria-label="Documentation (opens in a new tab)">Documentation</a><button className="topbar-action" type="button" onClick={() => void signOut()} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button><span className="crawl-capacity">{crawlSlotLabel}</span><span className={`status ${crawler.state}`}><i />{statusLabel(crawler.state, crawler.engine?.mode)}</span></div></header>
    <main>
      <section className="card config-card">
        <div className="section-heading"><div><p className="eyebrow">Crawl target</p><h1>Start a browser-rendered audit</h1></div><button className="secondary" type="button" onClick={() => setAdvanced(open => !open)}>{advanced ? 'Hide advanced' : 'Advanced directives'}</button></div>
        <form onSubmit={submit}>
          <div className="core-fields">
            <label className="wide">Target address<input required value={config.seedUrl} onChange={event => update('seedUrl', event.target.value)} placeholder="graduateshub.org or https://www.example.com/section/" disabled={running} /></label>
            <label>Scope<select value={config.crawlScope} onChange={event => setScope(event.target.value as CrawlScope)} disabled={running}><option value="single-url">Single URL audit</option><option value="domain">Exact hostname</option><option value="subpath">Subfolder / path only</option><option value="subdomains">Domain & subdomains</option></select></label>
            <label>Page limit<input type="number" min="1" max={unlimitedSafetyCap} required={!config.noPageLimit} value={config.maxPages || ''} disabled={running || config.crawlScope === 'single-url' || config.noPageLimit} onChange={event => update('maxPages', event.target.value === '' ? 0 : numberValue(event.target.value, 1))} /></label>
            <label className="check page-limit-toggle" title={`Crawls until the queue is empty, up to the server safety cap of ${unlimitedSafetyCap.toLocaleString()} pages.`}><input type="checkbox" checked={config.noPageLimit} disabled={running || config.crawlScope === 'single-url'} onChange={event => update('noPageLimit', event.target.checked)} /> No page limit</label>
          </div>
          {advanced && <div className="advanced-grid">
            <label>Max crawl depth<input type="number" min="0" max="20" value={config.maxDepth} disabled={running || config.crawlScope === 'single-url'} onChange={event => update('maxDepth', numberValue(event.target.value, 0))} /></label>
            <label>Worker threads<input type="number" min="1" max={maxWorkers} value={config.concurrency} disabled={running} onChange={event => update('concurrency', Math.min(maxWorkers, numberValue(event.target.value, 1)))} /></label>
            <label>Rate limiter (ms)<input type="number" min="0" max="5000" step="50" value={config.delayBetweenRequestsMs} disabled={running} onChange={event => update('delayBetweenRequestsMs', numberValue(event.target.value, 500))} /></label>
            <label className="check"><input type="checkbox" checked={config.autoScroll} disabled={running} onChange={event => update('autoScroll', event.target.checked)} /> Dynamic auto-scroll</label>
            <label className="wide-advanced">Custom content selector<input value={config.customContentSelector} disabled={running} onChange={event => update('customContentSelector', event.target.value)} placeholder="Auto-detect, or e.g. .page-text" /></label>
            <label>Region<select value={config.region} disabled={running} onChange={event => update('region', event.target.value)}><option value="auto">Auto-detect from TLD</option><option value="ZA">South Africa</option><option value="GH">Ghana</option><option value="KE">Kenya</option><option value="NG">Nigeria</option><option value="GB">United Kingdom</option><option value="US">United States</option></select></label>
            <label className="wide-advanced">Disallow paths or regex<textarea rows={3} value={config.excludePatterns.join('\n')} disabled={running} onChange={event => update('excludePatterns', event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} placeholder={'/checkout\n/account\n.*\\.pdf$'} /></label>
            <label className="wide-advanced">Allow only paths or regex<textarea rows={3} value={config.includePatterns.join('\n')} disabled={running} onChange={event => update('includePatterns', event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} placeholder={'/sports/\n/casino/'} /></label>
            <label className="check"><input type="checkbox" checked={config.blockCrossDomainRedirects} disabled={running} onChange={event => update('blockCrossDomainRedirects', event.target.checked)} /> Lock target domain (block geo redirects)</label>
            <label className="check"><input type="checkbox" checked={config.respectRobotsTxt} disabled={running} onChange={event => update('respectRobotsTxt', event.target.checked)} /> Enforce robots.txt</label>
          </div>}
          <div className="actions"><button className="primary" type={primaryAction.action === 'start' ? 'submit' : 'button'} disabled={crawler.state === 'stopping' || Boolean(commandPending)} onClick={primaryAction.action === 'start' ? undefined : () => void runCommand(primaryAction.action)}>{commandPending === 'start' ? 'Starting…' : commandPending === 'pause' ? 'Pausing…' : commandPending === 'resume' ? 'Resuming…' : primaryAction.label}</button><button className="danger" type="button" disabled={!running || crawler.state === 'stopping' || Boolean(commandPending)} onClick={() => { completionNotificationEligible.current = false; void runCommand('stop'); }}>{commandPending === 'stop' ? '■ Stopping…' : '■ Abort'}</button><button className="secondary" type="button" disabled={Boolean(commandPending)} onClick={() => { completionNotificationEligible.current = false; void runCommand('reset'); }}>{commandPending === 'reset' ? '↻ Clearing…' : '↻ Clear / reset'}</button></div>
        </form>
        {crawler.error && <p className="error-message" role="alert">{crawler.error}</p>}
      </section>
      <section className="stat-grid" aria-label="Crawl summary">
        <Stat label="Pages audited" value={crawler.stats.pagesCrawled} detail={config.noPageLimit ? `Until queue empty • ${unlimitedSafetyCap.toLocaleString()} safety cap` : `${Math.min(100, Math.round((crawler.stats.pagesCrawled / Math.max(1, config.maxPages)) * 100))}% of limit`} />
        <Stat label="Pending queue" value={crawler.queueLength} detail={crawler.queueLength ? 'URLs waiting to be audited' : 'No URLs waiting'} />
        <Stat label="Discovered links" value={(crawler.stats.internalLinksCount || 0) + (crawler.stats.externalLinksCount || 0)} detail={`${crawler.stats.externalLinksCount || 0} external`} />
        <Stat label="Content area coverage" value={`${auditedPageCount ? Math.round(((crawler.stats.customDetectedCount ?? contentPages) / auditedPageCount) * 100) : 0}%`} detail={`${(crawler.stats.customDetectedCount ?? contentPages).toLocaleString()} pages verified`} />
        <Stat label="Errors & exclusions" value={errors} detail={crawler.engine?.mode === 'http' ? 'Direct DOM engine' : 'Browser-rendered crawl'} />
        <Stat label="Elapsed time" value={crawlElapsed} detail={crawler.state === 'paused' ? 'Paused — active time frozen' : running ? 'Live crawl duration' : crawler.state === 'completed' ? 'Final crawl duration' : 'Starts when the crawl begins'} />
      </section>
      <section className="card explorer">
        <div className="explorer-head"><div><p className="eyebrow">{explorerView === 'pages' ? 'Audited pages' : explorerView === 'links' ? 'Discovered links & anchors' : explorerView === 'resources' ? 'Resources & assets' : explorerView === 'issues' ? 'SEO issues' : explorerView === 'comparison' ? 'Crawl comparison' : 'Saved crawl history'}</p><h2>{explorerView === 'pages' ? `${auditedPageCount.toLocaleString()} page${auditedPageCount === 1 ? '' : 's'} collected` : explorerView === 'links' ? `${crawler.links.length.toLocaleString()} link${crawler.links.length === 1 ? '' : 's'} collected` : explorerView === 'resources' ? 'Embedded resource inventory' : explorerView === 'issues' ? `${issueCount.toLocaleString()} issue${issueCount === 1 ? '' : 's'} identified` : explorerView === 'comparison' ? `${crawlComparison?.rows.length.toLocaleString() || 0} changes identified` : 'Crawls retained in MySQL'}</h2></div><div className="export-wrap"><button className="secondary" onClick={() => setExportOpen(open => !open)}>Export ▾</button>{exportOpen && <div className="export-menu">{[
          ['Excel workbook (.xlsx)', '/api/export/workbook.xlsx'], ['Pages CSV', '/api/export/pages.csv'], ['All links CSV', '/api/export/links.csv'], ['Resources CSV', '/api/export/resources.csv'], ['Images CSV', '/api/export/images.csv'], ['SEO issues CSV', '/api/export/issues.csv'], ['Content area CSV', '/api/export/custom-content.csv']
        ].map(([label, path]) => <a key={path} href={crawlerClient.exportUrl(path)}>{label}</a>)}</div>}</div></div>
        <nav className="explorer-tabs" aria-label="Dashboard data views"><button className={explorerView === 'pages' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('pages')}>Pages <span>{auditedPageCount}</span></button><button className={explorerView === 'links' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('links')}>Discovered links & anchors <span>{discoveredLinkCount}</span></button><button className={explorerView === 'resources' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('resources')}>Resources & assets <span>{resourceCount}</span></button><button className={explorerView === 'issues' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('issues')}>SEO issues <span>{explorerView === 'issues' ? issueCount : '…'}</span></button>{crawlComparison && <button className={explorerView === 'comparison' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('comparison')}>Comparison <span>{crawlComparison.rows.length}</span></button>}<button className={explorerView === 'history' ? 'explorer-tab active' : 'explorer-tab'} onClick={() => setExplorerView('history')}>History</button></nav>
        {explorerView !== 'history' && explorerView !== 'comparison' && <div className="toolbar"><input value={search} onChange={event => setSearch(event.target.value)} placeholder={explorerView === 'pages' ? 'Search URLs, titles, descriptions or status codes…' : explorerView === 'links' ? 'Search anchor text, URLs or status codes…' : explorerView === 'resources' ? 'Search resource URLs, types, source pages or status…' : 'Search issue names, URLs, details or severity…'} /></div>}
        {explorerView === 'pages' ? crawler.historyAudit ? <SavedAuditPagesExplorer crawlId={crawler.historyAudit.crawlId} sharedSearch={search} onInspectPage={async (page, section) => { const detail = await crawlerClient.historyPage(crawler.historyAudit!.crawlId, page.url); setSelectedPageTab(section); setSelectedPage(detail.page); }} /> : <PagesExplorer pages={crawler.pages} sharedSearch={search} onInspectPage={(page, section) => { setSelectedPageTab(section); setSelectedPage(page); }} /> : explorerView === 'links' ? crawler.historyAudit ? <SavedAuditLinksExplorer crawlId={crawler.historyAudit.crawlId} sharedSearch={search} /> : <LinksExplorer links={crawler.links} sharedSearch={search} /> : explorerView === 'resources' ? crawler.historyAudit ? <SavedAuditResourcesExplorer crawlId={crawler.historyAudit.crawlId} sharedSearch={search} /> : <ResourcesExplorer pages={crawler.pages} sharedSearch={search} /> : explorerView === 'issues' ? <IssuesExplorer issues={seoIssues} sharedSearch={search} onInspectPage={url => { const target = crawler.pages.find(page => page.url === url); if (target) { setSelectedPageTab('overview'); setSelectedPage(target); } }} /> : explorerView === 'comparison' && crawlComparison ? <ComparisonExplorer comparison={crawlComparison} onBack={() => setExplorerView('history')} /> : <HistoryExplorer onRestore={async (record: CrawlHistoryRecord) => { setRestoringAudit({ pageCount: record.stats?.pagesCrawled || 0, expectedPages: null, stage: 'restoring' }); try { const restored = await crawler.restoreHistory(record.id); setConfig(current => ({ ...current, ...(restored.crawl.config || {}), seedUrl: restored.crawl.seedUrl })); setExplorerView('pages'); setRestoringAudit({ pageCount: restored.restoredPages, expectedPages: restored.loadedPages, stage: 'rendering' }); } catch (error) { setRestoringAudit(null); throw error; } }} onResume={async record => { await crawler.resumeHistory(record.id); setExplorerView('pages'); }} onCompare={async (previous, current) => { setComparingHistory(true); try { const result = await crawlerClient.compareHistory(previous.id, current.id); setCrawlComparison(result); setExplorerView('comparison'); } finally { setComparingHistory(false); } }} />}
      </section>
    </main>
    {completionNotice && <div className="completion-notice" role="status"><strong>✓ Crawl finished</strong><span>{completionNotice}</span><button className="icon-button" onClick={() => setCompletionNotice(null)} aria-label="Dismiss crawl completion notification">×</button></div>}
    {restoringAudit && <div className="audit-restore-overlay" role="status" aria-live="polite"><div><span className="loading-spinner" aria-hidden="true" /><strong>{restoringAudit.stage === 'restoring' ? 'Loading saved audit' : 'Preparing your audit for display'}</strong><p>{restoringAudit.stage === 'restoring' ? `Preparing ${restoringAudit.pageCount.toLocaleString()} saved pages for windowed loading…` : `Showing the first ${restoringAudit.expectedPages?.toLocaleString() || 0} of ${restoringAudit.pageCount.toLocaleString()} pages. Further pages load as you navigate.`}</p></div></div>}
    {comparingHistory && <div className="audit-restore-overlay" role="status" aria-live="polite"><div><span className="loading-spinner" aria-hidden="true" /><strong>Comparing saved crawls</strong><p>Reading the saved page data and identifying new, missing and changed URLs…</p></div></div>}
    {selectedPage && <PageInspector page={selectedPage} initialTab={selectedPageTab} onClose={() => setSelectedPage(null)} />}
  </div>;
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="stat"><span>{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong><small>{detail}</small></article>;
}
