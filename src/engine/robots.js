import { URL } from 'url';

/**
 * Standard Robots.txt parser conforming to RFC 9309
 */
export class RobotsParser {
  constructor(robotsTxtContent = '', userAgent = '*') {
    this.userAgent = userAgent.toLowerCase();
    this.rules = [];
    this.sitemaps = [];
    if (robotsTxtContent) {
      this.parse(robotsTxtContent);
    }
  }

  static async fetchForOrigin(originUrl, userAgent = '*') {
    try {
      const parsed = new URL(originUrl);
      const robotsUrl = `${parsed.origin}/robots.txt`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const res = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        return new RobotsParser('', userAgent);
      }
      const text = await res.text();
      return new RobotsParser(text, userAgent);
    } catch (e) {
      return new RobotsParser('', userAgent);
    }
  }

  parse(content) {
    const lines = content.split(/\r?\n/);
    let currentUserAgents = [];
    let isTargetGroup = false;

    for (let rawLine of lines) {
      // Remove comments
      const hashIdx = rawLine.indexOf('#');
      if (hashIdx !== -1) {
        rawLine = rawLine.slice(0, hashIdx);
      }
      const line = rawLine.trim();
      if (!line) {
        currentUserAgents = [];
        isTargetGroup = false;
        continue;
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const field = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      if (field === 'user-agent') {
        const ua = value.toLowerCase();
        currentUserAgents.push(ua);
        if (ua === '*' || ua === this.userAgent || this.userAgent.includes(ua)) {
          isTargetGroup = true;
        }
      } else if (field === 'sitemap') {
        if (value) this.sitemaps.push(value);
      } else if (isTargetGroup) {
        if (field === 'disallow') {
          if (value) {
            this.rules.push({ type: 'disallow', path: value });
          }
        } else if (field === 'allow') {
          if (value) {
            this.rules.push({ type: 'allow', path: value });
          }
        }
      }
    }
  }

  /**
   * Check if a URL pathname is allowed to be crawled
   */
  isAllowed(urlStr) {
    if (!this.rules.length) return true;

    try {
      const urlObj = new URL(urlStr);
      const pathnameWithQuery = urlObj.pathname + urlObj.search;

      // Find all matching rules
      const matches = [];
      for (const rule of this.rules) {
        if (this.pathMatches(rule.path, pathnameWithQuery)) {
          matches.push(rule);
        }
      }

      if (!matches.length) return true;

      // Longest match takes precedence according to standard
      matches.sort((a, b) => b.path.length - a.path.length);
      const winner = matches[0];
      return winner.type === 'allow';
    } catch (e) {
      return true;
    }
  }

  pathMatches(pattern, path) {
    if (!pattern) return false;
    
    const hasEndAnchor = pattern.endsWith('$');
    let cleanPattern = hasEndAnchor ? pattern.slice(0, -1) : pattern;

    const escaped = cleanPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');

    const regex = new RegExp(`^${escaped}${hasEndAnchor ? '$' : ''}`);
    return regex.test(path);
  }
}
