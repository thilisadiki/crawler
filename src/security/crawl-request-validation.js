export class CrawlRequestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrawlRequestValidationError';
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CrawlRequestValidationError(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new CrawlRequestValidationError(`${label} must be enabled or disabled.`);
  return value;
}

function optionalString(value, fallback, maximumLength, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new CrawlRequestValidationError(`${label} must be text no longer than ${maximumLength} characters.`);
  }
  return value.trim();
}

function containsObviousNestedQuantifier(pattern) {
  // This deliberately permits normal path patterns while rejecting the common
  // catastrophic-backtracking form such as `(a+)+` or `(.*)*`.
  return /\((?:[^()\\]|\\.)*[+*][^)]*\)(?:[+*]|\{\d*,?\d*\})/.test(pattern);
}

function normalizePatternList(value, label, maximumCount, maximumLength) {
  if (value === undefined || value === null || value === '') return [];
  const patterns = typeof value === 'string' ? value.split(/\r?\n/) : value;
  if (!Array.isArray(patterns) || patterns.length > maximumCount) {
    throw new CrawlRequestValidationError(`${label} can contain at most ${maximumCount} entries.`);
  }
  return patterns
    .map((pattern) => {
      if (typeof pattern !== 'string') throw new CrawlRequestValidationError(`${label} entries must be text.`);
      const clean = pattern.trim();
      if (!clean) return null;
      if (clean.length > maximumLength) throw new CrawlRequestValidationError(`${label} entries can be at most ${maximumLength} characters.`);
      if (containsObviousNestedQuantifier(clean)) throw new CrawlRequestValidationError(`${label} contains an unsafe regular expression.`);
      try {
        new RegExp(clean);
      } catch {
        throw new CrawlRequestValidationError(`${label} contains an invalid regular expression: ${clean}`);
      }
      return clean;
    })
    .filter(Boolean);
}

/** Validate and normalize every setting accepted by POST /api/crawler/start. */
export function validateCrawlRequest(body, options) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CrawlRequestValidationError('Send a valid crawl configuration.');
  }
  const {
    maxWorkersPerCrawl,
    maxUnlimitedCrawlPages,
    allowedRegions
  } = options;
  const crawlScope = body.crawlScope === undefined ? 'domain' : body.crawlScope;
  if (!['single-url', 'domain', 'subpath', 'subdomains'].includes(crawlScope)) {
    throw new CrawlRequestValidationError('Choose a valid crawl scope.');
  }
  const requestedRegion = optionalString(body.region, 'auto', 8, 'Region');
  const region = requestedRegion.toLowerCase() === 'auto' ? 'auto' : requestedRegion.toUpperCase();
  if (!allowedRegions.has(region)) throw new CrawlRequestValidationError('Choose a supported crawl region.');
  if (typeof body.proxy === 'string' && body.proxy.trim()) {
    throw new CrawlRequestValidationError('Custom proxy endpoints are disabled for security. CrawlLoom uses the hosting provider’s own network connection.');
  }

  const noPageLimit = crawlScope !== 'single-url' && optionalBoolean(body.noPageLimit, false, 'No page limit');
  const maxPages = crawlScope === 'single-url'
    ? 1
    : boundedInteger(body.maxPages, 50, 1, maxUnlimitedCrawlPages, 'Page limit');

  return {
    crawlScope,
    maxDepth: crawlScope === 'single-url' ? 0 : boundedInteger(body.maxDepth, 3, 0, 20, 'Max crawl depth'),
    maxPages,
    noPageLimit,
    concurrency: boundedInteger(body.concurrency, 1, 1, maxWorkersPerCrawl, 'Worker threads'),
    customContentSelector: optionalString(body.customContentSelector, '', 500, 'Custom content selector'),
    excludePatterns: normalizePatternList(body.excludePatterns, 'Disallow paths or regex', 30, 250),
    includePatterns: normalizePatternList(body.includePatterns, 'Allow-only paths or regex', 30, 250),
    respectRobotsTxt: optionalBoolean(body.respectRobotsTxt, false, 'Robots.txt enforcement'),
    autoScroll: optionalBoolean(body.autoScroll, true, 'Dynamic auto-scroll'),
    delayBetweenRequestsMs: boundedInteger(body.delayBetweenRequestsMs, 500, 0, 5000, 'Rate limiter'),
    region,
    blockCrossDomainRedirects: optionalBoolean(body.blockCrossDomainRedirects, true, 'Target-domain lock')
  };
}
