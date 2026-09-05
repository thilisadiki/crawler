// @ts-check
// Browser-safe shared rules: no DOM, database, Node, or exporter dependencies.
/**
 * @typedef {import('../client/types/crawl').CrawlPage} CrawlPage
 * @typedef {import('../client/types/crawl').CrawledLink} CrawledLink
 * @typedef {'Critical' | 'Warning' | 'Opportunity'} Severity
 * @typedef {{code: string, severity: Severity, label: string, description: string, url: string, detail: string}} SeoIssue
 * @typedef {{code: string, severity: Severity, label: string, description: string, items: Array<{url: string, detail: string}>}} IssueGroup
 */

/**
 * Evaluate one audit for both the dashboard and CSV/XLSX exports.
 * @param {CrawlPage[]} results
 * @param {CrawledLink[]} allLinks
 * @returns {SeoIssue[]}
 */
export function getSeoIssues(results = [], allLinks = []) {
  /** @type {Array<[string, Severity, string, string]>} */
  const definitions = [
    ['page-error', 'Critical', 'Crawl error', 'The page returned an error or could not be crawled.'],
    ['broken-internal-link', 'Critical', 'Broken internal link', 'An internal link points to a page that failed.'],
    ['redirected-internal-link', 'Opportunity', 'Redirected internal link', 'An internal link redirects before reaching its final destination.'],
    ['missing-title', 'Warning', 'Missing page title', 'Search results need a descriptive title.'],
    ['duplicate-title', 'Warning', 'Duplicate page title', 'Multiple pages use the same title.'],
    ['title-too-short', 'Opportunity', 'Title is too short', 'Title is under 30 characters.'],
    ['title-too-long', 'Opportunity', 'Title is too long', 'Title is over 60 characters.'],
    ['missing-description', 'Warning', 'Missing meta description', 'The page has no meta description.'],
    ['duplicate-description', 'Warning', 'Duplicate meta description', 'Multiple pages use the same meta description.'],
    ['duplicate-content', 'Warning', 'Exact duplicate content', 'Multiple pages have identical extracted text after whitespace and case normalisation.'],
    ['description-too-short', 'Opportunity', 'Meta description is too short', 'Description is under 70 characters.'],
    ['description-too-long', 'Opportunity', 'Meta description is too long', 'Description is over 160 characters.'],
    ['missing-h1', 'Warning', 'Missing H1', 'The page has no H1 heading.'],
    ['multiple-h1', 'Opportunity', 'Multiple H1 headings', 'The page has more than one H1.'],
    ['missing-canonical', 'Opportunity', 'Missing canonical', 'No canonical URL was found.'],
    ['canonical-mismatch', 'Warning', 'Canonical points elsewhere', 'The canonical URL differs from the crawled page.'],
    ['noindex', 'Opportunity', 'Noindex directive', 'The page asks search engines not to index it.'],
    ['thin-content', 'Opportunity', 'Thin content', 'The page has fewer than 300 extracted words.']
  ];
  /** @type {Map<string, IssueGroup>} */
  const groups = new Map(definitions.map(([code, severity, label, description]) => [code, { code, severity, label, description, items: [] }]));
  /** @param {string} code @param {Pick<CrawlPage, 'url'>} page @param {string} detail */
  const add = (code, page, detail) => groups.get(code)?.items.push({ url: page.url, detail });
  /** @type {Map<string, CrawlPage[]>} */
  const titleMap = new Map();
  /** @type {Map<string, CrawlPage[]>} */
  const descriptionMap = new Map();
  /** @type {Map<string, Array<{page: CrawlPage, normalized: string, wordCount: number, source: string}>>} */
  const contentMap = new Map();

  for (const page of results) {
    if ((page.statusCode || 0) >= 400 || page.error) add('page-error', page, page.error || `Returned HTTP ${page.statusCode}.`);
    if (page.statusCode !== 200) continue;

    const title = (page.title || '').trim();
    if (!title) add('missing-title', page, 'No title tag was extracted.');
    else {
      if (title.length < 30) add('title-too-short', page, `${title.length} characters: “${title}”`);
      if (title.length > 60) add('title-too-long', page, `${title.length} characters: “${title.slice(0, 100)}”`);
      const matchingTitles = titleMap.get(title.toLowerCase()) || [];
      matchingTitles.push(page);
      titleMap.set(title.toLowerCase(), matchingTitles);
    }

    const description = (page.metaDescription || '').trim();
    if (!description) add('missing-description', page, 'No meta description was extracted.');
    else {
      if (description.length < 70) add('description-too-short', page, `${description.length} characters: “${description.slice(0, 120)}”`);
      if (description.length > 160) add('description-too-long', page, `${description.length} characters: “${description.slice(0, 120)}…”`);
      const matchingDescriptions = descriptionMap.get(description.toLowerCase()) || [];
      matchingDescriptions.push(page);
      descriptionMap.set(description.toLowerCase(), matchingDescriptions);
    }

    const h1s = Array.isArray(page.h1List) ? page.h1List.filter(Boolean) : (page.h1 ? [page.h1] : []);
    if (!h1s.length) add('missing-h1', page, 'No H1 was extracted.');
    else if (h1s.length > 1) add('multiple-h1', page, `${h1s.length} H1 headings: ${h1s.slice(0, 3).join(' • ')}`);

    const canonical = (page.canonical || '').trim();
    if (!canonical) add('missing-canonical', page, 'No canonical URL was extracted.');
    else if (comparableUrl(canonical) !== comparableUrl(page.url)) add('canonical-mismatch', page, `Canonical: ${canonical}`);

    if (/\bnoindex\b/i.test(page.metaRobots || '')) add('noindex', page, `Robots directive: ${page.metaRobots}`);
    const contentWords = page.customContent?.wordCount || page.totalWords || 0;
    if (contentWords < 300) add('thin-content', page, `${contentWords.toLocaleString()} extracted words.`);

    const contentCandidate = getExactContentCandidate(page);
    if (contentCandidate) {
      const matchingPages = contentMap.get(`${contentCandidate.source}|${contentCandidate.normalized}`) || [];
      matchingPages.push({ page, ...contentCandidate });
      contentMap.set(`${contentCandidate.source}|${contentCandidate.normalized}`, matchingPages);
    }
  }

  for (const pages of titleMap.values()) {
    if (pages.length > 1) pages.forEach(page => add('duplicate-title', page, `Shared by ${pages.length} pages: “${page.title}”`));
  }
  for (const pages of descriptionMap.values()) {
    if (pages.length > 1) pages.forEach(page => add('duplicate-description', page, `Shared by ${pages.length} pages: “${(page.metaDescription || '').slice(0, 120)}”`));
  }
  for (const pages of contentMap.values()) {
    if (pages.length > 1) pages.forEach(({ page, wordCount, source }) => {
      add('duplicate-content', page, `Exact ${source} match shared by ${pages.length} pages (${wordCount.toLocaleString()} words).`);
    });
  }
  for (const link of allLinks) {
    if ((link?.linkType === 'Internal' || link?.isInternal === true) && (link.statusCode === 0 || (link.statusCode || 0) >= 400)) {
      add('broken-internal-link', { url: link.sourceUrl || 'Unknown source page' }, `${link.targetUrl || link.url || link.rawHref || 'Unknown target'} returned ${link.statusCode || 'no response'}.`);
    }
    if ((link?.linkType === 'Internal' || link?.isInternal === true) && (link.redirectCount || link.redirectChain?.length)) {
      const hops = link.redirectCount || link.redirectChain?.length || 0;
      add('redirected-internal-link', { url: link.sourceUrl || 'Unknown source page' }, `${link.targetUrl || link.url || link.rawHref || 'Unknown target'} redirects in ${hops} hop${hops === 1 ? '' : 's'} to ${link.finalUrl || 'an unknown destination'}.`);
    }
  }

  return [...groups.values()].flatMap(group => group.items.map(item => ({
    ...item,
    code: group.code,
    severity: group.severity,
    label: group.label,
    description: group.description
  })));
}

/** @param {string} value */
export function comparableUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(value || '').trim().replace(/\/$/, '').toLowerCase();
  }
}

/** @param {CrawlPage} page */
export function getExactContentCandidate(page) {
  const contentAreaText = (page.customContent?.fullText || page.customContent?.textSnippet || '').trim();
  const source = contentAreaText ? 'content area' : 'full page';
  const text = contentAreaText || (page.fullPageText || '');
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const wordCount = normalized ? normalized.split(' ').length : 0;
  return wordCount >= 100 ? { normalized, wordCount, source } : null;
}
