import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { getSeoIssues } from './src/client/features/issues/issueRules.ts';
import { Exporter } from './src/engine/exporter.js';

function healthyPage(path, overrides = {}) {
  const url = `https://example.com/${path}`;
  return {
    url, statusCode: 200, title: `A useful descriptive page title for ${path}`,
    metaDescription: `This is a useful and sufficiently detailed description of the information available on the ${path} page.`,
    h1: path, canonical: url, totalWords: 400, ...overrides
  };
}

test('shared rules retain all 18 existing issue categories', () => {
  const duplicateText = 'editorial '.repeat(100);
  const pages = [
    healthyPage('missing', { title: '', metaDescription: '', h1: '', canonical: '', totalWords: 20 }),
    healthyPage('short', { title: 'Short', metaDescription: 'Short' }),
    healthyPage('long', { title: 'T'.repeat(61), metaDescription: 'D'.repeat(161), h1List: ['First', 'Second'], canonical: 'https://example.com/elsewhere', metaRobots: 'follow, noindex' }),
    healthyPage('copy-one', { title: 'Same title', metaDescription: 'Same description', fullPageText: duplicateText }),
    healthyPage('copy-two', { title: 'SAME TITLE', metaDescription: 'SAME DESCRIPTION', fullPageText: duplicateText.toUpperCase() }),
    { url: 'https://example.com/blocked', statusCode: 403 }
  ];
  const links = [
    { sourceUrl: pages[0].url, targetUrl: '/broken', linkType: 'Internal', statusCode: 404 },
    { sourceUrl: pages[1].url, targetUrl: '/old', isInternal: true, statusCode: 301, redirectChain: [{ url: '/old', statusCode: 301, destinationUrl: '/new' }], finalUrl: '/new' }
  ];
  const issues = getSeoIssues(pages, links);
  assert.deepEqual(new Set(issues.map(issue => issue.code)), new Set([
    'page-error', 'broken-internal-link', 'redirected-internal-link', 'missing-title', 'duplicate-title',
    'title-too-short', 'title-too-long', 'missing-description', 'duplicate-description', 'duplicate-content',
    'description-too-short', 'description-too-long', 'missing-h1', 'multiple-h1', 'missing-canonical',
    'canonical-mismatch', 'noindex', 'thin-content'
  ]));
  assert.equal(issues.filter(issue => issue.code === 'duplicate-content').length, 2);
  assert.deepEqual(issues.filter(issue => issue.url.endsWith('/blocked')).map(issue => issue.code), ['page-error']);
  assert.deepEqual(Exporter.getSEOIssues(pages, links), issues);
});

test('thresholds and content-area versus full-page duplicate matching are preserved', () => {
  const bounds = [
    healthyPage('lower', { title: 'T'.repeat(30), metaDescription: 'D'.repeat(70), totalWords: 300 }),
    healthyPage('upper', { title: 'T'.repeat(60), metaDescription: 'D'.repeat(160), totalWords: 300 })
  ];
  assert.deepEqual(getSeoIssues(bounds, []), []);
  const text = 'word '.repeat(99);
  const shortCopies = [healthyPage('one', { fullPageText: text }), healthyPage('two', { fullPageText: text })];
  assert.equal(getSeoIssues(shortCopies, []).filter(issue => issue.code === 'duplicate-content').length, 0);
  const content = 'word '.repeat(100);
  const separateSources = [healthyPage('full', { fullPageText: content }), healthyPage('area', { customContent: { fullText: content, wordCount: 100 } })];
  assert.equal(getSeoIssues(separateSources, []).filter(issue => issue.code === 'duplicate-content').length, 0);
});

test('CSV and XLSX issues match the dashboard, including quoted text and missing link sources', async () => {
  const pages = [healthyPage('report', { title: 'Short, "quoted" title', metaDescription: 'Description with\na line break', totalWords: 299 })];
  const links = [{ targetUrl: 'https://example.com/broken', isInternal: true, statusCode: 0 }];
  const expected = getSeoIssues(pages, links);
  const before = structuredClone({ pages, links });
  assert.equal(expected.find(issue => issue.code === 'broken-internal-link').url, 'Unknown source page');

  const csvBook = new ExcelJS.Workbook();
  const csvSheet = await csvBook.csv.read(Readable.from([Exporter.generateIssuesCSV(pages, links)]));
  const csvRows = [];
  csvSheet.eachRow((row, n) => { if (n > 1) csvRows.push(row.values.slice(1)); });
  assert.deepEqual(csvRows, expected.map(i => [i.severity, i.label, i.code, i.description, i.url, i.detail]));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await Exporter.generateMultiSheetWorkbook(pages, links));
  const rows = [];
  workbook.getWorksheet('SEO Issues').eachRow((row, n) => { if (n > 1) rows.push(row.values.slice(2)); });
  assert.deepEqual(rows, expected.map(i => [i.severity, i.label, i.code, i.url, i.detail]));
  assert.deepEqual({ pages, links }, before, 'Issue analysis and exports must not mutate audit data');
});
