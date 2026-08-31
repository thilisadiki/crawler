export class Exporter {
  static escapeCSV(field) {
    if (field === null || field === undefined) return '""';
    const str = String(field);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return `"${str}"`;
  }

  /**
   * Export all crawled pages with general SEO audit & custom container data
   */
  static generatePagesCSV(results) {
    const headers = [
      'URL',
      'Status Code',
      'Response Time (ms)',
      'Title',
      'Meta Description',
      'Canonical',
      'Meta Robots',
      'H1',
      'H2s',
      'Total Body Words',
      'Images Count',
      'Content Area Detected',
      'Content Area Words',
      'Content Area Headings',
      'Content Area Links Count',
      'Internal Links Count',
      'External Links Count',
      'Error',
      'Timestamp'
    ];

    const rows = results.map(r => [
      this.escapeCSV(r.url),
      this.escapeCSV(r.statusCode),
      this.escapeCSV(r.responseTimeMs),
      this.escapeCSV(r.title),
      this.escapeCSV(r.metaDescription),
      this.escapeCSV(r.canonical),
      this.escapeCSV(r.metaRobots),
      this.escapeCSV(r.h1),
      this.escapeCSV((r.h2List || []).join(' | ')),
      this.escapeCSV(r.totalWords),
      this.escapeCSV(r.imagesCount || 0),
      this.escapeCSV(r.customContent?.detected ? 'YES' : 'NO'),
      this.escapeCSV(r.customContent?.wordCount || 0),
      this.escapeCSV((r.customContent?.headings || []).join(' | ')),
      this.escapeCSV(r.customLinksCount || 0),
      this.escapeCSV(r.internalLinksCount || 0),
      this.escapeCSV(r.externalLinksCount || 0),
      this.escapeCSV(r.error || ''),
      this.escapeCSV(r.timestamp)
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\r\n');
  }

  /**
   * Export every single discovered link with anchor text, source, target, and location
   */
  static generateLinksCSV(allLinks) {
    const headers = [
      'Source Page URL',
      'Anchor Text',
      'Target URL',
      'Status Code',
      'Link Type',
      'In Content Area',
      'Nofollow',
      'Page Depth'
    ];

    const rows = allLinks.map(l => [
      this.escapeCSV(l.sourceUrl),
      this.escapeCSV(l.anchorText),
      this.escapeCSV(l.targetUrl),
      this.escapeCSV(l.statusCode || 200),
      this.escapeCSV(l.linkType),
      this.escapeCSV(l.isInsideCustom ? 'YES' : 'NO'),
      this.escapeCSV(l.isNofollow ? 'YES' : 'NO'),
      this.escapeCSV(l.pageDepth)
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\r\n');
  }

  /**
   * Export Content Area-specific report
   */
  static generateCustomContentReportCSV(results) {
    const headers = [
      'URL',
      'Content Area Detected',
      'Selector Used',
      'Content Area Word Count',
      'Content Area Headings',
      'Content Area Links Count',
      'Content Area Full Text'
    ];

    const rows = results.map(r => [
      this.escapeCSV(r.url),
      this.escapeCSV(r.customContent?.detected ? 'YES' : 'NO'),
      this.escapeCSV(r.customContent?.selectorUsed || ''),
      this.escapeCSV(r.customContent?.wordCount || 0),
      this.escapeCSV((r.customContent?.headings || []).join(' | ')),
      this.escapeCSV(r.customLinksCount || 0),
      this.escapeCSV(r.customContent?.fullText || r.customContent?.textSnippet || r.fullPageText || '')
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\r\n');
  }
}
