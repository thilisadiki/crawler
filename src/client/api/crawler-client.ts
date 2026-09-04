import type { CrawlConfig, CrawlerStatus, CrawlPage, CrawledLink, CrawlHistoryDetail, CrawlHistoryRecord, HtmlComparisonCapture } from '../types/crawl';

// Reuses the established tab session key, so opening /next/ in the same browser
// tab resumes the exact crawl rather than silently creating a second one.
const SESSION_KEY = 'omnicrawl-tab-session';

function getSessionId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function apiUrl(path: string) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('sessionId', getSessionId());
  return url.toString();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Crawler-Session': getSessionId(), ...init.headers }
  });
  const body = await response.json().catch(() => ({ error: 'The server returned an invalid response.' }));
  if (!response.ok) throw new Error(body.error || 'Crawler request failed.');
  return body as T;
}

export const crawlerClient = {
  status: () => request<CrawlerStatus>('/api/crawler/status'),
  results: () => request<{ results: CrawlPage[] }>('/api/crawler/results'),
  links: () => request<{ links: CrawledLink[] }>('/api/crawler/links'),
  pageHtml: (url: string) => request<HtmlComparisonCapture>(`/api/crawler/page-html?url=${encodeURIComponent(url)}`),
  history: () => request<{ crawls: CrawlHistoryRecord[]; storage: { configured?: boolean; connected?: boolean } }>('/api/crawler/history'),
  historyDetail: (crawlId: string) => request<CrawlHistoryDetail>(`/api/crawler/history/${encodeURIComponent(crawlId)}`),
  restoreHistory: (crawlId: string) => request<{ success: boolean; restoredPages: number; crawl: { seedUrl: string; config?: Partial<CrawlConfig> } }>(`/api/crawler/history/${encodeURIComponent(crawlId)}/restore`, { method: 'POST', body: '{}' }),
  start: (config: CrawlConfig) => request<{ success: boolean }>('/api/crawler/start', { method: 'POST', body: JSON.stringify(config) }),
  pause: () => request<{ success: boolean }>('/api/crawler/pause', { method: 'POST', body: '{}' }),
  resume: () => request<{ success: boolean }>('/api/crawler/resume', { method: 'POST', body: '{}' }),
  stop: () => request<{ success: boolean }>('/api/crawler/stop', { method: 'POST', body: '{}' }),
  reset: () => request<{ success: boolean }>('/api/crawler/reset', { method: 'POST', body: '{}' }),
  streamUrl: () => apiUrl('/api/crawler/stream'),
  exportUrl: (path: string) => apiUrl(path)
};
