// Application State
const CRAWLER_SESSION_STORAGE_KEY = 'omnicrawl-tab-session';

function createCrawlerSessionId() {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `tab_${randomId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

let crawlerSessionId;
try {
  crawlerSessionId = sessionStorage.getItem(CRAWLER_SESSION_STORAGE_KEY);
  if (!crawlerSessionId) {
    crawlerSessionId = createCrawlerSessionId();
    sessionStorage.setItem(CRAWLER_SESSION_STORAGE_KEY, crawlerSessionId);
  }
} catch (e) {
  crawlerSessionId = createCrawlerSessionId();
}

function crawlerApiUrl(pathname) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set('sessionId', crawlerSessionId);
  return `${url.pathname}${url.search}`;
}

function crawlerFetch(pathname, options) {
  return fetch(crawlerApiUrl(pathname), options);
}

let crawlResults = [];
let allDiscoveredLinks = [];
let activeFilter = 'all';
let activeLinkFilter = 'all';
let currentMainView = 'pages-view';
let searchQuery = '';
let selectedResult = null;
let timerInterval = null;
let accumulatedElapsedMs = 0;
let sessionStartTime = null;
let activeEngine = null;
let activeCapacity = null;

// Sort States
let pagesSort = { column: 'id', direction: 'asc' };
let linksSort = { column: 'id', direction: 'asc' };
let modalLinksSort = { column: 'statusCode', direction: 'asc' };

// Form DOM Elements
const crawlForm = document.getElementById('crawlForm');
const seedUrlInput = document.getElementById('seedUrl');
const crawlScopeSelect = document.getElementById('crawlScope');
const maxPagesInput = document.getElementById('maxPages');
const maxDepthInput = document.getElementById('maxDepth');
const concurrencyInput = document.getElementById('concurrency');
const delayInput = document.getElementById('delay');
const autoScrollInput = document.getElementById('autoScroll');

// Advanced Drawer Elements
const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
const advancedSettings = document.getElementById('advancedSettings');
const regionSelect = document.getElementById('regionSelect');
const proxyInput = document.getElementById('proxyInput');
const blockCrossDomainRedirects = document.getElementById('blockCrossDomainRedirects');
const excludePatternsInput = document.getElementById('excludePatterns');
const includePatternsInput = document.getElementById('includePatterns');
const customContentSelectorInput = document.getElementById('customContentSelector');
const respectRobotsTxtInput = document.getElementById('respectRobotsTxt');

// Action Buttons
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');

// Status Elements
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');

// Executive KPI Metrics
const statCrawled = document.getElementById('statCrawled');
const statProgress = document.getElementById('statProgress');
const statQueued = document.getElementById('statQueued');
const statSpeed = document.getElementById('statSpeed');
const statInternalLinks = document.getElementById('statInternalLinks');
const statExternalLinks = document.getElementById('statExternalLinks');
const statCustomPercent = document.getElementById('statCustomPercent');
const statCustomCount = document.getElementById('statCustomCount');
const statErrors = document.getElementById('statErrors');
const statElapsedTime = document.getElementById('statElapsedTime');

// View Switcher Elements
const viewTabButtons = document.querySelectorAll('.view-tab-btn');
const viewCountPages = document.getElementById('viewCountPages');
const viewCountLinks = document.getElementById('viewCountLinks');
const crawlTableBody = document.getElementById('crawlTableBody');
const allLinksTableBody = document.getElementById('allLinksTableBody');
const contentExplorerLayout = document.getElementById('contentExplorerLayout');

// Search and Filter Elements
const tableSearch = document.getElementById('tableSearch');
const filterTabs = document.querySelectorAll('#pageFilterTabs .tab-pill');
const linkFilterTabs = document.querySelectorAll('#linkFilterTabs .tab-pill');

// Modal Elements
const detailModal = document.getElementById('detailModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const modalUrl = document.getElementById('modalUrl');
const modalTitle = document.getElementById('modalTitle');
const modalMetaDesc = document.getElementById('modalMetaDesc');
const modalCanonical = document.getElementById('modalCanonical');
const modalRobots = document.getElementById('modalRobots');
const modalH1 = document.getElementById('modalH1');
const modalH2 = document.getElementById('modalH2');
const modalWordCount = document.getElementById('modalWordCount');
const modalResponseTime = document.getElementById('modalResponseTime');

const modalCustomBanner = document.getElementById('modalCustomBanner');
const modalCustomSelector = document.getElementById('modalCustomSelector');
const modalCustomHeadings = document.getElementById('modalCustomHeadings');
const modalCustomSnippet = document.getElementById('modalCustomSnippet');
const modalCustomBadge = document.getElementById('modalCustomBadge');

const modalLinksCount = document.getElementById('modalLinksCount');
const modalLinksTableBody = document.getElementById('modalLinksTableBody');
const modalLinksFilter = document.getElementById('modalLinksFilter');

document.querySelectorAll('a[href^="/api/export/"]').forEach(link => {
  link.href = crawlerApiUrl(link.getAttribute('href'));
});

// View Tab Switcher
viewTabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    viewTabButtons.forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));

    btn.classList.add('active');
    currentMainView = btn.getAttribute('data-view');
    document.getElementById(currentMainView).classList.add('active');
    renderCurrentViews();
  });
});

// Toggle Advanced Drawer
toggleAdvancedBtn.addEventListener('click', () => {
  advancedSettings.classList.toggle('hidden');
  const isHidden = advancedSettings.classList.contains('hidden');
  toggleAdvancedBtn.innerHTML = isHidden
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="3"/></svg> Advanced Directives & Exclusions`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg> Collapse Directives`;
});

// Scope Mode Switcher
crawlScopeSelect.addEventListener('change', () => {
  if (crawlScopeSelect.value === 'single-url') {
    maxPagesInput.value = 1;
    maxDepthInput.value = 0;
    maxPagesInput.disabled = true;
    maxDepthInput.disabled = true;
  } else {
    maxPagesInput.disabled = false;
    maxDepthInput.disabled = false;
    if (parseInt(maxPagesInput.value, 10) <= 1) maxPagesInput.value = 50;
    if (parseInt(maxDepthInput.value, 10) === 0) maxDepthInput.value = 3;
  }
});

// SSE Connection & Polling Fallback
let statusPollingInterval = null;

function initEventSource() {
  try {
    const evtSource = new EventSource(crawlerApiUrl('/api/crawler/stream'));

    evtSource.addEventListener('status', async (e) => {
      const data = JSON.parse(e.data);
      activeEngine = data.engine || activeEngine;
      applyCrawlCapacity(data.capacity);
      if (data.stats) updateStats(data.stats, data.queueLength);
      if (data.isRunning) {
        updateUIStatus(data.isPaused ? 'paused' : 'running');
        if (!data.isPaused) startTimer();
        startPolling();
      } else if (data.stats) {
        updateUIStatus('completed');
      }
      await restoreSessionResults();
    });

    evtSource.addEventListener('capacity', (e) => {
      applyCrawlCapacity(JSON.parse(e.data));
      if (statusBadge.classList.contains('ready')) updateUIStatus('ready');
    });

    evtSource.addEventListener('started', () => {
      crawlResults = [];
      allDiscoveredLinks = [];
      activeEngine = { mode: 'initializing', provider: null, error: null };
      accumulatedElapsedMs = 0;
      sessionStartTime = null;
      renderCurrentViews();
      updateUIStatus('running');
      startTimer();
      startPolling();
    });

    evtSource.addEventListener('engineSelected', (e) => {
      activeEngine = JSON.parse(e.data);
      if (statusBadge.classList.contains('running')) updateUIStatus('running');
    });

    evtSource.addEventListener('pageCrawled', (e) => {
      const data = JSON.parse(e.data);
      if (!crawlResults.some(r => r.url === data.result.url)) {
        crawlResults.push(data.result);
      }

      // Aggregate discovered links
      if (data.result.links && data.result.links.length > 0) {
        for (const l of data.result.links) {
          allDiscoveredLinks.push({
            ...l,
            sourceUrl: data.result.url
          });
        }
      }

      updateStats(data.stats, data.queueLength);
      renderCurrentViews();
    });

    evtSource.addEventListener('paused', () => {
      updateUIStatus('paused');
      stopTimer(true);
    });

    evtSource.addEventListener('resumed', () => {
      updateUIStatus('running');
      startTimer();
      startPolling();
    });

    evtSource.addEventListener('stopped', () => {
      updateUIStatus('completed');
      stopTimer(true);
      stopPolling();
    });

    evtSource.addEventListener('reset', () => {
      crawlResults = [];
      allDiscoveredLinks = [];
      activeEngine = null;
      searchQuery = '';
      tableSearch.value = '';
      stopTimer(false);
      stopPolling();
      statElapsedTime.textContent = '00:00';
      statSpeed.textContent = '0.0 req/min';
      updateStats({
        pagesCrawled: 0,
        pagesQueued: 0,
        internalLinksCount: 0,
        externalLinksCount: 0,
        errorsCount: 0,
        customDetectedCount: 0
      }, 0);
      updateUIStatus('ready');
      renderCurrentViews();
    });

    evtSource.addEventListener('completed', (e) => {
      const data = JSON.parse(e.data);
      activeEngine = data.engine || activeEngine;
      updateStats(data.stats, 0);
      updateUIStatus('completed');
      stopTimer(true);
      stopPolling();
      renderCurrentViews();
    });

    evtSource.addEventListener('error', (e) => {
      // SSE reconnecting or buffered by cloud proxy; polling fallback handles this
      startPolling();
    });
  } catch (err) {
    console.warn('SSE not supported or blocked, relying on polling fallback:', err);
    startPolling();
  }
}

// Background Polling Fallback (ensures cloud proxies/Nginx never stall the UI)
function startPolling() {
  if (statusPollingInterval) return;
  statusPollingInterval = setInterval(async () => {
    try {
      const statusRes = await crawlerFetch('/api/crawler/status');
      if (!statusRes.ok) return;
      const statusData = await statusRes.json();
      activeEngine = statusData.engine || activeEngine;
      applyCrawlCapacity(statusData.capacity);

      if (statusData.stats) {
        updateStats(statusData.stats, statusData.queueLength);
      }

      if (statusData.isRunning) {
        if (statusData.isPaused) {
          updateUIStatus('paused');
          stopTimer(true);
        } else {
          updateUIStatus('running');
          startTimer();
        }
        
        // Fetch incremental results
        const resList = await crawlerFetch('/api/crawler/results');
        if (resList.ok) {
          const { results } = await resList.json();
          if (results && results.length > crawlResults.length) {
            crawlResults = results;
            
            // Re-aggregate links
            allDiscoveredLinks = [];
            crawlResults.forEach(r => {
              if (r.links) {
                r.links.forEach(l => {
                  allDiscoveredLinks.push({ ...l, sourceUrl: r.url });
                });
              }
            });
            renderCurrentViews();
          }
        }
      } else if (!statusData.isRunning && crawlResults.length > 0 && (statusBadge.classList.contains('running') || statusBadge.classList.contains('paused'))) {
        updateUIStatus('completed');
        stopTimer(true);
        stopPolling();
        renderCurrentViews();
      }
    } catch (e) {}
  }, 1500);
}

async function restoreSessionResults() {
  try {
    const resultsResponse = await crawlerFetch('/api/crawler/results');
    if (resultsResponse.ok) {
      const data = await resultsResponse.json();
      crawlResults = data.results || [];
      allDiscoveredLinks = [];
      crawlResults.forEach(result => {
        (result.links || []).forEach(link => {
          allDiscoveredLinks.push({ ...link, sourceUrl: result.url });
        });
      });
    }
    renderCurrentViews();
  } catch (e) {}
}

async function restoreSessionState() {
  try {
    const response = await crawlerFetch('/api/crawler/status');
    if (!response.ok) return;
    const status = await response.json();
    activeEngine = status.engine || null;
    applyCrawlCapacity(status.capacity);

    if (!status.stats) {
      updateUIStatus('ready');
      return;
    }

    updateStats(status.stats, status.queueLength);
    await restoreSessionResults();
    if (status.isRunning) {
      updateUIStatus(status.isPaused ? 'paused' : 'running');
      if (!status.isPaused) startTimer();
      startPolling();
    } else {
      updateUIStatus('completed');
    }
  } catch (e) {}
}

function stopPolling() {
  if (statusPollingInterval) {
    clearInterval(statusPollingInterval);
    statusPollingInterval = null;
  }
}

function applyCrawlCapacity(capacity) {
  if (!capacity) return;
  activeCapacity = capacity;
  const workerLimit = Number(capacity.maxWorkersPerCrawl) || 1;
  concurrencyInput.max = String(workerLimit);
  if (Number(concurrencyInput.value) > workerLimit) {
    concurrencyInput.value = String(workerLimit);
  }
}

function updateUIStatus(state) {
  statusBadge.className = `status-pill ${state}`;
  if (state === 'running') {
    if (activeEngine?.mode === 'browser') {
      statusText.textContent = activeEngine.provider === 'sparticuz' ? 'Cloud Browser Active' : 'Browser Engine Active';
    } else if (activeEngine?.mode === 'recovering') {
      statusText.textContent = 'Recovering Browser';
    } else if (activeEngine?.mode === 'http') {
      statusText.textContent = 'Direct DOM Active';
    } else {
      statusText.textContent = 'Starting Engine';
    }
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
    stopBtn.disabled = false;
  } else if (state === 'paused') {
    statusText.textContent = 'Paused';
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume';
    stopBtn.disabled = false;
  } else if (state === 'completed') {
    statusText.textContent = 'Audit Complete';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
    stopBtn.disabled = true;
  } else {
    if (activeCapacity?.availableSlots === 0) {
      statusText.textContent = `Crawl Capacity Full (${activeCapacity.activeCrawls}/${activeCapacity.maxConcurrentCrawls})`;
    } else if (activeCapacity) {
      const slots = activeCapacity.availableSlots;
      statusText.textContent = `System Ready · ${slots} crawl slot${slots === 1 ? '' : 's'} available`;
    } else {
      statusText.textContent = 'System Ready';
    }
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    pauseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
    stopBtn.disabled = true;
  }
}

function updateStats(stats, queueLength) {
  if (!stats) return;
  const maxPages = parseInt(maxPagesInput.value, 10) || 50;
  
  statCrawled.textContent = Number(stats.pagesCrawled).toLocaleString();
  statQueued.textContent = Number(queueLength || 0).toLocaleString();
  statInternalLinks.textContent = Number(stats.internalLinksCount || 0).toLocaleString();
  statExternalLinks.textContent = Number(stats.externalLinksCount || 0).toLocaleString();
  statErrors.textContent = Number((stats.errorsCount || 0) + (stats.blockedByRobotsCount || 0)).toLocaleString();

  const percentProgress = Math.min(100, Math.round((stats.pagesCrawled / maxPages) * 100));
  statProgress.textContent = `${percentProgress}% of limit (${maxPages})`;

  const customCount = stats.customDetectedCount || 0;
  statCustomCount.textContent = customCount.toLocaleString();
  const customPercent = stats.pagesCrawled > 0 ? Math.round((customCount / stats.pagesCrawled) * 100) : 0;
  statCustomPercent.textContent = `${customPercent}% of crawled`;

  viewCountPages.textContent = stats.pagesCrawled;
  viewCountLinks.textContent = stats.internalLinksCount + stats.externalLinksCount;

  // Filter Counts
  const elAll = document.getElementById('filterCountAll');
  if (elAll) elAll.textContent = stats.pagesCrawled;
  const elCustom = document.getElementById('filterCountCustom');
  if (elCustom) elCustom.textContent = customCount;
  const elMissing = document.getElementById('filterCountMissingCustom');
  if (elMissing) elMissing.textContent = Math.max(0, stats.pagesCrawled - customCount);
  const elErr = document.getElementById('filterCountError');
  if (elErr) elErr.textContent = stats.errorsCount;

  // Calculate Link Filters for Link sub-tabs
  let internalLinks = 0;
  let externalLinks = 0;
  let inContentLinks = 0;
  let ok200Links = 0;
  let errLinks = 0;
  let nofollowLinks = 0;

  for (const l of allDiscoveredLinks) {
    if (l.isInternal) internalLinks++;
    else externalLinks++;
    if (l.isInsideCustom) inContentLinks++;
    if (l.statusCode === 200) ok200Links++;
    if (l.statusCode >= 400) errLinks++;
    if (l.isNofollow) nofollowLinks++;
  }

  const elLinksAll = document.getElementById('filterLinksAll');
  if (elLinksAll) elLinksAll.textContent = allDiscoveredLinks.length;
  const elInternal = document.getElementById('filterLinksInternal');
  if (elInternal) elInternal.textContent = internalLinks;
  const elExternal = document.getElementById('filterLinksExternal');
  if (elExternal) elExternal.textContent = externalLinks;
  const elInContent = document.getElementById('filterLinksInContent');
  if (elInContent) elInContent.textContent = inContentLinks;
  const el200 = document.getElementById('filterLinks200');
  if (el200) el200.textContent = ok200Links;
  const elError = document.getElementById('filterLinksError');
  if (elError) elError.textContent = errLinks;
  const elNofollow = document.getElementById('filterLinksNofollow');
  if (elNofollow) elNofollow.textContent = nofollowLinks;
}

function startTimer() {
  if (timerInterval) return;
  sessionStartTime = Date.now();
  timerInterval = setInterval(() => {
    const currentSessionMs = sessionStartTime ? (Date.now() - sessionStartTime) : 0;
    const totalElapsedSec = Math.floor((accumulatedElapsedMs + currentSessionMs) / 1000);
    const mins = String(Math.floor(totalElapsedSec / 60)).padStart(2, '0');
    const secs = String(totalElapsedSec % 60).padStart(2, '0');
    statElapsedTime.textContent = `${mins}:${secs}`;
    
    if (totalElapsedSec > 0 && crawlResults.length > 0) {
      const speed = Math.round((crawlResults.length / (totalElapsedSec / 60)) * 10) / 10;
      statSpeed.textContent = `${speed} req/min`;
    }
  }, 1000);
}

function stopTimer(freeze = false) {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (sessionStartTime) {
    accumulatedElapsedMs += Date.now() - sessionStartTime;
    sessionStartTime = null;
  }
  if (!freeze) {
    accumulatedElapsedMs = 0;
  }
}

// Master Render Function
function renderCurrentViews() {
  renderPagesTable();
  renderAllLinksTable();
  renderContentView();
}

// VIEW 1: Pages Table
function renderPagesTable() {
  let filtered = crawlResults.filter(r => {
    const q = searchQuery.toLowerCase();
    const matchSearch = !q || r.url.toLowerCase().includes(q) || (r.title && r.title.toLowerCase().includes(q)) || String(r.statusCode).includes(q);
    if (!matchSearch) return false;

    if (activeFilter === '200') return r.statusCode === 200;
    if (activeFilter === 'custom') return r.customContent?.detected;
    if (activeFilter === 'missing-custom') return !r.customContent?.detected;
    if (activeFilter === 'error') return r.statusCode >= 400 || r.error;
    return true;
  });

  // Sort Pages Table
  filtered.sort((a, b) => {
    let valA, valB;
    switch (pagesSort.column) {
      case 'id':
        valA = a.id || 0;
        valB = b.id || 0;
        break;
      case 'statusCode':
        valA = a.statusCode || 0;
        valB = b.statusCode || 0;
        break;
      case 'url':
        valA = a.url || '';
        valB = b.url || '';
        break;
      case 'title':
        valA = a.title || '';
        valB = b.title || '';
        break;
      case 'contentArea':
        valA = a.customContent?.wordCount || 0;
        valB = b.customContent?.wordCount || 0;
        break;
      case 'internalLinks':
        valA = a.internalLinksCount || 0;
        valB = b.internalLinksCount || 0;
        break;
      case 'latency':
        valA = a.responseTimeMs || 0;
        valB = b.responseTimeMs || 0;
        break;
      default:
        valA = a.id || 0;
        valB = b.id || 0;
    }

    if (typeof valA === 'string') {
      return pagesSort.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return pagesSort.direction === 'asc' ? valA - valB : valB - valA;
  });

  // Update table header sort indicators
  document.querySelectorAll('#crawlTable .sortable-th').forEach(th => {
    const col = th.getAttribute('data-sort');
    th.classList.remove('sorted-asc', 'sorted-desc');
    const icon = th.querySelector('.sort-icon');
    if (col === pagesSort.column) {
      th.classList.add(pagesSort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
      if (icon) icon.textContent = pagesSort.direction === 'asc' ? '▲' : '▼';
    } else {
      if (icon) icon.textContent = '↕';
    }
  });

  if (filtered.length === 0) {
    crawlTableBody.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="8">
          <div class="empty-state">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <p>${crawlResults.length === 0 ? 'No records collected yet.' : 'No audit records match the current filter query.'}</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  crawlTableBody.innerHTML = filtered.map((r, idx) => {
    const statusClass = r.statusCode === 200 ? 'status-200' : (r.statusCode >= 300 && r.statusCode < 400 ? 'status-3xx' : 'status-4xx');
    const customBadge = r.customContent?.detected
      ? `<span class="status-code-badge badge-target-yes">Found (${r.customContent.wordCount}w)</span>`
      : `<span class="status-code-badge badge-target-no">None</span>`;

    return `
      <tr data-url="${encodeURIComponent(r.url)}">
        <td style="color: var(--text-dim); font-family: var(--font-mono); font-size: 0.72rem;">${r.id || idx + 1}</td>
        <td><span class="status-code-badge ${statusClass}">${r.statusCode || 'ERR'}</span></td>
        <td class="url-cell" title="${r.url}">${r.url}</td>
        <td class="title-cell" title="${r.title || '[No Title Tag]'}">${r.title || '<span style="color: var(--text-dim)">[No Title Tag]</span>'}</td>
        <td>${customBadge}</td>
        <td>
          <span style="font-weight: 600; color: #1d4ed8; font-family: var(--font-mono); font-size: 0.76rem;">${r.internalLinksCount || 0} links</span>
          <span style="color: var(--text-dim); font-size: 0.72rem;"> (${r.customLinksCount || 0} in content area)</span>
        </td>
        <td style="font-family: var(--font-mono); font-size: 0.76rem; color: var(--text-secondary);">${r.responseTimeMs}ms</td>
        <td style="text-align: right;">
          <button class="btn btn-sm btn-outline inspect-btn">Inspect</button>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('#crawlTableBody tr').forEach(row => {
    row.addEventListener('click', () => {
      const raw = row.getAttribute('data-url');
      if (!raw) return;
      const url = decodeURIComponent(raw);
      const item = crawlResults.find(r => r.url === url);
      if (item) openDetailModal(item);
    });
  });
}

// VIEW 2: All Discovered Links Table (Direct full links explorer with column sorting)
function renderAllLinksTable() {
  const q = searchQuery.toLowerCase();
  let filtered = allDiscoveredLinks.filter(l => {
    // 1. Search Query
    const matchSearch = !q ||
      l.anchorText.toLowerCase().includes(q) ||
      l.url.toLowerCase().includes(q) ||
      (l.sourceUrl && l.sourceUrl.toLowerCase().includes(q)) ||
      String(l.statusCode || '').includes(q);
    if (!matchSearch) return false;

    // 2. Link Sub-filter Pill
    if (activeLinkFilter === 'internal') return l.linkType === 'Internal';
    if (activeLinkFilter === 'external') return l.linkType === 'External';
    if (activeLinkFilter === 'in-content') return l.isInsideCustom;
    if (activeLinkFilter === '200') return l.statusCode === 200;
    if (activeLinkFilter === 'error') return l.statusCode >= 400 || l.statusCode === 0 || l.statusCode === 500;
    if (activeLinkFilter === 'nofollow') return l.isNofollow;
    return true;
  });

  // Sort Links Table
  filtered.sort((a, b) => {
    let valA, valB;
    switch (linksSort.column) {
      case 'id':
        valA = allDiscoveredLinks.indexOf(a);
        valB = allDiscoveredLinks.indexOf(b);
        break;
      case 'statusCode':
        valA = a.statusCode || 0;
        valB = b.statusCode || 0;
        break;
      case 'anchorText':
        valA = a.anchorText || '';
        valB = b.anchorText || '';
        break;
      case 'url':
        valA = a.url || '';
        valB = b.url || '';
        break;
      case 'linkType':
        valA = a.linkType || '';
        valB = b.linkType || '';
        break;
      case 'isInsideCustom':
        valA = a.isInsideCustom ? 1 : 0;
        valB = b.isInsideCustom ? 1 : 0;
        break;
      case 'isNofollow':
        valA = a.isNofollow ? 1 : 0;
        valB = b.isNofollow ? 1 : 0;
        break;
      case 'sourceUrl':
        valA = a.sourceUrl || '';
        valB = b.sourceUrl || '';
        break;
      default:
        valA = 0;
        valB = 0;
    }

    if (typeof valA === 'string') {
      return linksSort.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return linksSort.direction === 'asc' ? valA - valB : valB - valA;
  });

  // Update header sort indicators
  document.querySelectorAll('#allLinksTable .sortable-th').forEach(th => {
    const col = th.getAttribute('data-sort');
    th.classList.remove('sorted-asc', 'sorted-desc');
    const icon = th.querySelector('.sort-icon');
    if (col === linksSort.column) {
      th.classList.add(linksSort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
      if (icon) icon.textContent = linksSort.direction === 'asc' ? '▲' : '▼';
    } else {
      if (icon) icon.textContent = '↕';
    }
  });

  if (filtered.length === 0) {
    allLinksTableBody.innerHTML = `
      <tr class="empty-state-row">
        <td colspan="8">
          <div class="empty-state">
            <p>${allDiscoveredLinks.length === 0 ? 'No links discovered yet. Run a crawl to extract on-page links.' : 'No links match the search or filter query.'}</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  allLinksTableBody.innerHTML = filtered.map((l, idx) => {
    const isInternal = l.linkType === 'Internal';
    const typeBadgeClass = isInternal ? 'status-200' : 'badge-target-no';
    const statusCode = l.statusCode || 200;
    const statusClass = statusCode === 200 ? 'status-200' : (statusCode >= 300 && statusCode < 400 ? 'status-3xx' : 'status-4xx');

    return `
      <tr>
        <td style="color: var(--text-dim); font-family: var(--font-mono); font-size: 0.72rem;">${idx + 1}</td>
        <td><span class="status-code-badge ${statusClass}">${statusCode}</span></td>
        <td style="font-weight: 500; color: var(--text-primary); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${l.anchorText}">${l.anchorText}</td>
        <td class="url-cell" style="max-width: 360px;" title="${l.url}">
          <a href="${l.url}" target="_blank" rel="noopener noreferrer" style="color: #1d4ed8; text-decoration: none;">${l.url} ↗</a>
        </td>
        <td><span class="status-code-badge ${typeBadgeClass}">${l.linkType}</span></td>
        <td>${l.isInsideCustom ? '<span class="status-code-badge badge-target-yes">YES</span>' : '<span style="color: var(--text-dim)">No</span>'}</td>
        <td style="font-family: var(--font-mono); font-size: 0.74rem;">${l.isNofollow ? 'nofollow' : 'dofollow'}</td>
        <td class="url-cell" style="max-width: 220px; color: var(--text-muted);" title="${l.sourceUrl || ''}">${l.sourceUrl || '-'}</td>
      </tr>
    `;
  }).join('');
}

// VIEW 3: Page Content & SEO Text Explorer
function renderContentView() {
  if (crawlResults.length === 0) {
    contentExplorerLayout.innerHTML = `
      <div class="empty-state" style="padding: 40px;">
        <p>No content extracted yet. Run a crawl to view extracted SEO text blocks.</p>
      </div>
    `;
    return;
  }

  contentExplorerLayout.innerHTML = crawlResults.map((r, idx) => {
    const headings = r.customContent?.headings || r.h1List || [];
    const fullText = r.customContent?.fullText || r.customContent?.textSnippet || r.fullPageText || '[No content text extracted]';
    const wordCount = r.customContent?.wordCount || r.totalWords || 0;

    return `
      <div class="content-page-card">
        <div class="content-card-header">
          <div>
            <span class="content-card-url">${r.url}</span>
            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">
              <strong>${r.title || 'No Title Tag'}</strong> • ${wordCount.toLocaleString()} words • ${r.internalLinksCount || 0} internal links (${r.customLinksCount || 0} in content area)
            </div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="btn btn-sm btn-outline copy-text-btn" data-idx="${idx}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy Full Text
            </button>
            <span class="status-code-badge ${r.customContent?.detected ? 'badge-target-yes' : 'badge-target-no'}">
              ${r.customContent?.detected ? 'Content Area Detected' : 'Full Page Text'}
            </span>
          </div>
        </div>

        <div>
          <span class="property-label">Headings Extracted (${headings.length}):</span>
          <div class="headings-tag-list">
            ${headings.length > 0 ? headings.map(h => `<span class="heading-tag">${h}</span>`).join('') : '<span style="color: var(--text-dim); font-size: 0.75rem;">No headings detected</span>'}
          </div>
        </div>

        <div>
          <span class="property-label">All Content Area Text (${wordCount.toLocaleString()} words):</span>
          <div class="content-body-box">${fullText}</div>
        </div>
      </div>
    `;
  }).join('');

  // Attach copy listeners
  document.querySelectorAll('.copy-text-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      const r = crawlResults[idx];
      if (r) {
        const textToCopy = r.customContent?.fullText || r.customContent?.textSnippet || r.fullPageText || '';
        navigator.clipboard.writeText(textToCopy).then(() => {
          const orig = btn.innerHTML;
          btn.innerHTML = '✓ Copied!';
          setTimeout(() => btn.innerHTML = orig, 2000);
        });
      }
    });
  });
}

// Modal Inspector
function openDetailModal(item) {
  selectedResult = item;
  modalPageUrl.textContent = item.url;
  modalStatusBadge.textContent = item.statusCode || 'ERR';
  modalStatusBadge.className = `status-code-badge ${item.statusCode === 200 ? 'status-200' : 'status-4xx'}`;

  // Overview Tab
  modalTitle.textContent = item.title || '[Empty Title Tag]';
  modalDescription.textContent = item.metaDescription || '[No Meta Description Set]';
  modalCanonical.textContent = item.canonical || '[No Canonical URL Specified]';
  modalRobots.textContent = item.metaRobots || '[Standard Index, Follow - No Explicit Directive]';
  modalH1.textContent = item.h1List && item.h1List.length > 0 ? item.h1List.join(' | ') : '[No H1 Tag Found]';
  modalH2.textContent = item.h2List && item.h2List.length > 0 ? item.h2List.slice(0, 6).join(' • ') : '[No H2 Tags Found]';
  modalWordCount.textContent = `${(item.totalWords || 0).toLocaleString()} words • ${item.imagesCount || 0} images`;
  modalResponseTime.textContent = `${item.responseTimeMs} ms`;

  // Content Area Tab - Extract ALL content area text
  const fullContentText = item.customContent?.fullText || item.customContent?.textSnippet || item.fullPageText || 'No matching content block found.';
  
  if (item.customContent?.detected) {
    modalCustomBanner.className = 'alert-banner found';
    modalCustomBanner.innerHTML = `Content Area Verified (${item.customContent.wordCount.toLocaleString()} words extracted in full)`;
    modalCustomSelector.textContent = item.customContent.selectorUsed || 'Auto-detected';
    modalCustomHeadings.textContent = item.customContent.headings?.length ? item.customContent.headings.join(' • ') : '[No Sub-headings inside content area]';
    modalCustomSnippet.textContent = fullContentText;
    modalCustomBadge.textContent = '• Active';
  } else {
    modalCustomBanner.className = 'alert-banner missing';
    modalCustomBanner.innerHTML = `Content Area Not Detected`;
    modalCustomSelector.textContent = '-';
    modalCustomHeadings.textContent = '-';
    modalCustomSnippet.textContent = fullContentText;
    modalCustomBadge.textContent = '';
  }

  // Links Tab
  modalLinksCount.textContent = item.links ? item.links.length : 0;
  renderModalLinks(item.links || []);

  detailModal.classList.remove('hidden');
}

function renderModalLinks(links) {
  const filterVal = (modalLinksFilter.value || '').toLowerCase();
  let filtered = links.filter(l => !filterVal ||
    l.anchorText.toLowerCase().includes(filterVal) ||
    l.url.toLowerCase().includes(filterVal) ||
    String(l.statusCode || '').includes(filterVal)
  );

  // Sort Modal Links
  filtered.sort((a, b) => {
    let valA, valB;
    switch (modalLinksSort.column) {
      case 'statusCode':
        valA = a.statusCode || 0;
        valB = b.statusCode || 0;
        break;
      case 'anchorText':
        valA = a.anchorText || '';
        valB = b.anchorText || '';
        break;
      case 'url':
        valA = a.url || '';
        valB = b.url || '';
        break;
      case 'linkType':
        valA = a.linkType || '';
        valB = b.linkType || '';
        break;
      case 'isInsideCustom':
        valA = a.isInsideCustom ? 1 : 0;
        valB = b.isInsideCustom ? 1 : 0;
        break;
      default:
        valA = 0;
        valB = 0;
    }

    if (typeof valA === 'string') {
      return modalLinksSort.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return modalLinksSort.direction === 'asc' ? valA - valB : valB - valA;
  });

  // Update modal header sort indicators
  document.querySelectorAll('#modalLinksTable .modal-sortable-th').forEach(th => {
    const col = th.getAttribute('data-sort');
    th.classList.remove('sorted-asc', 'sorted-desc');
    const icon = th.querySelector('.sort-icon');
    if (col === modalLinksSort.column) {
      th.classList.add(modalLinksSort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
      if (icon) icon.textContent = modalLinksSort.direction === 'asc' ? '▲' : '▼';
    } else {
      if (icon) icon.textContent = '↕';
    }
  });

  if (!filtered.length) {
    modalLinksTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 24px;">No matching link records.</td></tr>`;
    return;
  }

  modalLinksTableBody.innerHTML = filtered.map(l => {
    const statusCode = l.statusCode || 200;
    const statusClass = statusCode === 200 ? 'status-200' : (statusCode >= 300 && statusCode < 400 ? 'status-3xx' : 'status-4xx');

    return `
      <tr>
        <td><span class="status-code-badge ${statusClass}">${statusCode}</span></td>
        <td style="font-weight: 500; color: var(--text-primary);">${l.anchorText}</td>
        <td class="url-cell" style="max-width: 300px;" title="${l.url}">
          <a href="${l.url}" target="_blank" rel="noopener noreferrer" style="color: #1d4ed8; text-decoration: none;">${l.url} ↗</a>
        </td>
        <td><span class="status-code-badge ${l.linkType === 'Internal' ? 'status-200' : 'badge-target-no'}">${l.linkType}</span></td>
        <td>${l.isInsideCustom ? '<span class="status-code-badge badge-target-yes">YES</span>' : '<span style="color: var(--text-dim)">No</span>'}</td>
      </tr>
    `;
  }).join('');
}

modalLinksFilter.addEventListener('input', () => {
  if (selectedResult) renderModalLinks(selectedResult.links || []);
});

// Modal Links Header Sort Click Listener
document.querySelectorAll('#modalLinksTable .modal-sortable-th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-sort');
    if (modalLinksSort.column === col) {
      modalLinksSort.direction = modalLinksSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      modalLinksSort.column = col;
      modalLinksSort.direction = 'asc';
    }
    if (selectedResult) renderModalLinks(selectedResult.links || []);
  });
});

// Pages Table Header Sort Click Listener
document.querySelectorAll('#crawlTable .sortable-th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-sort');
    if (pagesSort.column === col) {
      pagesSort.direction = pagesSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      pagesSort.column = col;
      pagesSort.direction = 'asc';
    }
    renderPagesTable();
  });
});

// Discovered Links Table Header Sort Click Listener
document.querySelectorAll('#allLinksTable .sortable-th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-sort');
    if (linksSort.column === col) {
      linksSort.direction = linksSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      linksSort.column = col;
      linksSort.direction = 'asc';
    }
    renderAllLinksTable();
  });
});

// Link Filter Sub-tabs Listener
document.querySelectorAll('#linkFilterTabs .tab-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#linkFilterTabs .tab-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeLinkFilter = pill.getAttribute('data-linkfilter');
    renderAllLinksTable();
  });
});

// Modal Tabs
document.querySelectorAll('.modal-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.modal-tab-pane').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(tabId).classList.add('active');
  });
});

closeModalBtn.addEventListener('click', () => detailModal.classList.add('hidden'));
detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) detailModal.classList.add('hidden');
});

// Form Submit
crawlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let seedUrl = seedUrlInput.value.trim();
  if (!seedUrl) return;

  if (!seedUrl.startsWith('http://') && !seedUrl.startsWith('https://')) {
    seedUrl = 'https://' + seedUrl;
    seedUrlInput.value = seedUrl;
  }

  startTime = Date.now();
  updateUIStatus('running');

  const excludePatterns = excludePatternsInput.value.split('\n').map(s => s.trim()).filter(Boolean);
  const includePatterns = includePatternsInput.value.split('\n').map(s => s.trim()).filter(Boolean);

  try {
    const res = await crawlerFetch('/api/crawler/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seedUrl,
        crawlScope: crawlScopeSelect.value,
        customContentSelector: customContentSelectorInput.value.trim(),
        excludePatterns,
        includePatterns,
        respectRobotsTxt: respectRobotsTxtInput.checked,
        maxPages: parseInt(maxPagesInput.value, 10) || 50,
        maxDepth: parseInt(maxDepthInput.value, 10) || 3,
        concurrency: parseInt(concurrencyInput.value, 10) || 1,
        delayBetweenRequestsMs: parseInt(delayInput.value, 10) || 500,
        autoScroll: autoScrollInput.checked,
        region: regionSelect ? regionSelect.value : 'auto',
        proxy: proxyInput ? proxyInput.value.trim() : '',
        blockCrossDomainRedirects: blockCrossDomainRedirects ? blockCrossDomainRedirects.checked : true
      })
    });

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}. If the app was just deploying, please wait a few seconds and try again.`);
      }
      throw parseErr;
    }

    applyCrawlCapacity(data.capacity);

    if (data.error) {
      alert(data.error);
      updateUIStatus('ready');
    }
  } catch (err) {
    alert('Failed to start crawler: ' + err.message);
    updateUIStatus('ready');
  }
});

pauseBtn.addEventListener('click', async () => {
  pauseBtn.disabled = true;
  try {
    if (pauseBtn.textContent.includes('Pause')) {
      updateUIStatus('paused');
      stopTimer(true);
      await crawlerFetch('/api/crawler/pause', { method: 'POST' });
    } else {
      updateUIStatus('running');
      startTimer();
      startPolling();
      await crawlerFetch('/api/crawler/resume', { method: 'POST' });
    }
  } catch (err) {
    console.error('Pause/Resume toggle failed:', err);
  } finally {
    pauseBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  await crawlerFetch('/api/crawler/stop', { method: 'POST' });
});

resetBtn.addEventListener('click', async () => {
  try {
    await crawlerFetch('/api/crawler/reset', { method: 'POST' });
  } catch (e) {}

  crawlResults = [];
  allDiscoveredLinks = [];
  activeEngine = null;
  searchQuery = '';
  tableSearch.value = '';
  activeFilter = 'all';

  filterTabs.forEach(p => {
    if (p.getAttribute('data-filter') === 'all') {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  stopTimer(false);
  stopPolling();
  statElapsedTime.textContent = '00:00';
  statSpeed.textContent = '0.0 req/min';
  accumulatedElapsedMs = 0;
  sessionStartTime = null;

  updateStats({
    pagesCrawled: 0,
    pagesQueued: 0,
    internalLinksCount: 0,
    externalLinksCount: 0,
    errorsCount: 0,
    customDetectedCount: 0
  }, 0);

  updateUIStatus('ready');
  renderCurrentViews();
});

tableSearch.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderCurrentViews();
});

filterTabs.forEach(pill => {
  pill.addEventListener('click', () => {
    filterTabs.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter = pill.getAttribute('data-filter');
    renderCurrentViews();
  });
});

// Initialize on Load
restoreSessionState().finally(initEventSource);
