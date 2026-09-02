import { URL } from 'url';

const CONTENT_AREA_SELECTORS = [
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
  '[data-content-area]',
  '.copy-section',
  '[class*="copy-section"]',
  '.content-block',
  '[class*="content-block"]',
  '.mainBlock',
  '[class*="main-block"]',
  '[class*="mainBlock"]',
  'article'
];

const CONTENT_EXCLUSION_PATTERN = /nav|header|footer|sidebar|side-bar|menu|cookie|consent|modal|popup|banner|breadcrumb|toolbar|login|signup|betslip|bet-slip|winner|carousel|slider/i;

export class Extractor {
  /**
   * Extract all SEO metadata, links, and optional custom content container data
   */
  static async extractPageData(page, currentUrl, baseOrigin, options = {}) {
    const customSelector = options.customSelector || '';

    return await page.evaluate(({ currentUrl, baseOrigin, customSelector, contentSelectors }) => {
      const contentExclusionPattern = /nav|header|footer|sidebar|side-bar|menu|cookie|consent|modal|popup|banner|breadcrumb|toolbar|login|signup|betslip|bet-slip|winner|carousel|slider/i;
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
      let detectionMethod = customSelector ? 'custom' : 'none';

      const getWordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const hasExcludedContext = (el) => {
        if (el.closest('header, nav, footer, aside, form, dialog, [role="navigation"], [role="banner"], [role="contentinfo"]')) return true;
        let current = el;
        while (current && current !== document.body) {
          const descriptor = `${current.id || ''} ${typeof current.className === 'string' ? current.className : ''}`;
          if (contentExclusionPattern.test(descriptor)) return true;
          current = current.parentElement;
        }
        return false;
      };
      const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const getCssPath = (el) => {
        if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) return `#${cssEscape(el.id)}`;
        const semanticClass = Array.from(el.classList || []).find(className => /content|copy|article|detail|description|text|body|main/i.test(className));
        if (semanticClass) return `${el.tagName.toLowerCase()}.${cssEscape(semanticClass)}`;

        const parts = [];
        let current = el;
        while (current && current !== document.body && parts.length < 4) {
          const tagName = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName) : [];
          const position = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
          parts.unshift(`${tagName}${position}`);
          const selector = parts.join(' > ');
          if (document.querySelectorAll(selector).length === 1) return selector;
          current = current.parentElement;
        }
        return el.tagName.toLowerCase();
      };
      const findHeuristicContentArea = () => {
        const candidates = Array.from(document.querySelectorAll('main, article, section, [role="main"], div'))
          .filter(el => isVisible(el) && !hasExcludedContext(el))
          .map(el => {
            const text = (el.innerText || '').trim();
            const wordCount = text ? getWordCount(text) : 0;
            const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
            const paragraphs = el.querySelectorAll('p, li').length;
            const links = el.querySelectorAll('a[href]').length;
            const descriptor = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
            const semanticBonus = /content|copy|article|detail|description|text|body|main/i.test(descriptor) ? 140 : 0;
            const score = Math.min(wordCount, 1000) + (headings * 100) + Math.min(paragraphs, 12) * 24 + semanticBonus - Math.min(links, 80) * 20;
            return { el, wordCount, headings, paragraphs, links, score };
          })
          .filter(candidate => candidate.wordCount >= 120 && (candidate.headings > 0 || candidate.paragraphs >= 2) && candidate.score >= 260)
          .sort((a, b) => b.score - a.score || a.wordCount - b.wordCount);

        return candidates[0] || null;
      };

      if (customSelector) {
        try {
          customElement = document.querySelector(customSelector);
        } catch (e) {}
      }

      // Smart auto-detection fallback if no specific selector provided
      if (!customElement && !customSelector) {
        for (const sel of contentSelectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText.trim().length > 30) {
            customElement = el;
            usedSelector = sel;
            detectionMethod = 'selector';
            break;
          }
        }
      }

      // If known selectors are absent, look for a focused, text-rich content block.
      // This deliberately excludes page shells, navigation, betting widgets, and footers.
      if (!customElement && !customSelector) {
        const heuristicCandidate = findHeuristicContentArea();
        if (heuristicCandidate) {
          customElement = heuristicCandidate.el;
          usedSelector = getCssPath(customElement);
          detectionMethod = 'heuristic';
        }
      }

      if (customElement) {
        customFound = true;
        customText = customElement.innerText.trim();
        customWordCount = customText ? getWordCount(customText) : 0;
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
          detectionMethod,
          wordCount: customWordCount,
          fullText: customText || '',
          textSnippet: customText || '',
          headings: customHeadings
        },
        links
      };
    }, { currentUrl, baseOrigin, customSelector, contentSelectors: CONTENT_AREA_SELECTORS });
  }

  /**
   * Fast, reliable HTML string parser using Cheerio (runs in any environment without browser dependencies)
   */
  static extractFromHtml(html, currentUrl, baseOrigin, options = {}) {
    const customSelector = options.customSelector || '';
    const cheerio = options.cheerio;
    if (!cheerio) return {};

    const $ = cheerio.load(html);

    const getMeta = (name, attr = 'name') => {
      return $(`meta[${attr}="${name}"]`).attr('content') || $(`meta[property="${name}"]`).attr('content') || '';
    };

    const title = ($('title').text() || '').trim();
    const metaDescription = getMeta('description') || getMeta('og:description');
    const canonical = $('link[rel="canonical"]').attr('href') || '';
    const metaRobots = getMeta('robots') || getMeta('googlebot');
    const ogTitle = getMeta('og:title');
    const ogDescription = getMeta('og:description');
    const ogImage = getMeta('og:image');
    const ogType = getMeta('og:type');

    const h1List = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h2List = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h3List = $('h3').map((_, el) => $(el).text().trim()).get().filter(Boolean);

    let customFound = false;
    let customText = '';
    let customWordCount = 0;
    let customHeadings = [];
    let customElement = null;
    let usedSelector = customSelector;
    let detectionMethod = customSelector ? 'custom' : 'none';

    const getCheerioSelector = (element) => {
      const id = element.attr('id');
      if (id) return `#${id}`;
      const classNames = (element.attr('class') || '').split(/\s+/).filter(Boolean);
      const semanticClass = classNames.find(className => /content|copy|article|detail|description|text|body|main/i.test(className));
      return semanticClass ? `${element[0].tagName}.${semanticClass}` : element[0].tagName;
    };
    const findCheerioHeuristicContentArea = () => {
      const candidates = [];
      $('main, article, section, [role="main"], div').each((_, element) => {
        const $element = $(element);
        const descriptor = `${$element.attr('id') || ''} ${$element.attr('class') || ''}`;
        if ($element.is('header, nav, footer, aside, form, dialog, [role="navigation"], [role="banner"], [role="contentinfo"]') ||
          $element.parents('header, nav, footer, aside, form, dialog, [role="navigation"], [role="banner"], [role="contentinfo"]').length ||
          CONTENT_EXCLUSION_PATTERN.test(descriptor)) return;

        const text = $element.text().trim();
        const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
        const headings = $element.find('h1, h2, h3, h4, h5, h6').length;
        const paragraphs = $element.find('p, li').length;
        const links = $element.find('a[href]').length;
        const semanticBonus = /content|copy|article|detail|description|text|body|main/i.test(descriptor) ? 140 : 0;
        const score = Math.min(wordCount, 1000) + (headings * 100) + Math.min(paragraphs, 12) * 24 + semanticBonus - Math.min(links, 80) * 20;
        if (wordCount >= 120 && (headings > 0 || paragraphs >= 2) && score >= 260) {
          candidates.push({ element: $element, wordCount, score });
        }
      });
      candidates.sort((a, b) => b.score - a.score || a.wordCount - b.wordCount);
      return candidates[0] || null;
    };

    if (customSelector) {
      try {
        const el = $(customSelector);
        if (el.length > 0) customElement = el.first();
      } catch (e) {}
    }

    if (!customElement && !customSelector) {
      for (const sel of CONTENT_AREA_SELECTORS) {
        const el = $(sel);
        if (el.length > 0 && el.text().trim().length > 30) {
          customElement = el.first();
          usedSelector = sel;
          detectionMethod = 'selector';
          break;
        }
      }
    }

    if (!customElement && !customSelector) {
      const heuristicCandidate = findCheerioHeuristicContentArea();
      if (heuristicCandidate) {
        customElement = heuristicCandidate.element;
        usedSelector = getCheerioSelector(customElement);
        detectionMethod = 'heuristic';
      }
    }

    if (customElement) {
      customFound = true;
      customText = customElement.text().trim();
      customWordCount = customText ? customText.split(/\s+/).filter(Boolean).length : 0;
      customHeadings = customElement.find('h1, h2, h3, h4, h5, h6').map((_, h) => {
        return `${h.tagName.toUpperCase()}: ${$(h).text().trim()}`;
      }).get().filter(Boolean);
    }

    const links = [];
    $('a[href]').each((_, a) => {
      const $a = $(a);
      const rawHref = $a.attr('href') || '';
      let resolvedHref = rawHref;
      try {
        resolvedHref = new URL(rawHref, currentUrl).toString();
      } catch (e) {}

      const anchorText = ($a.text() || '').trim().replace(/\s+/g, ' ') || '[No Text]';
      const rel = $a.attr('rel') || '';
      const target = $a.attr('target') || '';
      const isNofollow = rel.toLowerCase().includes('nofollow');
      
      let isInsideCustom = false;
      if (customElement) {
        isInsideCustom = $a.parents(usedSelector).length > 0 || $a.closest(customElement).length > 0;
      }

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
        isInternal: linkType === 'Internal',
        rel,
        target,
        isNofollow,
        isInsideCustom,
        isValidHttp
      });
    });

    const bodyText = $('body').text().trim();
    const totalWords = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
    const imagesCount = $('img').length;

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
      fullPageText: bodyText,
      fullPageTextSnippet: bodyText.slice(0, 1000),
      customContent: {
        detected: customFound,
        selectorUsed: usedSelector,
        detectionMethod,
        wordCount: customWordCount,
        fullText: customText || '',
        textSnippet: customText || '',
        headings: customHeadings
      },
      links
    };
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
