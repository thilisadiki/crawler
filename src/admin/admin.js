const confirmation = document.getElementById('confirmation');
const clear = document.getElementById('clear');
const message = document.getElementById('message');
const overviewMessage = document.getElementById('overviewMessage');
const overviewContent = document.getElementById('overviewContent');
const refreshOverview = document.getElementById('refreshOverview');
const refreshSessions = document.getElementById('refreshSessions');
const sessionsMessage = document.getElementById('sessionsMessage');
const sessionsTable = document.getElementById('sessionsTable');
const refreshEvents = document.getElementById('refreshEvents');
const eventsMessage = document.getElementById('eventsMessage');
const eventsTable = document.getElementById('eventsTable');
const previousEvents = document.getElementById('previousEvents');
const nextEvents = document.getElementById('nextEvents');
const eventsPageInfo = document.getElementById('eventsPageInfo');
const createAuditorForm = document.getElementById('createAuditorForm');
const auditorUsername = document.getElementById('auditorUsername');
const auditorPassword = document.getElementById('auditorPassword');
const refreshAuditors = document.getElementById('refreshAuditors');
const auditorsMessage = document.getElementById('auditorsMessage');
const auditorsTable = document.getElementById('auditorsTable');
const refreshCrawls = document.getElementById('refreshCrawls');
const crawlsMessage = document.getElementById('crawlsMessage');
const crawlsTable = document.getElementById('crawlsTable');
const formatNumber = value => Number(value || 0).toLocaleString();
const formatBytes = value => {
  const bytes = Number(value || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${units[unit]}`;
};
const formatDate = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const escapeHtml = value => String(value || '—').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const describeDevice = userAgent => {
  const value = String(userAgent || '');
  const browser = /Edg\//.test(value) ? 'Microsoft Edge' : /Firefox\//.test(value) ? 'Firefox' : /Chrome\//.test(value) ? 'Chrome' : /Safari\//.test(value) ? 'Safari' : 'Unknown browser';
  const device = /iPhone/.test(value) ? 'iPhone' : /iPad/.test(value) ? 'iPad' : /Android/.test(value) ? 'Android device' : /Windows/.test(value) ? 'Windows device' : /Macintosh/.test(value) ? 'Mac' : /Linux/.test(value) ? 'Linux device' : 'Unknown device';
  return `${browser} on ${device}`;
};

async function loadOverview() {
  refreshOverview.disabled = true;
  overviewMessage.textContent = 'Loading saved-crawl storage details…';
  overviewContent.classList.add('hidden');
  try {
    const response = await fetch('/api/admin/database-overview', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load database details.');
    const { counts, dates, totals, latestCrawl, tables } = data;
    document.getElementById('databaseSize').textContent = formatBytes(totals.totalBytes);
    document.getElementById('crawlCount').textContent = formatNumber(counts.crawls);
    document.getElementById('pageCount').textContent = formatNumber(counts.pages);
    document.getElementById('linkCount').textContent = formatNumber(counts.links);
    document.getElementById('securityEventCount').textContent = formatNumber(counts.securityEvents);
    document.getElementById('resourceCount').textContent = formatNumber(counts.resources);
    document.getElementById('contentTextSize').textContent = formatBytes(counts.fullPageTextChars + counts.contentAreaTextChars);
    document.getElementById('oldestCrawl').textContent = formatDate(dates.oldestCrawlAt);
    document.getElementById('newestCrawl').textContent = formatDate(dates.newestCrawlAt);
    document.getElementById('databaseName').textContent = data.database || 'Configured MySQL database';
    document.getElementById('latestTarget').textContent = latestCrawl?.seedUrl || '—';
    document.getElementById('latestStatus').textContent = latestCrawl?.status || '—';
    document.getElementById('databaseTables').innerHTML = tables.map(table => `<tr><td>${escapeHtml(table.tableName)}</td><td>${formatNumber(table.estimatedRows)}</td><td>${formatBytes(table.dataBytes)}</td><td>${formatBytes(table.indexBytes)}</td><td>${formatBytes(table.totalBytes)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No CrawlLoom tables found yet.</td></tr>';
    overviewMessage.textContent = `Storage details refreshed ${formatDate(new Date())}.`;
    overviewContent.classList.remove('hidden');
  } catch (error) {
    overviewMessage.textContent = error.message;
  } finally {
    refreshOverview.disabled = false;
  }
}

async function loadCrawls() {
  refreshCrawls.disabled = true;
  crawlsMessage.textContent = 'Loading saved crawls…';
  try {
    const response = await fetch('/api/admin/crawl-history?limit=50', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load saved crawls.');
    crawlsTable.innerHTML = data.crawls.map(crawl => `<tr><td class="crawl-target" title="${escapeHtml(crawl.seedUrl)}">${escapeHtml(crawl.seedUrl)}</td><td><span class="session-status ${escapeHtml(String(crawl.status || 'unknown').toLowerCase())}">${escapeHtml(crawl.status || 'Unknown')}</span></td><td>${formatNumber(crawl.stats?.pagesCrawled)}</td><td>${escapeHtml(formatDate(crawl.startedAt || crawl.createdAt))}</td><td>${escapeHtml(formatDate(crawl.completedAt))}</td><td><button class="delete-crawl" type="button" data-crawl-id="${escapeHtml(crawl.id)}" data-crawl-target="${escapeHtml(crawl.seedUrl)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No saved crawls are available.</td></tr>';
    crawlsMessage.textContent = `${data.crawls.length} saved crawl${data.crawls.length === 1 ? '' : 's'} loaded.`;
  } catch (error) {
    crawlsMessage.textContent = error.message;
  } finally {
    refreshCrawls.disabled = false;
  }
}

async function loadSessions() {
  refreshSessions.disabled = true;
  sessionsMessage.textContent = 'Loading active and recent sessions…';
  try {
    const response = await fetch('/api/admin/sessions', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load session details.');
    const activeCount = data.sessions.filter(session => session.status === 'Active').length;
    sessionsTable.innerHTML = data.sessions.map(session => `<tr><td><code>${escapeHtml(session.idDisplay)}</code>${session.current ? '<span class="device-meta">This device</span>' : ''}</td><td>${escapeHtml(session.type)}</td><td><span class="session-status ${escapeHtml(session.status.toLowerCase().replace(/\s+/g, '-'))}">${escapeHtml(session.status)}</span></td><td><span class="device">${escapeHtml(session.device)}</span><span class="device-meta">Started ${escapeHtml(formatDate(session.createdAt))}</span></td><td>${escapeHtml(session.ip)}</td><td>${escapeHtml(formatDate(session.lastSeenAt))}</td><td>${session.current || session.status === 'Revoked' || session.status === 'Signed out' ? '<span class="muted">—</span>' : `<button class="revoke" type="button" data-session-id="${escapeHtml(session.id)}">Revoke</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No sessions have been recorded yet.</td></tr>';
    sessionsMessage.textContent = `${activeCount} active session${activeCount === 1 ? '' : 's'} • activity is retained for ${data.retentionDays} days.`;
  } catch (error) {
    sessionsMessage.textContent = error.message;
  } finally {
    refreshSessions.disabled = false;
  }
}

const formatEventName = eventType => String(eventType || 'Unknown event').replace(/[._-]+/g, ' ');
const formatEventDetails = metadata => {
  if (!metadata || typeof metadata !== 'object' || !Object.keys(metadata).length) return '—';
  return Object.entries(metadata)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase())}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' • ');
};

let securityEventsPage = 1;
async function loadSecurityEvents(page = securityEventsPage) {
  const requestedPage = Math.max(1, Number(page) || 1);
  refreshEvents.disabled = true;
  previousEvents.disabled = true;
  nextEvents.disabled = true;
  eventsMessage.textContent = 'Loading recent security activity…';
  try {
    const response = await fetch(`/api/admin/security-events?page=${encodeURIComponent(requestedPage)}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load security activity.');
    const pagination = data.pagination || { page: requestedPage, pageSize: 10, total: data.events.length, totalPages: 1 };
    securityEventsPage = pagination.page;
    eventsTable.innerHTML = data.events.map(event => `<tr><td>${escapeHtml(formatDate(event.createdAt))}</td><td><span class="event-name">${escapeHtml(formatEventName(event.eventType))}</span></td><td><span class="event-outcome ${escapeHtml(String(event.outcome || 'unknown').toLowerCase())}">${escapeHtml(event.outcome || 'Unknown')}</span></td><td>${escapeHtml(event.ipAddress)}</td><td>${escapeHtml(describeDevice(event.userAgent))}</td><td><span class="event-details">${escapeHtml(formatEventDetails(event.metadata))}</span></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No security events have been recorded yet.</td></tr>';
    eventsMessage.textContent = `${data.events.length} event${data.events.length === 1 ? '' : 's'} loaded.`;
    eventsPageInfo.textContent = pagination.total ? `Showing ${(pagination.page - 1) * pagination.pageSize + 1}–${Math.min(pagination.page * pagination.pageSize, pagination.total)} of ${pagination.total.toLocaleString()} events` : 'No security events recorded';
    previousEvents.disabled = pagination.page <= 1;
    nextEvents.disabled = pagination.page >= pagination.totalPages;
  } catch (error) {
    eventsMessage.textContent = error.message;
    eventsPageInfo.textContent = 'Could not load pagination.';
  } finally {
    refreshEvents.disabled = false;
  }
}

async function loadAuditors() {
  refreshAuditors.disabled = true;
  auditorsMessage.textContent = 'Loading auditor accounts…';
  try {
    const response = await fetch('/api/admin/auditors', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load auditor accounts.');
    auditorsTable.innerHTML = data.auditors.map(auditor => {
      const id = escapeHtml(auditor.id);
      const actions = auditor.status === 'active'
        ? `<button class="revoke" type="button" data-auditor-id="${id}" data-auditor-action="disable">Disable</button>`
        : `<button class="secondary compact-action" type="button" data-auditor-id="${id}" data-auditor-action="enable">Enable</button>`;
      return `<tr><td><code>${escapeHtml(auditor.username)}</code></td><td>Auditor</td><td><span class="session-status ${escapeHtml(String(auditor.status).toLowerCase())}">${escapeHtml(auditor.status)}</span></td><td>${escapeHtml(formatDate(auditor.createdAt))}</td><td>${escapeHtml(formatDate(auditor.lastLoginAt))}</td><td><div class="auditor-actions">${actions}<button class="delete-auditor" type="button" data-auditor-id="${id}" data-auditor-action="delete">Delete</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">No auditor accounts have been created yet.</td></tr>';
    auditorsMessage.textContent = `${data.auditors.length} auditor account${data.auditors.length === 1 ? '' : 's'} found.`;
  } catch (error) {
    auditorsMessage.textContent = error.message;
  } finally {
    refreshAuditors.disabled = false;
  }
}

confirmation.addEventListener('input', () => { clear.disabled = confirmation.value !== 'DELETE ALL'; });
clear.addEventListener('click', async () => {
  clear.disabled = true;
  message.textContent = 'Deleting saved history…';
  try {
    const response = await fetch('/api/admin/crawl-history/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: confirmation.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not clear history.');
    message.textContent = `Deleted ${data.deleted.crawls} crawl(s), ${data.deleted.pages} page(s), ${data.deleted.links} link(s), and ${data.deleted.resources} resource(s).`;
    confirmation.value = '';
    await Promise.all([loadOverview(), loadCrawls()]);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    clear.disabled = confirmation.value !== 'DELETE ALL';
  }
});
refreshOverview.addEventListener('click', loadOverview);
refreshSessions.addEventListener('click', loadSessions);
refreshEvents.addEventListener('click', () => void loadSecurityEvents());
previousEvents.addEventListener('click', () => void loadSecurityEvents(securityEventsPage - 1));
nextEvents.addEventListener('click', () => void loadSecurityEvents(securityEventsPage + 1));
refreshAuditors.addEventListener('click', loadAuditors);
refreshCrawls.addEventListener('click', loadCrawls);
createAuditorForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = createAuditorForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  auditorsMessage.textContent = 'Creating auditor account…';
  try {
    const response = await fetch('/api/admin/auditors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: auditorUsername.value, password: auditorPassword.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create auditor account.');
    auditorUsername.value = '';
    auditorPassword.value = '';
    auditorsMessage.textContent = `Auditor “${data.auditor.username}” was created. Share the username and assigned password privately.`;
    await loadAuditors();
  } catch (error) {
    auditorsMessage.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
auditorsTable.addEventListener('click', async event => {
  const button = event.target.closest('[data-auditor-id]');
  if (!button) return;
  const action = button.dataset.auditorAction;
  const prompts = {
    disable: 'Disable this auditor? Their active dashboard sessions will be revoked.',
    enable: 'Enable this auditor? They will be able to sign in again with their existing password.',
    delete: 'Permanently delete this auditor account? Their sign-in and sessions will be removed. Saved crawls are retained in administrator history.'
  };
  if (!prompts[action] || !window.confirm(prompts[action])) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/auditors/${encodeURIComponent(button.dataset.auditorId)}/${action}`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Could not ${action} auditor account.`);
    auditorsMessage.textContent = action === 'delete'
      ? `Auditor “${data.deleted?.username || 'account'}” was permanently deleted.`
      : action === 'enable' ? 'Auditor account enabled.' : 'Auditor account disabled.';
    await loadAuditors();
  } catch (error) {
    auditorsMessage.textContent = error.message;
    button.disabled = false;
  }
});
sessionsTable.addEventListener('click', async event => {
  const button = event.target.closest('[data-session-id]');
  if (!button || !window.confirm('Revoke this session? Any crawl owned by that dashboard tab will be stopped.')) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/sessions/${encodeURIComponent(button.dataset.sessionId)}/revoke`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not revoke the session.');
    await loadSessions();
  } catch (error) {
    sessionsMessage.textContent = error.message;
    button.disabled = false;
  }
});
crawlsTable.addEventListener('click', async event => {
  const button = event.target.closest('[data-crawl-id]');
  if (!button || !window.confirm(`Permanently delete this saved crawl and all its audit data?\n\n${button.dataset.crawlTarget}`)) return;
  button.disabled = true;
  crawlsMessage.textContent = 'Deleting saved crawl…';
  try {
    const response = await fetch(`/api/admin/crawl-history/${encodeURIComponent(button.dataset.crawlId)}/delete`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not delete the saved crawl.');
    crawlsMessage.textContent = `Deleted 1 crawl, ${formatNumber(data.deleted.pages)} page(s), ${formatNumber(data.deleted.links)} link(s), and ${formatNumber(data.deleted.resources)} resource(s).`;
    await Promise.all([loadCrawls(), loadOverview()]);
  } catch (error) {
    crawlsMessage.textContent = error.message;
    button.disabled = false;
  }
});
loadOverview();
loadCrawls();
loadSessions();
loadSecurityEvents();
loadAuditors();
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.assign('/admin/login');
});
