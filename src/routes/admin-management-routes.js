// Administrator-only operational and account-management endpoints.
// Authentication/session primitives are injected by the application shell.
export function registerAdminManagementRoutes(app, dependencies) {
  const {
    requireAdmin, requireSameOrigin, crawlStorage, randomUUID, normalizeUsername,
    validAuditorUsername, hashAuditorPassword, auditSecurityEvent, getAdminSession,
    auditorSessions, dashboardSessions, adminSessions, crawlCoordinator,
    revokeDashboardSession, pruneSessionRecords, serializeSession,
    activeSessionWindowMs, sessionActivityRetentionMs
  } = dependencies;

  function revokeAuditorLiveAccess(userId, { removeSessionRecords = false } = {}) {
    for (const [sessionId, session] of auditorSessions) {
      if (session.userId !== userId) continue;
      if (removeSessionRecords) auditorSessions.delete(sessionId);
      else session.revokedAt = Date.now();
    }
    for (const [dashboardId, session] of dashboardSessions) {
      if (session.ownerRole === 'Auditor' && session.ownerUserId === userId) revokeDashboardSession(dashboardId);
    }
  }

  app.get('/api/admin/database-overview', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const overview = await crawlStorage.getDatabaseOverview();
      res.json({ storage: crawlStorage.getStatus(), ...overview });
    } catch (error) {
      res.status(503).json({ error: error.message, storage: crawlStorage.getStatus() });
    }
  });

  app.get('/api/admin/security-events', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const pageSize = 10;
      const requestedPage = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 100000);
      const total = await crawlStorage.countSecurityEvents();
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const events = await crawlStorage.listSecurityEvents(pageSize, (page - 1) * pageSize);
      res.json({ events, pagination: { page, pageSize, total, totalPages }, storage: crawlStorage.getStatus() });
    } catch (error) {
      res.status(503).json({ error: 'Could not load security activity.', storage: crawlStorage.getStatus() });
    }
  });

  app.get('/api/admin/auditors', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ auditors: await crawlStorage.listAuditors() });
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });

  app.post('/api/admin/auditors', requireAdmin, requireSameOrigin, async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!validAuditorUsername(username)) return res.status(400).json({ error: 'Use 3–64 lowercase letters, numbers, dots, dashes, or underscores for the username.' });
    if (password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Use a password between 12 and 128 characters.' });
    try {
      const auditor = await crawlStorage.createAuditor({ id: randomUUID(), username, passwordHash: await hashAuditorPassword(password) });
      auditSecurityEvent(req, 'auditor.created', 'success', { username }, { adminSession: getAdminSession(req, false) });
      res.status(201).json({ success: true, auditor });
    } catch (error) {
      res.status(503).json({ error: error.message || 'Could not create the auditor account.' });
    }
  });

  app.post('/api/admin/auditors/:userId/disable', requireAdmin, requireSameOrigin, async (req, res) => {
    const userId = req.params.userId;
    if (!/^[a-f0-9-]{36}$/i.test(userId)) return res.status(400).json({ error: 'Invalid auditor identifier.' });
    try {
      await crawlStorage.disableAuditor(userId);
      await crawlStorage.revokeAuthSessionsForUser(userId);
      revokeAuditorLiveAccess(userId);
      auditSecurityEvent(req, 'auditor.disabled', 'success', { userIdSuffix: userId.slice(-4) }, { adminSession: getAdminSession(req, false) });
      res.json({ success: true });
    } catch (error) {
      res.status(503).json({ error: error.message || 'Could not disable the auditor account.' });
    }
  });

  app.post('/api/admin/auditors/:userId/enable', requireAdmin, requireSameOrigin, async (req, res) => {
    const userId = req.params.userId;
    if (!/^[a-f0-9-]{36}$/i.test(userId)) return res.status(400).json({ error: 'Invalid auditor identifier.' });
    try {
      await crawlStorage.enableAuditor(userId);
      auditSecurityEvent(req, 'auditor.enabled', 'success', { userIdSuffix: userId.slice(-4) }, { adminSession: getAdminSession(req, false) });
      res.json({ success: true });
    } catch (error) {
      res.status(503).json({ error: error.message || 'Could not enable the auditor account.' });
    }
  });

  app.post('/api/admin/auditors/:userId/delete', requireAdmin, requireSameOrigin, async (req, res) => {
    const userId = req.params.userId;
    if (!/^[a-f0-9-]{36}$/i.test(userId)) return res.status(400).json({ error: 'Invalid auditor identifier.' });
    try {
      const deleted = await crawlStorage.deleteAuditor(userId);
      revokeAuditorLiveAccess(userId, { removeSessionRecords: true });
      auditSecurityEvent(req, 'auditor.deleted', 'success', { username: deleted.username, userIdSuffix: userId.slice(-4) }, { adminSession: getAdminSession(req, false) });
      res.json({ success: true, deleted: { username: deleted.username } });
    } catch (error) {
      res.status(503).json({ error: error.message || 'Could not delete the auditor account.' });
    }
  });

  app.get('/api/admin/crawl-history', requireAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const crawls = await crawlStorage.listCrawls(req.query.limit || 50);
      res.json({ crawls, storage: crawlStorage.getStatus() });
    } catch (error) {
      res.status(503).json({ error: error.message || 'Could not load saved crawl history.', storage: crawlStorage.getStatus() });
    }
  });

  app.post('/api/admin/crawl-history/:crawlId/delete', requireAdmin, requireSameOrigin, async (req, res) => {
    const crawlId = req.params.crawlId;
    if (!/^[a-f0-9-]{36}$/i.test(crawlId)) return res.status(400).json({ error: 'Invalid crawl identifier.' });
    if (crawlCoordinator.hasActiveCrawl(crawlId)) {
      auditSecurityEvent(req, 'crawl.history.delete', 'denied', { crawlIdSuffix: crawlId.slice(-4), reason: 'active-crawl' });
      return res.status(409).json({ error: 'Stop and allow this crawl to finish saving before deleting it.' });
    }
    try {
      const deleted = await crawlStorage.deleteCrawl(crawlId);
      if (!deleted) {
        auditSecurityEvent(req, 'crawl.history.delete', 'denied', { crawlIdSuffix: crawlId.slice(-4), reason: 'not-found' });
        return res.status(404).json({ error: 'Saved crawl not found or already deleted.' });
      }
      auditSecurityEvent(req, 'crawl.history.delete', 'success', { crawlIdSuffix: crawlId.slice(-4), deleted });
      return res.json({ success: true, deleted });
    } catch (error) {
      console.error('Failed to delete saved crawl:', error.message);
      return res.status(500).json({ error: 'Could not delete the saved crawl. Please try again.' });
    }
  });

  app.post('/api/admin/crawl-history/clear', requireAdmin, requireSameOrigin, async (req, res) => {
    try {
      if (crawlCoordinator.getCapacity().activeCrawls > 0) {
        auditSecurityEvent(req, 'crawl.history.clear', 'denied', { reason: 'active-crawls' });
        return res.status(409).json({ error: 'Stop and allow all active crawls to finish saving before clearing history.' });
      }
      if (req.body?.confirmation !== 'DELETE ALL') {
        auditSecurityEvent(req, 'crawl.history.clear', 'denied', { reason: 'confirmation-mismatch' });
        return res.status(400).json({ error: 'Type DELETE ALL to confirm permanent deletion.' });
      }
      const deleted = await crawlStorage.clearAllCrawls();
      auditSecurityEvent(req, 'crawl.history.clear', 'success', { deleted });
      return res.json({ success: true, deleted });
    } catch (error) {
      console.error('Failed to clear saved crawl history:', error.message);
      return res.status(500).json({ error: 'Could not clear saved crawl history. Please try again.' });
    }
  });

  app.get('/api/admin/sessions', requireAdmin, (req, res) => {
    pruneSessionRecords();
    const currentAdminSession = getAdminSession(req, false);
    const sessions = [
      ...[...adminSessions.values()].map(session => serializeSession(session, 'Administrator', currentAdminSession?.id)),
      ...[...auditorSessions.values()].map(session => serializeSession(session, `Auditor${session.username ? ` (${session.username})` : ''}`, currentAdminSession?.id)),
      ...[...dashboardSessions.values()].map(session => serializeSession(session, 'Dashboard', currentAdminSession?.id))
    ].sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sessions, activeWindowSeconds: activeSessionWindowMs / 1000, retentionDays: sessionActivityRetentionMs / (24 * 60 * 60 * 1000) });
  });

  app.post('/api/admin/sessions/:sessionId/revoke', requireAdmin, requireSameOrigin, async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session identifier.' });
    const currentAdminSession = getAdminSession(req, false);
    const adminSession = adminSessions.get(sessionId);
    if (adminSession) {
      if (adminSession.id === currentAdminSession?.id) return res.status(400).json({ error: 'Use Sign out to end your current administrator session.' });
      adminSession.revokedAt = Date.now();
      await crawlStorage.revokeAuthSession(adminSession.id);
      auditSecurityEvent(req, 'session.revoked', 'success', { sessionType: 'Administrator', sessionIdSuffix: sessionId.slice(-4) }, { adminSession: currentAdminSession });
      return res.json({ success: true, type: 'Administrator' });
    }
    const auditorSession = auditorSessions.get(sessionId);
    if (auditorSession) {
      auditorSession.revokedAt = Date.now();
      await crawlStorage.revokeAuthSession(auditorSession.id);
      for (const [dashboardId, dashboard] of dashboardSessions) {
        if (dashboard.ownerRole === 'Auditor' && dashboard.ownerSessionId === auditorSession.id) revokeDashboardSession(dashboardId);
      }
      auditSecurityEvent(req, 'session.revoked', 'success', { sessionType: 'Auditor', sessionIdSuffix: sessionId.slice(-4) }, { adminSession: currentAdminSession });
      return res.json({ success: true, type: 'Auditor' });
    }
    if (revokeDashboardSession(sessionId)) {
      auditSecurityEvent(req, 'session.revoked', 'success', { sessionType: 'Dashboard', sessionIdSuffix: sessionId.slice(-4) }, { adminSession: currentAdminSession });
      return res.json({ success: true, type: 'Dashboard' });
    }
    return res.status(404).json({ error: 'That session is no longer available.' });
  });
}
