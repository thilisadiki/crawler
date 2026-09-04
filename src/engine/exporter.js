import ExcelJS from 'exceljs';

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
   * Helper to generate a safe Excel Sheet tab name (max 31 chars, valid chars)
   */
  static getSafeSheetName(urlStr, index) {
    try {
      const parsed = new URL(urlStr);
      let pathPart = parsed.pathname.replace(/^\/+|\/+$/g, '');
      if (!pathPart) pathPart = 'Home';
      
      // Clean invalid Excel worksheet name characters: \ / ? * : [ ]
      let cleanName = pathPart.replace(/[\\/?*:[\]]/g, '-');
      
      // Prefix with index number so multiple subpages with same name don't clash
      let name = `${index + 1}. ${cleanName}`;
      if (name.length > 31) {
        name = name.substring(0, 31);
      }
      return name;
    } catch (e) {
      return `Page ${index + 1}`;
    }
  }

  /**
   * Generates a comprehensive Multi-Sheet Excel Workbook (.xlsx)
   * Sheet 1: Master Overview of all pages
   * Sheet 2: Master All Discovered Links
   * Sheet 3..N: Dedicated sheet for EVERY individual page (SEO copy, metadata, and page links)
   */
  static async generateMultiSheetWorkbook(results, allLinks = []) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CrawlLoom';
    workbook.created = new Date();

    // -------------------------------------------------------------
    // SHEET 1: Master Overview (All Audited Pages)
    // -------------------------------------------------------------
    const overviewSheet = workbook.addWorksheet('Master Overview', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    overviewSheet.columns = [
      { header: '#', key: 'id', width: 6 },
      { header: 'Status Code', key: 'statusCode', width: 12 },
      { header: 'URL Address', key: 'url', width: 45 },
      { header: 'Page Title', key: 'title', width: 35 },
      { header: 'Meta Description', key: 'metaDescription', width: 40 },
      { header: 'Canonical URL', key: 'canonical', width: 35 },
      { header: 'Meta Robots', key: 'metaRobots', width: 20 },
      { header: 'H1 Tag', key: 'h1', width: 30 },
      { header: 'H2 Sub-headings', key: 'h2List', width: 35 },
      { header: 'Total Words', key: 'totalWords', width: 14 },
      { header: 'Images', key: 'imagesCount', width: 10 },
      { header: 'Content Area', key: 'contentAreaDetected', width: 15 },
      { header: 'Content Area Words', key: 'contentAreaWords', width: 18 },
      { header: 'Content Area Links', key: 'customLinksCount', width: 18 },
      { header: 'Internal Links', key: 'internalLinksCount', width: 14 },
      { header: 'External Links', key: 'externalLinksCount', width: 14 },
      { header: 'Latency (ms)', key: 'responseTimeMs', width: 14 },
      { header: 'Error', key: 'error', width: 25 }
    ];

    // Style Header Row
    const headerRow1 = overviewSheet.getRow(1);
    headerRow1.height = 28;
    headerRow1.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' } // Slate 800
      };
      cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    results.forEach((r, idx) => {
      const row = overviewSheet.addRow({
        id: idx + 1,
        statusCode: r.statusCode || 200,
        url: r.url,
        title: r.title || '',
        metaDescription: r.metaDescription || '',
        canonical: r.canonical || '',
        metaRobots: r.metaRobots || '',
        h1: r.h1 || '',
        h2List: (r.h2List || []).join(' | '),
        totalWords: r.totalWords || 0,
        imagesCount: r.imagesCount || 0,
        contentAreaDetected: r.customContent?.detected ? 'YES' : 'NO',
        contentAreaWords: r.customContent?.wordCount || 0,
        customLinksCount: r.customLinksCount || 0,
        internalLinksCount: r.internalLinksCount || 0,
        externalLinksCount: r.externalLinksCount || 0,
        responseTimeMs: r.responseTimeMs || 0,
        error: r.error || ''
      });

      // Alignments & zebra coloring
      row.getCell('url').alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell('title').alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell('id').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('statusCode').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('contentAreaDetected').alignment = { vertical: 'middle', horizontal: 'center' };
      if (idx % 2 === 1) {
        row.eachCell(cell => {
          if (!cell.fill) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }
        });
      }
    });

    // -------------------------------------------------------------
    // SHEET 2: Master All Discovered Links Table
    // -------------------------------------------------------------
    const linksSheet = workbook.addWorksheet('All Discovered Links', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    linksSheet.columns = [
      { header: '#', key: 'id', width: 6 },
      { header: 'Status', key: 'statusCode', width: 12 },
      { header: 'Anchor Text', key: 'anchorText', width: 35 },
      { header: 'Destination Target URL', key: 'url', width: 45 },
      { header: 'Link Type', key: 'linkType', width: 14 },
      { header: 'In Content Area', key: 'isInsideCustom', width: 16 },
      { header: 'Nofollow', key: 'isNofollow', width: 12 },
      { header: 'Source Page URL', key: 'sourceUrl', width: 45 },
      { header: 'Page Depth', key: 'pageDepth', width: 12 }
    ];

    const headerRow2 = linksSheet.getRow(1);
    headerRow2.height = 28;
    headerRow2.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF2563EB' } // Royal Blue 600
      };
      cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    allLinks.forEach((l, idx) => {
      const row = linksSheet.addRow({
        id: idx + 1,
        statusCode: l.statusCode || 200,
        anchorText: l.anchorText || '[Empty Anchor / Image]',
        url: l.url || l.targetUrl || '',
        linkType: l.linkType || 'Internal',
        isInsideCustom: l.isInsideCustom ? 'YES' : 'NO',
        isNofollow: l.isNofollow ? 'YES' : 'NO',
        sourceUrl: l.sourceUrl || '',
        pageDepth: l.pageDepth || 0
      });

      row.getCell('id').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('statusCode').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('isInsideCustom').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('isNofollow').alignment = { vertical: 'middle', horizontal: 'center' };
      if (idx % 2 === 1) {
        row.eachCell(cell => {
          if (!cell.fill) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }
        });
      }
    });

    // -------------------------------------------------------------
    // SHEET 3..N: Dedicated Sheet for Every Individual Crawled Page
    // -------------------------------------------------------------
    results.forEach((pageResult, idx) => {
      const sheetName = this.getSafeSheetName(pageResult.url, idx);
      const pageSheet = workbook.addWorksheet(sheetName);

      // 1. Page Title Banner
      pageSheet.mergeCells('A1:F1');
      const titleCell = pageSheet.getCell('A1');
      titleCell.value = `PAGE AUDIT & CONTENT AREA REPORT: ${pageResult.url}`;
      titleCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0F172A' } // Slate 900
      };
      titleCell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
      titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      pageSheet.getRow(1).height = 32;

      // 2. Metadata Section
      pageSheet.addRow([]); // Blank row
      
      const metaRows = [
        ['URL Address', pageResult.url],
        ['HTTP Status Code', pageResult.statusCode || 200],
        ['Page Title Tag', pageResult.title || '[No Title Tag]'],
        ['Meta Description', pageResult.metaDescription || '[No Meta Description]'],
        ['Canonical URL', pageResult.canonical || '[Self / None]'],
        ['Meta Robots Directive', pageResult.metaRobots || 'index, follow (default)'],
        ['H1 Main Heading', pageResult.h1 || '[No H1 Tag]'],
        ['H2 Sub-headings', (pageResult.h2List || []).join(' • ') || '[No H2 Tags]'],
        ['Total Page Word Count', `${(pageResult.totalWords || 0).toLocaleString()} words`],
        ['Server Latency', `${pageResult.responseTimeMs || 0} ms`]
      ];

      metaRows.forEach(([key, val]) => {
        const r = pageSheet.addRow([key, val]);
        r.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: 'FF334155' } };
        r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        r.getCell(2).font = { name: 'Calibri', color: { argb: 'FF0F172A' } };
      });

      pageSheet.addRow([]); // Blank row

      // 3. Content Area Details & Untruncated SEO Text
      pageSheet.mergeCells(`A${pageSheet.rowCount + 1}:F${pageSheet.rowCount + 1}`);
      const contentBanner = pageSheet.getCell(`A${pageSheet.rowCount}`);
      const customDetected = pageResult.customContent?.detected;
      contentBanner.value = customDetected 
        ? `📝 CONTENT AREA EXTRACTED (${pageResult.customContent.wordCount.toLocaleString()} words)` 
        : `📝 FULL PAGE TEXT (${(pageResult.totalWords || 0).toLocaleString()} words)`;
      contentBanner.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: customDetected ? 'FF166534' : 'FF475569' } // Forest Green / Slate
      };
      contentBanner.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      contentBanner.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      pageSheet.getRow(pageSheet.rowCount).height = 26;

      const fullText = pageResult.customContent?.fullText || pageResult.customContent?.textSnippet || pageResult.fullPageText || '[No content extracted]';
      const headingsList = (pageResult.customContent?.headings || []).join(' • ') || '[No sub-headings inside content area]';

      const caRow1 = pageSheet.addRow(['Content Area Headings', headingsList]);
      caRow1.getCell(1).font = { name: 'Calibri', bold: true };
      caRow1.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

      const caRow2 = pageSheet.addRow(['Selector Used', pageResult.customContent?.selectorUsed || 'Auto-detected']);
      caRow2.getCell(1).font = { name: 'Calibri', bold: true };
      caRow2.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

      pageSheet.mergeCells(`B${pageSheet.rowCount + 1}:F${pageSheet.rowCount + 6}`);
      const textCell = pageSheet.getCell(`B${pageSheet.rowCount + 1}`);
      textCell.value = fullText;
      textCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
      textCell.font = { name: 'Calibri', size: 10, color: { argb: 'FF1E293B' } };
      
      const labelCell = pageSheet.getCell(`A${pageSheet.rowCount}`);
      labelCell.value = 'Full Extracted Text';
      labelCell.font = { name: 'Calibri', bold: true };
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      labelCell.alignment = { vertical: 'top', horizontal: 'left' };

      for (let i = 0; i < 5; i++) pageSheet.addRow([]); // Space for merged block
      pageSheet.addRow([]); // Blank separator

      // 4. Links Discovered on this Specific Page
      const pageLinks = pageResult.links || [];
      pageSheet.mergeCells(`A${pageSheet.rowCount + 1}:F${pageSheet.rowCount + 1}`);
      const linksBanner = pageSheet.getCell(`A${pageSheet.rowCount}`);
      linksBanner.value = `🔗 DISCOVERED LINKS ON THIS PAGE (${pageLinks.length} total • ${pageResult.customLinksCount || 0} in content area)`;
      linksBanner.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E40AF' } // Dark Blue
      };
      linksBanner.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      linksBanner.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      pageSheet.getRow(pageSheet.rowCount).height = 26;

      const linkTableHead = pageSheet.addRow(['#', 'Status Code', 'Anchor Text', 'Target URL', 'Link Type', 'In Content Area']);
      linkTableHead.height = 24;
      linkTableHead.eachCell(cell => {
        cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      pageLinks.forEach((l, lIdx) => {
        const linkRow = pageSheet.addRow([
          lIdx + 1,
          l.statusCode || 200,
          l.anchorText || '[Empty / Image]',
          l.url || l.targetUrl,
          l.linkType || 'Internal',
          l.isInsideCustom ? 'YES' : 'NO'
        ]);

        linkRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
        linkRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
        linkRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
        linkRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };

        if (lIdx % 2 === 1) {
          linkRow.eachCell(cell => {
            if (!cell.fill) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
            }
          });
        }
      });

      // Set custom column widths on page sheet
      pageSheet.getColumn(1).width = 24;
      pageSheet.getColumn(2).width = 16;
      pageSheet.getColumn(3).width = 35;
      pageSheet.getColumn(4).width = 48;
      pageSheet.getColumn(5).width = 16;
      pageSheet.getColumn(6).width = 18;
    });

    return await workbook.xlsx.writeBuffer();
  }

  /**
   * Export all crawled pages with general SEO audit & content area data (CSV)
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
   * Export every single discovered link with anchor text, source, target, and location (CSV)
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
      this.escapeCSV(l.targetUrl || l.url),
      this.escapeCSV(l.statusCode || 200),
      this.escapeCSV(l.linkType),
      this.escapeCSV(l.isInsideCustom ? 'YES' : 'NO'),
      this.escapeCSV(l.isNofollow ? 'YES' : 'NO'),
      this.escapeCSV(l.pageDepth)
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\r\n');
  }

  /**
   * Export Content Area-specific report (CSV)
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
