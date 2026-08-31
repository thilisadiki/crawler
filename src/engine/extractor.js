import { URL } from 'url';

export class Extractor {
  /**
   * Extract all SEO metadata, links, and optional custom content container data
   */
  static async extractPageData(page, currentUrl, baseOrigin, options = {}) {
    const customSelector = options.customSelector || '';

    return await page.evaluate(({ currentUrl, baseOrigin, customSelector }) => {
      const getMeta = (name, attr = 'name') => {
        const el = document.querySelector(`meta[${attr}="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
        return el ? el.getAttribute('content') || '' : '';
      };

      // 1. Core SEO Metadata
      const title = document.title ? document.title.trim() : '';
      const metaDescription = getMeta('description') || getMeta('og:description');
      const canonicalEl = document.querySelector('link[rel="canonical"]');
      const canonical = canonicalEl ? canonicalEl.href : '';
      const metaRobots = getMeta('robots') || getMeta('googlebot');
      const ogTitle = getMeta('og:title');
      const ogDescription = getMeta('og:description');
      const ogImage = getMeta('og:image');
      const ogType = getMeta('og:type');

      // 2. Headings Hierarchy
      const h1List = Array.from(document.querySelectorAll('h1')).map(el => el.innerText.trim()).filter(Boolean);
      const h2List = Array.from(document.querySelectorAll('h2')).map(el => el.innerText.trim()).filter(Boolean);
      const h3List = Array.from(document.querySelectorAll('h3')).map(el => el.innerText.trim()).filter(Boolean);

      // 3. Custom / Target Content Container (e.g. SEO text block, article, or specified selector)
      let customFound = false;
      let customText = '';
      let customWordCount = 0;
      let customHeadings = [];
      let customElement = null;
      let usedSelector = customSelector;

      if (customSelector) {
        try {
          customElement = document.querySelector(customSelector);
        } catch (e) {}
      }

      // Smart auto-detection fallback if no specific selector provided
      if (!customElement && !customSelector) {
        const potentialSelectors = [
          '.page-text',
          '[class*="page-text"]',
          '.seo-content',
          '[class*="seo-content"]',
          '[class*="seo_content"]',
          '[class*="seoText"]',
          '[class*="seo-text"]',
          '[class*="kentico"]',
          '#content',
          '#seo-content',
          '#seo-text',
          '.seo-section',
          '.bottom-seo',
          '[data-seo-content]',
          'article'
        ];
        for (const sel of potentialSelectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText.trim().length > 30) {
            customElement = el;
            usedSelector = sel;
            break;
          }
        }
      }

      if (customElement) {
        customFound = true;
        customText = customElement.innerText.trim();
        customWordCount = customText ? customText.split(/\s+/).filter(Boolean).length : 0;
        customHeadings = Array.from(customElement.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .map(h => `${h.tagName}: ${h.innerText.trim()}`)
          .filter(Boolean);
      }

      // 4. Links Extraction (All internal & external links with anchor text)
      const allAnchors = Array.from(document.querySelectorAll('a[href]'));
      const links = [];

      for (const a of allAnchors) {
        const rawHref = a.getAttribute('href') || '';
        const resolvedHref = a.href || '';
        const anchorText = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ') || '[No Text]';
        const rel = a.getAttribute('rel') || '';
        const target = a.getAttribute('target') || '';
        const isNofollow = rel.toLowerCase().includes('nofollow');
        const isInsideCustom = customElement ? customElement.contains(a) : false;

        let linkType = 'Internal';
        let isValidHttp = false;

        if (rawHref.startsWith('mailto:')) {
          linkType = 'Mailto';
        } else if (rawHref.startsWith('tel:')) {
          linkType = 'Tel';
        } else if (rawHref.startsWith('javascript:') || rawHref === '#') {
          linkType = 'Anchor/Script';
        } else {
          try {
            const urlObj = new URL(resolvedHref);
            isValidHttp = urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
            linkType = (urlObj.origin === baseOrigin) ? 'Internal' : 'External';
          } catch (e) {
            linkType = 'Invalid';
          }
        }

        links.push({
          rawHref,
          url: resolvedHref,
          anchorText,
          linkType,
          rel,
          target,
          isNofollow,
          isInsideCustom,
          isValidHttp
        });
      }

      const totalWords = document.body ? document.body.innerText.trim().split(/\s+/).filter(Boolean).length : 0;
      const imagesCount = document.querySelectorAll('img').length;
      const fullPageText = document.body ? document.body.innerText.trim() : '';

      return {
        title,
        metaDescription,
        canonical,
        metaRobots,
        ogTitle,
        ogDescription,
        ogImage,
        ogType,
        h1List,
        h2List,
        h3List,
        totalWords,
        imagesCount,
        fullPageText,
        fullPageTextSnippet: fullPageText.slice(0, 1000),
        customContent: {
          detected: customFound,
          selectorUsed: usedSelector,
          wordCount: customWordCount,
          fullText: customText || '',
          textSnippet: customText || '',
          headings: customHeadings
        },
        links
      };
    }, { currentUrl, baseOrigin, customSelector });
  }

  /**
   * Normalize URLs for deduplication and crawling
   */
  static normalizeUrl(rawUrl, baseUrl) {
    try {
      const parsed = new URL(rawUrl, baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      parsed.hash = '';
      const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'msclkid'];
      for (const p of trackingParams) {
        parsed.searchParams.delete(p);
      }
      return parsed.toString();
    } catch (e) {
      return null;
    }
  }
}
