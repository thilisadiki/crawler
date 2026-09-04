import { URL } from 'url';

export class LinkStatusChecker {
  constructor(options = {}) {
    this.cache = new Map();
    this.timeoutMs = options.timeoutMs || 8000;
    this.maxRedirects = options.maxRedirects || 10;
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.geo = options.geo || null;
  }

  isRedirectStatus(status) {
    return [301, 302, 303, 307, 308].includes(status);
  }

  cloneResult(result) {
    return { ...result, redirectChain: (result.redirectChain || []).map(hop => ({ ...hop })) };
  }

  async requestWithRedirectChain(url, method, headers, signal) {
    let currentUrl = url;
    const redirectChain = [];

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const response = await fetch(currentUrl, { method, signal, headers, redirect: 'manual' });
      const statusCode = response.status;
      const location = response.headers.get('location');

      if (this.isRedirectStatus(statusCode) && location) {
        let destinationUrl;
        try {
          destinationUrl = new URL(location, currentUrl).toString();
        } catch {
          response.body?.cancel?.().catch(() => {});
          return { statusCode, finalStatusCode: statusCode, finalUrl: currentUrl, redirectChain, redirectError: 'Invalid redirect location' };
        }
        redirectChain.push({ url: currentUrl, statusCode, destinationUrl });
        response.body?.cancel?.().catch(() => {});
        currentUrl = destinationUrl;
        continue;
      }

      response.body?.cancel?.().catch(() => {});
      return {
        // Keep the source response code visible: a 301 should not become an
        // apparently direct 200 just because its destination loaded.
        statusCode: redirectChain[0]?.statusCode || statusCode,
        finalStatusCode: statusCode,
        finalUrl: currentUrl,
        redirectChain
      };
    }

    return {
      statusCode: redirectChain[0]?.statusCode || 500,
      finalStatusCode: 500,
      finalUrl: currentUrl,
      redirectChain,
      redirectError: `Redirect chain exceeded ${this.maxRedirects} hops`
    };
  }

  /** Check a URL while retaining its complete HTTP redirect information. */
  async checkUrl(url, cancellationSignal = null) {
    if (!url) return { statusCode: 400, finalStatusCode: 400, finalUrl: url, redirectChain: [] };
    if (cancellationSignal?.aborted) return undefined;
    if (/^(?:mailto|tel|javascript):/i.test(url) || url === '#') {
      return { statusCode: 200, finalStatusCode: 200, finalUrl: url, redirectChain: [] };
    }
    if (this.cache.has(url)) return this.cloneResult(this.cache.get(url));

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        const result = { statusCode: 200, finalStatusCode: 200, finalUrl: url, redirectChain: [] };
        this.cache.set(url, result);
        return this.cloneResult(result);
      }
    } catch {
      const result = { statusCode: 400, finalStatusCode: 400, finalUrl: url, redirectChain: [] };
      this.cache.set(url, result);
      return this.cloneResult(result);
    }

    const requestHeaders = { 'User-Agent': this.userAgent, Accept: '*/*' };
    if (this.geo?.ip) {
      requestHeaders['X-Forwarded-For'] = this.geo.ip;
      requestHeaders['X-Real-IP'] = this.geo.ip;
    }
    if (this.geo?.countryCode) {
      requestHeaders['CF-IPCountry'] = this.geo.countryCode;
      requestHeaders['X-Country-Code'] = this.geo.countryCode;
    }
    if (this.geo?.locale) requestHeaders['Accept-Language'] = `${this.geo.locale},en;q=0.9`;

    let result = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = cancellationSignal ? AbortSignal.any([controller.signal, cancellationSignal]) : controller.signal;
      try {
        result = await this.requestWithRedirectChain(url, 'HEAD', requestHeaders, signal);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {}

    if (cancellationSignal?.aborted) return undefined;

    // Some servers reject HEAD, so repeat with a lightweight GET while still
    // following and recording every redirect ourselves.
    if (!result || result.finalStatusCode === 405 || result.finalStatusCode === 403) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        const signal = cancellationSignal ? AbortSignal.any([controller.signal, cancellationSignal]) : controller.signal;
        try {
          result = await this.requestWithRedirectChain(url, 'GET', {
            ...requestHeaders,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }, signal);
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {}
    }

    if (cancellationSignal?.aborted) return undefined;
    const finalResult = result || { statusCode: 500, finalStatusCode: 500, finalUrl: url, redirectChain: [] };
    this.cache.set(url, finalResult);
    return this.cloneResult(finalResult);
  }

  async checkUrlStatus(url, cancellationSignal = null) {
    const result = await this.checkUrl(url, cancellationSignal);
    return result?.statusCode;
  }

  async checkLinksInParallel(links, maxConcurrency = 10, deadlineMs = 0, cancellationSignal = null) {
    const queue = [...links];
    const workers = [];
    const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : 0;

    const worker = async () => {
      while (queue.length > 0) {
        if (cancellationSignal?.aborted || (deadlineAt && Date.now() >= deadlineAt)) break;
        const link = queue.shift();
        if (!link || link.statusCode !== undefined) continue;
        try {
          const result = await this.checkUrl(link.url, cancellationSignal);
          if (result === undefined) continue;
          link.statusCode = result.statusCode;
          link.finalStatusCode = result.finalStatusCode;
          link.finalUrl = result.finalUrl;
          link.redirectChain = result.redirectChain;
          link.redirectCount = result.redirectChain.length;
          if (result.redirectError) link.redirectError = result.redirectError;
        } catch {
          if (!cancellationSignal?.aborted) link.statusCode = 500;
        }
      }
    };

    for (let i = 0; i < Math.min(maxConcurrency, links.length); i++) workers.push(worker());
    await Promise.all(workers);
    return links;
  }
}
