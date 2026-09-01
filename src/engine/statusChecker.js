import { URL } from 'url';

export class LinkStatusChecker {
  constructor(options = {}) {
    this.cache = new Map();
    this.timeoutMs = options.timeoutMs || 8000;
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.geo = options.geo || null;
  }

  /**
   * Check status code for a single URL with cache and fallback
   */
  async checkUrlStatus(url) {
    if (!url) return 400;

    // Handle non-HTTP schemas
    if (url.startsWith('mailto:') || url.startsWith('tel:')) return 200;
    if (url.startsWith('javascript:') || url === '#') return 200;

    if (this.cache.has(url)) {
      return this.cache.get(url);
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.cache.set(url, 200);
        return 200;
      }
    } catch (e) {
      this.cache.set(url, 400);
      return 400;
    }

    let status = null;

    const requestHeaders = {
      'User-Agent': this.userAgent,
      'Accept': '*/*'
    };

    if (this.geo) {
      if (this.geo.ip) {
        requestHeaders['X-Forwarded-For'] = this.geo.ip;
        requestHeaders['X-Real-IP'] = this.geo.ip;
      }
      if (this.geo.countryCode) {
        requestHeaders['CF-IPCountry'] = this.geo.countryCode;
        requestHeaders['X-Country-Code'] = this.geo.countryCode;
      }
      if (this.geo.locale) {
        requestHeaders['Accept-Language'] = `${this.geo.locale},en;q=0.9`;
      }
    }

    // Attempt 1: Fast HEAD request
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: requestHeaders,
        redirect: 'follow'
      });
      clearTimeout(timeoutId);

      status = res.status;
    } catch (headErr) {
      // Ignore and fallback to GET
    }

    // Attempt 2: If HEAD was 405 (Method Not Allowed), 403, or failed, fallback to GET
    if (!status || status === 405 || status === 403) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            ...requestHeaders,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          redirect: 'follow'
        });
        clearTimeout(timeoutId);

        status = res.status;
        if (res.body && res.body.cancel) {
          res.body.cancel().catch(() => {});
        }
      } catch (getErr) {
        status = status || 500;
      }
    }

    const finalStatus = status || 500;
    this.cache.set(url, finalStatus);
    return finalStatus;
  }

  /**
   * Check an array of link objects in parallel with concurrency limiting
   */
  async checkLinksInParallel(links, maxConcurrency = 10, deadlineMs = 0) {
    const queue = [...links];
    const workers = [];
    const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : 0;

    const worker = async () => {
      while (queue.length > 0) {
        if (deadlineAt && Date.now() >= deadlineAt) break;
        const link = queue.shift();
        if (!link || link.statusCode !== undefined) continue;

        try {
          link.statusCode = await this.checkUrlStatus(link.url);
        } catch (e) {
          link.statusCode = 500;
        }
      }
    };

    for (let i = 0; i < Math.min(maxConcurrency, links.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return links;
  }
}
