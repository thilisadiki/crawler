import type { CrawlPage, CrawledLink } from '../../types/crawl';

export type Severity = 'Critical' | 'Warning' | 'Opportunity';
export interface SeoIssue { code: string; severity: Severity; label: string; description: string; url: string; detail: string; }
interface IssueGroup { code: string; severity: Severity; label: string; description: string; items: Array<{ url: string; detail: string }>; }

const DEFINITIONS: Array<[string, Severity, string, string]> = [
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

function comparableUrl(value: string) {
  try { const parsed = new URL(value); parsed.hash = ''; if (parsed.pathname === '/') parsed.pathname = ''; return parsed.toString().replace(/\/$/, '').toLowerCase(); }
  catch { return String(value || '').trim().replace(/\/$/, '').toLowerCase(); }
}
function duplicateContentCandidate(page: CrawlPage) {
  const content = (page.customContent?.fullText || page.customContent?.textSnippet || '').trim();
  const source = content ? 'content area' : 'full page';
  const normalized = (content || page.fullPageText || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const wordCount = normalized ? normalized.split(' ').length : 0;
  return wordCount >= 100 ? { normalized, wordCount, source } : null;
}
function internal(link: CrawledLink) { return link.isInternal === true || link.linkType === 'Internal'; }

export function getSeoIssues(pages: CrawlPage[], links: CrawledLink[]): SeoIssue[] {
  const groups = new Map<string, IssueGroup>(DEFINITIONS.map(([code, severity, label, description]) => [code, { code, severity, label, description, items: [] }]));
  const add = (code: string, page: Pick<CrawlPage, 'url'>, detail: string) => groups.get(code)?.items.push({ url: page.url, detail });
  const titles = new Map<string, CrawlPage[]>(); const descriptions = new Map<string, CrawlPage[]>();
  const content = new Map<string, Array<{ page: CrawlPage; wordCount: number; source: string }>>();
  for (const page of pages) {
    if ((page.statusCode || 0) >= 400 || page.error) add('page-error', page, page.error || `Returned HTTP ${page.statusCode}.`);
    if (page.statusCode !== 200) continue;
    const title = (page.title || '').trim();
    if (!title) add('missing-title', page, 'No title tag was extracted.');
    else { if (title.length < 30) add('title-too-short', page, `${title.length} characters: “${title}”`); if (title.length > 60) add('title-too-long', page, `${title.length} characters: “${title.slice(0, 100)}”`); titles.set(title.toLowerCase(), [...(titles.get(title.toLowerCase()) || []), page]); }
    const description = (page.metaDescription || '').trim();
    if (!description) add('missing-description', page, 'No meta description was extracted.');
    else { if (description.length < 70) add('description-too-short', page, `${description.length} characters: “${description.slice(0, 120)}”`); if (description.length > 160) add('description-too-long', page, `${description.length} characters: “${description.slice(0, 120)}…”`); descriptions.set(description.toLowerCase(), [...(descriptions.get(description.toLowerCase()) || []), page]); }
    const h1s = Array.isArray(page.h1List) ? page.h1List.filter(Boolean) : page.h1 ? [page.h1] : [];
    if (!h1s.length) add('missing-h1', page, 'No H1 was extracted.'); else if (h1s.length > 1) add('multiple-h1', page, `${h1s.length} H1 headings: ${h1s.slice(0, 3).join(' • ')}`);
    const canonical = (page.canonical || '').trim();
    if (!canonical) add('missing-canonical', page, 'No canonical URL was extracted.'); else if (comparableUrl(canonical) !== comparableUrl(page.url)) add('canonical-mismatch', page, `Canonical: ${canonical}`);
    if (/\bnoindex\b/i.test(page.metaRobots || '')) add('noindex', page, `Robots directive: ${page.metaRobots}`);
    const wordCount = page.customContent?.wordCount || page.totalWords || 0;
    if (wordCount < 300) add('thin-content', page, `${wordCount.toLocaleString()} extracted words.`);
    const candidate = duplicateContentCandidate(page);
    if (candidate) { const key = `${candidate.source}|${candidate.normalized}`; content.set(key, [...(content.get(key) || []), { page, wordCount: candidate.wordCount, source: candidate.source }]); }
  }
  for (const matches of titles.values()) if (matches.length > 1) matches.forEach(page => add('duplicate-title', page, `Shared by ${matches.length} pages: “${page.title}”`));
  for (const matches of descriptions.values()) if (matches.length > 1) matches.forEach(page => add('duplicate-description', page, `Shared by ${matches.length} pages: “${(page.metaDescription || '').slice(0, 120)}”`));
  for (const matches of content.values()) if (matches.length > 1) matches.forEach(({ page, wordCount, source }) => add('duplicate-content', page, `Exact ${source} match shared by ${matches.length} pages (${wordCount.toLocaleString()} words).`));
  for (const link of links) if (internal(link) && (link.statusCode === 0 || (link.statusCode || 0) >= 400)) add('broken-internal-link', { url: link.sourceUrl || 'Unknown source page' }, `${link.targetUrl || link.url || link.rawHref || 'Unknown target'} returned ${link.statusCode || 'no response'}.`);
  for (const link of links) if (internal(link) && (link.redirectCount || link.redirectChain?.length)) {
    const hops = link.redirectCount || link.redirectChain?.length || 0;
    add('redirected-internal-link', { url: link.sourceUrl || 'Unknown source page' }, `${link.targetUrl || link.url || link.rawHref || 'Unknown target'} redirects in ${hops} hop${hops === 1 ? '' : 's'} to ${link.finalUrl || 'an unknown destination'}.`);
  }
  return [...groups.values()].flatMap(group => group.items.map(item => ({ ...item, code: group.code, severity: group.severity, label: group.label, description: group.description })));
}
