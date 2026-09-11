import mysql from 'mysql2/promise';

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function nullable(value) {
  return value === undefined || value === '' ? null : value;
}

export class CrawlStorage {
  constructor() {
    this.isConfigured = Boolean(
      process.env.DB_HOST &&
      process.env.DB_NAME &&
      process.env.DB_USER &&
      process.env.DB_PASSWORD
    );
    this.pool = null;
    this.initPromise = null;
    this.lastError = null;
  }

  async initialize() {
    if (!this.isConfigured) return false;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.pool = mysql.createPool({
          host: process.env.DB_HOST,
          port: Number.parseInt(process.env.DB_PORT || '3306', 10),
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          waitForConnections: true,
          connectionLimit: 5,
          queueLimit: 20,
          enableKeepAlive: true,
          keepAliveInitialDelay: 0,
          charset: 'utf8mb4'
        });
        await this.pool.query('SELECT 1');
        await this.migrate();
        this.lastError = null;
        console.log('Persistent crawl history is connected to MySQL.');
        return true;
      } catch (error) {
        this.lastError = error.message;
        console.error('Persistent crawl history is unavailable; continuing with in-memory results:', error.message);
        await this.pool?.end().catch(() => {});
        this.pool = null;
        return false;
      }
    })();

    return this.initPromise;
  }

  getStatus() {
    return {
      configured: this.isConfigured,
      connected: Boolean(this.pool),
      error: this.lastError
    };
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS crawl_runs (
        id CHAR(36) NOT NULL PRIMARY KEY,
        session_id VARCHAR(128) NOT NULL,
        owner_user_id VARCHAR(128) NULL,
        seed_url TEXT NOT NULL,
        config_json JSON NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'starting',
        stats_json JSON NULL,
        engine_json JSON NULL,
        queue_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME NULL,
        completed_at DATETIME NULL,
        INDEX idx_crawl_runs_created_at (created_at),
        INDEX idx_crawl_runs_session_id (session_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS crawl_pages (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        crawl_id CHAR(36) NOT NULL,
        page_number INT NULL,
        url TEXT NOT NULL,
        depth INT NOT NULL DEFAULT 0,
        source_url TEXT NULL,
        status_code INT NULL,
        status_text VARCHAR(255) NULL,
        response_time_ms INT NULL,
        title TEXT NULL,
        meta_description TEXT NULL,
        meta_keywords TEXT NULL,
        canonical TEXT NULL,
        meta_robots TEXT NULL,
        h1 TEXT NULL,
        h1_list JSON NULL,
        h2_list JSON NULL,
        images_count INT NULL,
        total_words INT NULL,
        internal_links_count INT NULL,
        external_links_count INT NULL,
        custom_links_count INT NULL,
        custom_detected TINYINT(1) NOT NULL DEFAULT 0,
        custom_selector TEXT NULL,
        custom_detection_method VARCHAR(32) NULL,
        custom_word_count INT NULL,
        custom_headings JSON NULL,
        custom_text LONGTEXT NULL,
        full_page_text LONGTEXT NULL,
        resources_json JSON NULL,
        images_json JSON NULL,
        render_comparison_json JSON NULL,
        render_mode VARCHAR(64) NULL,
        render_error TEXT NULL,
        error_text TEXT NULL,
        crawled_at DATETIME NULL,
        INDEX idx_crawl_pages_crawl_id (crawl_id),
        UNIQUE KEY uq_crawl_pages_number (crawl_id, page_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS crawl_links (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        crawl_id CHAR(36) NOT NULL,
        page_id BIGINT UNSIGNED NOT NULL,
        source_url TEXT NOT NULL,
        target_url TEXT NULL,
        raw_href TEXT NULL,
        anchor_text TEXT NULL,
        link_type VARCHAR(32) NULL,
        rel_value VARCHAR(255) NULL,
        target_value VARCHAR(255) NULL,
        is_nofollow TINYINT(1) NOT NULL DEFAULT 0,
        is_inside_content TINYINT(1) NOT NULL DEFAULT 0,
        is_valid_http TINYINT(1) NOT NULL DEFAULT 0,
        status_code INT NULL,
        final_status_code INT NULL,
        final_url TEXT NULL,
        redirect_chain JSON NULL,
        INDEX idx_crawl_links_crawl_id (crawl_id),
        INDEX idx_crawl_links_page_id (page_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(96) NOT NULL,
        outcome VARCHAR(24) NOT NULL DEFAULT 'success',
        admin_session_id CHAR(36) NULL,
        dashboard_session_id CHAR(36) NULL,
        ip_address VARCHAR(64) NULL,
        user_agent VARCHAR(512) NULL,
        metadata_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_security_events_created_at (created_at),
        INDEX idx_security_events_type_created_at (event_type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Auditor accounts are deliberately separate from the environment-backed
    // owner password. Only a password hash is stored; a user can be disabled
    // without changing the owner's credentials.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id CHAR(36) NOT NULL PRIMARY KEY,
        username VARCHAR(64) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(24) NOT NULL DEFAULT 'auditor',
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME NULL,
        disabled_at DATETIME NULL,
        UNIQUE KEY uq_app_users_username (username),
        INDEX idx_app_users_role_status (role, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Authentication cookies only contain a signed reference. The session
    // record lives here so a Node process restart does not sign everyone out.
    // Revocation and expiry remain server-enforced on every authenticated call.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        role VARCHAR(24) NOT NULL,
        user_id CHAR(36) NULL,
        username VARCHAR(64) NULL,
        ip_address VARCHAR(64) NULL,
        user_agent VARCHAR(512) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        ended_at DATETIME NULL,
        INDEX idx_auth_sessions_last_seen_at (last_seen_at),
        INDEX idx_auth_sessions_user_id (user_id),
        INDEX idx_auth_sessions_active (role, expires_at, revoked_at, ended_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try {
      await this.pool.query('ALTER TABLE crawl_pages ADD COLUMN images_json JSON NULL');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    // Existing Hostinger databases were created before asset persistence was
    // introduced. Add the column once without disturbing stored crawls.
    try {
      await this.pool.query('ALTER TABLE crawl_pages ADD COLUMN resources_json JSON NULL AFTER full_page_text');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    try {
      await this.pool.query('ALTER TABLE crawl_pages ADD COLUMN render_comparison_json JSON NULL AFTER resources_json');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    try {
      await this.pool.query('ALTER TABLE crawl_pages ADD COLUMN meta_keywords TEXT NULL AFTER meta_description');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    try {
      await this.pool.query('ALTER TABLE crawl_runs ADD COLUMN queue_json JSON NULL AFTER engine_json');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    try {
      await this.pool.query('ALTER TABLE crawl_runs ADD COLUMN owner_user_id VARCHAR(128) NULL AFTER session_id');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
    // Add redirect fields for databases created before redirect auditing was introduced.
    for (const statement of [
      'ALTER TABLE crawl_links ADD COLUMN final_status_code INT NULL AFTER status_code',
      'ALTER TABLE crawl_links ADD COLUMN final_url TEXT NULL AFTER final_status_code',
      'ALTER TABLE crawl_links ADD COLUMN redirect_chain JSON NULL AFTER final_url'
    ]) {
      try {
        await this.pool.query(statement);
      } catch (error) {
        if (error.code !== 'ER_DUP_FIELDNAME') throw error;
      }
    }
  }

  async createCrawl({ id, sessionId, ownerUserId = null, seedUrl, config }) {
    if (!(await this.initialize())) return false;
    await this.pool.execute(
      `INSERT INTO crawl_runs (id, session_id, owner_user_id, seed_url, config_json, status)
       VALUES (?, ?, ?, ?, ?, 'starting')`,
      [id, sessionId, ownerUserId, seedUrl, JSON.stringify(config)]
    );
    return true;
  }

  async createAuditor({ id, username, passwordHash }) {
    if (!(await this.initialize()) || !this.pool) throw new Error('Persistent user storage is not connected.');
    try {
      await this.pool.execute(
        `INSERT INTO app_users (id, username, password_hash, role, status)
         VALUES (?, ?, ?, 'auditor', 'active')`,
        [id, username, passwordHash]
      );
      return { id, username, role: 'auditor', status: 'active' };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw new Error('That username is already in use.');
      throw error;
    }
  }

  async createAuthSession(session) {
    if (!(await this.initialize()) || !this.pool) return false;
    await this.pool.execute(
      `INSERT INTO auth_sessions (
        id, role, user_id, username, ip_address, user_agent,
        created_at, last_seen_at, expires_at, revoked_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.role,
        nullable(session.userId),
        nullable(session.username),
        nullable(session.ip),
        nullable(session.userAgent),
        new Date(session.createdAt),
        new Date(session.lastSeenAt),
        new Date(session.expiresAt),
        session.revokedAt ? new Date(session.revokedAt) : null,
        session.endedAt ? new Date(session.endedAt) : null
      ]
    );
    return true;
  }

  async listAuthSessions(retentionSince, limit = 100) {
    if (!(await this.initialize()) || !this.pool) return [];
    const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const [rows] = await this.pool.execute(
      `SELECT id, role, user_id AS userId, username, ip_address AS ip, user_agent AS userAgent,
              created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt,
              revoked_at AS revokedAt, ended_at AS endedAt
       FROM auth_sessions
       WHERE last_seen_at >= ? OR created_at >= ?
       ORDER BY last_seen_at DESC
       LIMIT ?`,
      [new Date(retentionSince), new Date(retentionSince), pageSize]
    );
    return rows.map(row => ({ ...row }));
  }

  async touchAuthSession(id) {
    if (!(await this.initialize()) || !this.pool) return false;
    const [result] = await this.pool.execute(
      `UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ? AND revoked_at IS NULL AND ended_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      [id]
    );
    return Boolean(result.affectedRows);
  }

  async endAuthSession(id) {
    if (!(await this.initialize()) || !this.pool) return false;
    const [result] = await this.pool.execute(
      'UPDATE auth_sessions SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP) WHERE id = ?',
      [id]
    );
    return Boolean(result.affectedRows);
  }

  async revokeAuthSession(id) {
    if (!(await this.initialize()) || !this.pool) return false;
    const [result] = await this.pool.execute(
      'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?',
      [id]
    );
    return Boolean(result.affectedRows);
  }

  async revokeAuthSessionsForUser(userId) {
    if (!(await this.initialize()) || !this.pool) return 0;
    const [result] = await this.pool.execute(
      `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
       WHERE user_id = ? AND role = 'Auditor' AND revoked_at IS NULL AND ended_at IS NULL`,
      [userId]
    );
    return Number(result.affectedRows || 0);
  }

  async pruneAuthSessions(retentionSince) {
    if (!(await this.initialize()) || !this.pool) return 0;
    const [result] = await this.pool.execute(
      'DELETE FROM auth_sessions WHERE last_seen_at < ? AND created_at < ?',
      [new Date(retentionSince), new Date(retentionSince)]
    );
    return Number(result.affectedRows || 0);
  }

  async findActiveAuditor(username) {
    if (!(await this.initialize()) || !this.pool) return null;
    const [rows] = await this.pool.execute(
      `SELECT id, username, password_hash AS passwordHash, role, status
       FROM app_users WHERE username = ? AND role = 'auditor' AND status = 'active' LIMIT 1`,
      [username]
    );
    return rows[0] || null;
  }

  async listAuditors() {
    if (!(await this.initialize()) || !this.pool) throw new Error('Persistent user storage is not connected.');
    const [rows] = await this.pool.query(
      `SELECT id, username, role, status, created_at AS createdAt, last_login_at AS lastLoginAt, disabled_at AS disabledAt
       FROM app_users WHERE role = 'auditor' ORDER BY created_at DESC`
    );
    return rows.map(row => ({ ...row }));
  }

  async markAuditorLoggedIn(id) {
    if (!(await this.initialize()) || !this.pool) return;
    await this.pool.execute('UPDATE app_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'active\'', [id]);
  }

  async disableAuditor(id) {
    if (!(await this.initialize()) || !this.pool) throw new Error('Persistent user storage is not connected.');
    const [result] = await this.pool.execute(
      `UPDATE app_users SET status = 'disabled', disabled_at = CURRENT_TIMESTAMP
       WHERE id = ? AND role = 'auditor' AND status = 'active'`,
      [id]
    );
    if (!result.affectedRows) throw new Error('That auditor account is already disabled or no longer exists.');
    return true;
  }

  async enableAuditor(id) {
    if (!(await this.initialize()) || !this.pool) throw new Error('Persistent user storage is not connected.');
    const [result] = await this.pool.execute(
      `UPDATE app_users SET status = 'active', disabled_at = NULL
       WHERE id = ? AND role = 'auditor' AND status = 'disabled'`,
      [id]
    );
    if (!result.affectedRows) throw new Error('That auditor account is already active or no longer exists.');
    return true;
  }

  async deleteAuditor(id) {
    if (!(await this.initialize()) || !this.pool) throw new Error('Persistent user storage is not connected.');
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[auditor]] = await connection.execute(
        `SELECT id, username FROM app_users
         WHERE id = ? AND role = 'auditor' FOR UPDATE`,
        [id]
      );
      if (!auditor) {
        await connection.rollback();
        throw new Error('That auditor account no longer exists.');
      }
      await connection.execute('DELETE FROM auth_sessions WHERE user_id = ?', [id]);
      await connection.execute('DELETE FROM app_users WHERE id = ? AND role = \'auditor\'', [id]);
      await connection.commit();
      return { id: auditor.id, username: auditor.username };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateCrawl(id, { status, stats = null, engine = null, started = false, completed = false }) {
    if (!this.pool) return;
    const updates = ['status = ?'];
    const values = [status];
    if (stats) {
      updates.push('stats_json = ?');
      values.push(JSON.stringify(stats));
    }
    if (engine) {
      updates.push('engine_json = ?');
      values.push(JSON.stringify(engine));
    }
    if (started) updates.push('started_at = COALESCE(started_at, CURRENT_TIMESTAMP)');
    if (completed) updates.push('completed_at = CURRENT_TIMESTAMP');
    values.push(id);
    await this.pool.execute(`UPDATE crawl_runs SET ${updates.join(', ')} WHERE id = ?`, values);
  }

  async updateCrawlQueue(id, queue) {
    if (!this.pool) return;
    const checkpoint = queue === null
      ? null
      : Array.isArray(queue) ? { queue } : (queue && typeof queue === 'object' ? queue : { queue: [] });
    await this.pool.execute(
      'UPDATE crawl_runs SET queue_json = ? WHERE id = ?',
      [checkpoint === null ? null : JSON.stringify(checkpoint), id]
    );
  }

  async savePage(crawlId, result) {
    if (!this.pool) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const custom = result.customContent || {};
      const [pageInsert] = await connection.execute(
        `INSERT INTO crawl_pages (
          crawl_id, page_number, url, depth, source_url, status_code, status_text, response_time_ms,
          title, meta_description, meta_keywords, canonical, meta_robots, h1, h1_list, h2_list, images_count,
          total_words, internal_links_count, external_links_count, custom_links_count, custom_detected,
          custom_selector, custom_detection_method, custom_word_count, custom_headings, custom_text,
          full_page_text, resources_json, images_json, render_comparison_json, render_mode, render_error, error_text, crawled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          url = VALUES(url), depth = VALUES(depth), source_url = VALUES(source_url), status_code = VALUES(status_code),
          status_text = VALUES(status_text), response_time_ms = VALUES(response_time_ms), title = VALUES(title),
          meta_description = VALUES(meta_description), meta_keywords = VALUES(meta_keywords), canonical = VALUES(canonical), meta_robots = VALUES(meta_robots),
          h1 = VALUES(h1), h1_list = VALUES(h1_list), h2_list = VALUES(h2_list), images_count = VALUES(images_count),
          total_words = VALUES(total_words), internal_links_count = VALUES(internal_links_count),
          external_links_count = VALUES(external_links_count), custom_links_count = VALUES(custom_links_count),
          custom_detected = VALUES(custom_detected), custom_selector = VALUES(custom_selector),
          custom_detection_method = VALUES(custom_detection_method), custom_word_count = VALUES(custom_word_count),
          custom_headings = VALUES(custom_headings), custom_text = VALUES(custom_text), full_page_text = VALUES(full_page_text), resources_json = VALUES(resources_json), render_comparison_json = VALUES(render_comparison_json),
          images_json = VALUES(images_json), render_mode = VALUES(render_mode), render_error = VALUES(render_error), error_text = VALUES(error_text), crawled_at = VALUES(crawled_at)`,
        [
          crawlId, result.id || null, result.url, result.depth || 0, nullable(result.sourceUrl), nullable(result.statusCode),
          nullable(result.statusText), nullable(result.responseTimeMs), nullable(result.title), nullable(result.metaDescription), nullable(result.metaKeywords),
          nullable(result.canonical), nullable(result.metaRobots), nullable(result.h1), JSON.stringify(result.h1List || []),
          JSON.stringify(result.h2List || []), nullable(result.imagesCount), nullable(result.totalWords),
          nullable(result.internalLinksCount), nullable(result.externalLinksCount), nullable(result.customLinksCount),
          custom.detected ? 1 : 0, nullable(custom.selectorUsed), nullable(custom.detectionMethod), nullable(custom.wordCount),
          JSON.stringify(custom.headings || []), nullable(custom.fullText || custom.textSnippet), nullable(result.fullPageText),
          JSON.stringify(result.resources || []),
          JSON.stringify(result.images ?? null),
          JSON.stringify(result.renderComparison || null),
          nullable(result.renderMode), nullable(result.renderError), nullable(result.error), result.timestamp ? new Date(result.timestamp) : new Date()
        ]
      );

      const [pageRows] = await connection.execute(
        'SELECT id FROM crawl_pages WHERE crawl_id = ? AND page_number <=> ?',
        [crawlId, result.id || null]
      );
      const pageId = pageRows[0]?.id || pageInsert.insertId;
      await connection.execute('DELETE FROM crawl_links WHERE page_id = ?', [pageId]);

      const links = Array.isArray(result.links) ? result.links : [];
      if (links.length) {
        const values = links.map(link => [
          crawlId, pageId, result.url, nullable(link.url), nullable(link.rawHref), nullable(link.anchorText),
          nullable(link.linkType), nullable(link.rel), nullable(link.target), link.isNofollow ? 1 : 0,
          link.isInsideCustom ? 1 : 0, link.isValidHttp ? 1 : 0, nullable(link.statusCode),
          nullable(link.finalStatusCode), nullable(link.finalUrl), JSON.stringify(link.redirectChain || [])
        ]);
        await connection.query(
          `INSERT INTO crawl_links (
            crawl_id, page_id, source_url, target_url, raw_href, anchor_text, link_type, rel_value,
            target_value, is_nofollow, is_inside_content, is_valid_http, status_code, final_status_code,
            final_url, redirect_chain
          ) VALUES ?`,
          [values]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async listCrawls(limit = 25, ownerUserId = null) {
    if (!(await this.initialize())) return [];
    const ownerFilter = ownerUserId ? 'WHERE owner_user_id = ?' : '';
    const queryValues = ownerUserId
      ? [ownerUserId, Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100)]
      : [Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100)];
    const [rows] = await this.pool.execute(
      `SELECT id, seed_url, status, stats_json, engine_json, created_at, started_at, completed_at
       FROM crawl_runs ${ownerFilter} ORDER BY created_at DESC LIMIT ?`,
      queryValues
    );
    return rows.map(row => ({
      id: row.id,
      seedUrl: row.seed_url,
      status: row.status,
      stats: parseJson(row.stats_json, null),
      engine: parseJson(row.engine_json, null),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    }));
  }

  async getCrawlOwner(id) {
    if (!(await this.initialize()) || !this.pool) return null;
    const [rows] = await this.pool.execute('SELECT owner_user_id AS ownerUserId FROM crawl_runs WHERE id = ?', [id]);
    return rows[0]?.ownerUserId || null;
  }

  /**
   * Load only what is needed to resume a saved crawl. In particular, do not
   * call getCrawl() here: that method intentionally returns full text, links,
   * resources and images for exports, which is unsafe for a large resume.
   */
  async getCrawlResumeData(id) {
    if (!(await this.initialize()) || !this.pool) return null;
    const pageWindow = await this.getCrawlPageWindow(id, { limit: 50 });
    if (!pageWindow) return null;
    const [crawlRows] = await this.pool.execute(
      `SELECT id, owner_user_id, seed_url, config_json, status, stats_json, engine_json, queue_json,
        created_at, started_at, completed_at
       FROM crawl_runs WHERE id = ? LIMIT 1`,
      [id]
    );
    const crawl = crawlRows[0];
    if (!crawl) return null;
    const [visitedRows] = await this.pool.execute('SELECT url FROM crawl_pages WHERE crawl_id = ? ORDER BY page_number ASC', [id]);
    const checkpoint = parseJson(crawl.queue_json, {});
    return {
      crawl: {
        id: crawl.id, ownerUserId: crawl.owner_user_id || null, seedUrl: crawl.seed_url,
        status: crawl.status, config: parseJson(crawl.config_json, {}), stats: parseJson(crawl.stats_json, null),
        engine: parseJson(crawl.engine_json, null), queue: Array.isArray(checkpoint.queue) ? checkpoint.queue : [],
        visited: visitedRows.map(row => row.url).filter(Boolean),
        redirectAliases: checkpoint.redirectAliases && typeof checkpoint.redirectAliases === 'object' ? checkpoint.redirectAliases : {},
        nextPageId: Number.isInteger(checkpoint.nextPageId) ? checkpoint.nextPageId : null,
        createdAt: crawl.created_at, startedAt: crawl.started_at, completedAt: crawl.completed_at
      },
      results: pageWindow.results,
      totalPages: pageWindow.counts.all,
      totalResources: pageWindow.resourceTotal || 0
    };
  }

  async getCrawl(id) {
    if (!(await this.initialize())) return null;
    const [crawlRows] = await this.pool.execute('SELECT * FROM crawl_runs WHERE id = ?', [id]);
    if (!crawlRows.length) return null;
    const [pageRows] = await this.pool.execute('SELECT * FROM crawl_pages WHERE crawl_id = ? ORDER BY page_number ASC', [id]);
    const [linkRows] = await this.pool.execute('SELECT * FROM crawl_links WHERE crawl_id = ? ORDER BY id ASC', [id]);
    const linksByPage = new Map();
    for (const link of linkRows) {
      const pageLinks = linksByPage.get(link.page_id) || [];
      pageLinks.push({
        rawHref: link.raw_href || '', url: link.target_url || '', anchorText: link.anchor_text || '',
        linkType: link.link_type || 'Internal', rel: link.rel_value || '', target: link.target_value || '',
        isNofollow: Boolean(link.is_nofollow), isInsideCustom: Boolean(link.is_inside_content),
        isValidHttp: Boolean(link.is_valid_http), statusCode: link.status_code,
        finalStatusCode: link.final_status_code, finalUrl: link.final_url || '',
        redirectChain: parseJson(link.redirect_chain, [])
      });
      linksByPage.set(link.page_id, pageLinks);
    }
    const crawl = crawlRows[0];
    const checkpoint = parseJson(crawl.queue_json, {});
    const queue = Array.isArray(checkpoint) ? checkpoint : (Array.isArray(checkpoint.queue) ? checkpoint.queue : []);
    return {
      crawl: {
        id: crawl.id, ownerUserId: crawl.owner_user_id || null, seedUrl: crawl.seed_url, status: crawl.status, config: parseJson(crawl.config_json, {}),
        stats: parseJson(crawl.stats_json, null), engine: parseJson(crawl.engine_json, null), queue,
        visited: Array.isArray(checkpoint.visited) ? checkpoint.visited : [],
        redirectAliases: checkpoint.redirectAliases && typeof checkpoint.redirectAliases === 'object' ? checkpoint.redirectAliases : {},
        nextPageId: Number.isInteger(checkpoint.nextPageId) ? checkpoint.nextPageId : null,
        createdAt: crawl.created_at,
        startedAt: crawl.started_at, completedAt: crawl.completed_at
      },
      results: pageRows.map(page => ({
        id: page.page_number, url: page.url, depth: page.depth, sourceUrl: page.source_url, statusCode: page.status_code,
        statusText: page.status_text, responseTimeMs: page.response_time_ms, title: page.title, metaDescription: page.meta_description, metaKeywords: page.meta_keywords,
        canonical: page.canonical, metaRobots: page.meta_robots, h1: page.h1, h1List: parseJson(page.h1_list, []),
        h2List: parseJson(page.h2_list, []), imagesCount: page.images_count, totalWords: page.total_words,
        internalLinksCount: page.internal_links_count, externalLinksCount: page.external_links_count,
        customLinksCount: page.custom_links_count, renderMode: page.render_mode, renderError: page.render_error,
        error: page.error_text, timestamp: page.crawled_at,
        fullPageText: page.full_page_text || '',
        resources: parseJson(page.resources_json, []),
        images: parseJson(page.images_json, null),
        renderComparison: parseJson(page.render_comparison_json, null),
        customContent: {
          detected: Boolean(page.custom_detected), selectorUsed: page.custom_selector || '',
          detectionMethod: page.custom_detection_method || 'none', wordCount: page.custom_word_count || 0,
          headings: parseJson(page.custom_headings, []), fullText: page.custom_text || '', textSnippet: page.custom_text || ''
        },
        links: linksByPage.get(page.id) || []
      }))
    };
  }

  /**
   * Returns one lightweight page window for a saved crawl. Large text, links,
   * resources and images stay in MySQL until a user explicitly inspects a
   * page, preventing a historical 5,000-page crawl from becoming one huge
   * JSON response in the browser.
   */
  async getCrawlPageWindow(id, options = {}) {
    if (!(await this.initialize()) || !this.pool) return null;
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const limit = Math.min(250, Math.max(1, Number.parseInt(options.limit, 10) || 50));
    const tab = ['all', 'title', 'description', 'keywords', 'h1', 'h2', 'content'].includes(options.tab) ? options.tab : 'all';
    const filter = ['all', '200', 'content', 'missing', 'errors'].includes(options.filter) ? options.filter : 'all';
    const query = String(options.query || '').trim().slice(0, 200);
    const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
    const valueColumns = {
      all: 'title', title: 'title', description: 'meta_description', keywords: 'meta_keywords',
      h1: 'h1', h2: 'h2_list', content: 'full_page_text'
    };
    const sortColumns = {
      index: 'page_number', status: 'status_code', url: 'url', value: valueColumns[tab],
      length: `CHAR_LENGTH(COALESCE(${valueColumns[tab]}, ''))`, content: 'custom_detected',
      links: '(COALESCE(internal_links_count, 0) + COALESCE(external_links_count, 0))', latency: 'response_time_ms'
    };
    const sort = Object.prototype.hasOwnProperty.call(sortColumns, options.sort) ? options.sort : 'index';
    const where = ['crawl_id = ?'];
    const values = [id];
    const hasContent = "COALESCE(NULLIF(custom_text, ''), NULLIF(full_page_text, '')) IS NOT NULL";
    if (tab === 'title') where.push("COALESCE(title, '') <> ''");
    if (tab === 'description') where.push("COALESCE(meta_description, '') <> ''");
    if (tab === 'keywords') where.push("COALESCE(meta_keywords, '') <> ''");
    if (tab === 'h1') where.push("COALESCE(h1, '') <> ''");
    if (tab === 'h2') where.push('JSON_LENGTH(COALESCE(h2_list, JSON_ARRAY())) > 0');
    if (tab === 'content') where.push(hasContent);
    if (filter === '200') where.push('status_code = 200');
    if (filter === 'content') where.push('custom_detected = 1');
    if (filter === 'missing') where.push('custom_detected = 0');
    if (filter === 'errors') where.push("(COALESCE(status_code, 0) >= 400 OR COALESCE(error_text, '') <> '')");
    if (query) {
      where.push("CONCAT_WS(' ', url, title, meta_description, meta_keywords, h1, status_code) LIKE ?");
      values.push(`%${query}%`);
    }
    const whereSql = where.join(' AND ');
    const [crawlRows] = await this.pool.execute('SELECT id, seed_url, status, config_json, stats_json, engine_json, created_at, started_at, completed_at FROM crawl_runs WHERE id = ?', [id]);
    if (!crawlRows.length) return null;
    const [[totalRow]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM crawl_pages WHERE ${whereSql}`, values);
    const [countRows] = await this.pool.execute(
      `SELECT COUNT(*) AS allPages,
        SUM(COALESCE(title, '') <> '') AS titlePages,
        SUM(COALESCE(meta_description, '') <> '') AS descriptionPages,
        SUM(COALESCE(meta_keywords, '') <> '') AS keywordPages,
        SUM(COALESCE(h1, '') <> '') AS h1Pages,
        SUM(JSON_LENGTH(COALESCE(h2_list, JSON_ARRAY())) > 0) AS h2Pages,
        SUM(${hasContent}) AS contentPages,
        COALESCE(SUM(JSON_LENGTH(resources_json)), 0) AS resourceTotal
       FROM crawl_pages WHERE crawl_id = ?`,
      [id]
    );
    const [pageRows] = await this.pool.execute(
      `SELECT page_number, url, depth, source_url, status_code, status_text, response_time_ms,
        title, meta_description, meta_keywords, canonical, meta_robots, h1, h1_list, h2_list,
        images_count, total_words, internal_links_count, external_links_count, custom_links_count,
        custom_detected, custom_selector, custom_detection_method, custom_word_count, custom_headings,
        render_comparison_json, render_mode, render_error, error_text, crawled_at,
        ${hasContent} AS has_stored_content
       FROM crawl_pages WHERE ${whereSql}
       ORDER BY ${sortColumns[sort]} ${direction}, page_number ASC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    const crawl = crawlRows[0];
    const counts = countRows[0] || {};
    return {
      crawl: {
        id: crawl.id, seedUrl: crawl.seed_url, status: crawl.status, config: parseJson(crawl.config_json, {}),
        stats: parseJson(crawl.stats_json, null), engine: parseJson(crawl.engine_json, null), createdAt: crawl.created_at,
        startedAt: crawl.started_at, completedAt: crawl.completed_at
      },
      offset, limit, total: Number(totalRow.total || 0), resourceTotal: Number(counts.resourceTotal || 0),
      counts: {
        all: Number(counts.allPages || 0), title: Number(counts.titlePages || 0), description: Number(counts.descriptionPages || 0),
        keywords: Number(counts.keywordPages || 0), h1: Number(counts.h1Pages || 0), h2: Number(counts.h2Pages || 0), content: Number(counts.contentPages || 0)
      },
      results: pageRows.map(page => ({
        id: page.page_number, url: page.url, depth: page.depth, sourceUrl: page.source_url, statusCode: page.status_code,
        statusText: page.status_text, responseTimeMs: page.response_time_ms, title: page.title, metaDescription: page.meta_description,
        metaKeywords: page.meta_keywords, canonical: page.canonical, metaRobots: page.meta_robots, h1: page.h1,
        h1List: parseJson(page.h1_list, []), h2List: parseJson(page.h2_list, []), imagesCount: page.images_count,
        totalWords: page.total_words, internalLinksCount: page.internal_links_count, externalLinksCount: page.external_links_count,
        customLinksCount: page.custom_links_count, renderMode: page.render_mode, renderError: page.render_error,
        error: page.error_text, timestamp: page.crawled_at, hasStoredContent: Boolean(page.has_stored_content),
        renderComparison: parseJson(page.render_comparison_json, null),
        customContent: {
          detected: Boolean(page.custom_detected), selectorUsed: page.custom_selector || '',
          detectionMethod: page.custom_detection_method || 'none', wordCount: page.custom_word_count || 0,
          headings: parseJson(page.custom_headings, [])
        }
      }))
    };
  }

  async getCrawlPage(id, url) {
    if (!(await this.initialize()) || !this.pool) return null;
    const [pageRows] = await this.pool.execute('SELECT * FROM crawl_pages WHERE crawl_id = ? AND url = ? LIMIT 1', [id, url]);
    const page = pageRows[0];
    if (!page) return null;
    const [linkRows] = await this.pool.execute('SELECT * FROM crawl_links WHERE page_id = ? ORDER BY id ASC', [page.id]);
    return {
      id: page.page_number, url: page.url, depth: page.depth, sourceUrl: page.source_url, statusCode: page.status_code,
      statusText: page.status_text, responseTimeMs: page.response_time_ms, title: page.title, metaDescription: page.meta_description,
      metaKeywords: page.meta_keywords, canonical: page.canonical, metaRobots: page.meta_robots, h1: page.h1,
      h1List: parseJson(page.h1_list, []), h2List: parseJson(page.h2_list, []), imagesCount: page.images_count,
      totalWords: page.total_words, internalLinksCount: page.internal_links_count, externalLinksCount: page.external_links_count,
      customLinksCount: page.custom_links_count, renderMode: page.render_mode, renderError: page.render_error,
      error: page.error_text, timestamp: page.crawled_at, fullPageText: page.full_page_text || '',
      resources: parseJson(page.resources_json, []), images: parseJson(page.images_json, null),
      renderComparison: parseJson(page.render_comparison_json, null),
      customContent: {
        detected: Boolean(page.custom_detected), selectorUsed: page.custom_selector || '',
        detectionMethod: page.custom_detection_method || 'none', wordCount: page.custom_word_count || 0,
        headings: parseJson(page.custom_headings, []), fullText: page.custom_text || '', textSnippet: page.custom_text || ''
      },
      links: linkRows.map(link => ({
        rawHref: link.raw_href || '', url: link.target_url || '', anchorText: link.anchor_text || '',
        linkType: link.link_type || 'Internal', rel: link.rel_value || '', target: link.target_value || '',
        isNofollow: Boolean(link.is_nofollow), isInsideCustom: Boolean(link.is_inside_content),
        isValidHttp: Boolean(link.is_valid_http), statusCode: link.status_code, finalStatusCode: link.final_status_code,
        finalUrl: link.final_url || '', redirectChain: parseJson(link.redirect_chain, [])
      }))
    };
  }

  /** Return one queryable link window without materialising every link in Node. */
  async getCrawlLinkWindow(id, options = {}) {
    if (!(await this.initialize()) || !this.pool) return null;
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const limit = Math.min(250, Math.max(1, Number.parseInt(options.limit, 10) || 50));
    const filter = ['all', 'internal', 'external', 'redirects', 'in-content', '200', 'errors', 'nofollow'].includes(options.filter) ? options.filter : 'all';
    const query = String(options.query || '').trim().slice(0, 200);
    const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
    const sortColumns = {
      index: 'id', status: 'status_code', anchor: 'anchor_text', destination: 'target_url', type: 'link_type',
      content: 'is_inside_content', nofollow: 'is_nofollow', source: 'source_url'
    };
    const sort = Object.prototype.hasOwnProperty.call(sortColumns, options.sort) ? options.sort : 'index';
    const where = ['crawl_id = ?'];
    const values = [id];
    // Older schemas did not store is_internal separately; link_type is the
    // durable source of truth. Keep the expression backwards compatible.
    const stableInternal = "link_type = 'Internal'";
    const redirected = 'JSON_LENGTH(COALESCE(redirect_chain, JSON_ARRAY())) > 0';
    if (filter === 'internal') where.push(stableInternal);
    if (filter === 'external') where.push("link_type = 'External'");
    if (filter === 'redirects') where.push(redirected);
    if (filter === 'in-content') where.push('is_inside_content = 1');
    if (filter === '200') where.push('status_code = 200');
    if (filter === 'errors') where.push('(COALESCE(status_code, 0) = 0 OR COALESCE(status_code, 0) >= 400)');
    if (filter === 'nofollow') where.push('is_nofollow = 1');
    if (query) {
      where.push("CONCAT_WS(' ', source_url, target_url, final_url, anchor_text, status_code) LIKE ?");
      values.push(`%${query}%`);
    }
    const [crawlRows] = await this.pool.execute('SELECT id FROM crawl_runs WHERE id = ?', [id]);
    if (!crawlRows.length) return null;
    const whereSql = where.join(' AND ');
    const [[totalRow]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM crawl_links WHERE ${whereSql}`, values);
    const [countRows] = await this.pool.execute(
      `SELECT COUNT(*) AS allLinks,
        SUM(${stableInternal}) AS internalLinks,
        SUM(link_type = 'External') AS externalLinks,
        SUM(${redirected}) AS redirects,
        SUM(is_inside_content = 1) AS inContent,
        SUM(status_code = 200) AS ok,
        SUM(COALESCE(status_code, 0) = 0 OR COALESCE(status_code, 0) >= 400) AS errors,
        SUM(is_nofollow = 1) AS nofollow
       FROM crawl_links WHERE crawl_id = ?`,
      [id]
    );
    const [rows] = await this.pool.execute(
      `SELECT source_url, target_url, raw_href, anchor_text, link_type, rel_value, target_value,
        is_nofollow, is_inside_content, is_valid_http, status_code, final_status_code, final_url, redirect_chain
       FROM crawl_links WHERE ${whereSql}
       ORDER BY ${sortColumns[sort]} ${direction}, id ASC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    const counts = countRows[0] || {};
    return {
      offset, limit, total: Number(totalRow.total || 0),
      counts: {
        all: Number(counts.allLinks || 0), internal: Number(counts.internalLinks || 0), external: Number(counts.externalLinks || 0),
        redirects: Number(counts.redirects || 0), 'in-content': Number(counts.inContent || 0), '200': Number(counts.ok || 0),
        errors: Number(counts.errors || 0), nofollow: Number(counts.nofollow || 0)
      },
      links: rows.map(link => ({
        sourceUrl: link.source_url || '', targetUrl: link.target_url || '', url: link.target_url || '', rawHref: link.raw_href || '',
        anchorText: link.anchor_text || '', linkType: link.link_type || 'Internal', rel: link.rel_value || '', target: link.target_value || '',
        isInternal: link.link_type === 'Internal', isNofollow: Boolean(link.is_nofollow), isInsideCustom: Boolean(link.is_inside_content),
        isValidHttp: Boolean(link.is_valid_http), statusCode: link.status_code, finalStatusCode: link.final_status_code,
        finalUrl: link.final_url || '', redirectChain: parseJson(link.redirect_chain, [])
      }))
    };
  }

  /**
   * Reads resources directly from the JSON stored with each saved page.
   * JSON_TABLE lets MySQL page the resource inventory without first sending
   * every page (or every asset) to Node and then the browser. This is vital
   * for historical crawls that can contain hundreds of thousands of assets.
   */
  async getCrawlResourceWindow(id, options = {}) {
    if (!(await this.initialize()) || !this.pool) return null;
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const limit = Math.min(250, Math.max(1, Number.parseInt(options.limit, 10) || 50));
    const filter = ['all', 'stylesheet', 'script', 'image', 'media-font', 'loaded', 'blocked', 'errors'].includes(options.filter) ? options.filter : 'all';
    const query = String(options.query || '').trim().slice(0, 200);
    const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
    const sortColumns = {
      index: 'page.page_number', type: 'resource.resource_type', url: 'resource.resource_url', status: 'resource.status_code',
      size: 'resource.size_bytes', source: 'page.url'
    };
    const sort = Object.prototype.hasOwnProperty.call(sortColumns, options.sort) ? options.sort : 'index';
    const resourceRows = `crawl_pages AS page
      JOIN JSON_TABLE(COALESCE(page.resources_json, JSON_ARRAY()), '$[*]' COLUMNS (
        resource_index FOR ORDINALITY,
        resource_url VARCHAR(2048) PATH '$.url' NULL ON EMPTY,
        raw_url VARCHAR(2048) PATH '$.rawUrl' NULL ON EMPTY,
        resource_type VARCHAR(64) PATH '$.resourceType' NULL ON EMPTY,
        element_name VARCHAR(64) PATH '$.element' NULL ON EMPTY,
        attribute_name VARCHAR(64) PATH '$.attribute' NULL ON EMPTY,
        status_code INT PATH '$.statusCode' NULL ON EMPTY,
        size_bytes BIGINT PATH '$.sizeBytes' NULL ON EMPTY,
        discovery_status VARCHAR(64) PATH '$.discoveryStatus' NULL ON EMPTY
      )) AS resource`;
    const type = "LOWER(COALESCE(resource.resource_type, 'other'))";
    const loaded = "(resource.discovery_status = 'Loaded' OR (resource.status_code >= 200 AND resource.status_code < 400))";
    const errors = '(resource.status_code = 0 OR resource.status_code >= 400)';
    const where = ['page.crawl_id = ?', "COALESCE(resource.resource_url, '') <> ''"];
    const values = [id];
    if (filter === 'stylesheet') where.push(`${type} = 'stylesheet'`);
    if (filter === 'script') where.push(`${type} = 'script'`);
    if (filter === 'image') where.push(`${type} = 'image'`);
    if (filter === 'media-font') where.push(`${type} IN ('media', 'font')`);
    if (filter === 'loaded') where.push(loaded);
    if (filter === 'blocked') where.push("resource.discovery_status = 'Blocked by crawler'");
    if (filter === 'errors') where.push(errors);
    if (query) {
      where.push("CONCAT_WS(' ', page.url, resource.resource_url, resource.resource_type, resource.discovery_status, resource.status_code) LIKE ?");
      values.push(`%${query}%`);
    }
    const [crawlRows] = await this.pool.execute('SELECT id FROM crawl_runs WHERE id = ?', [id]);
    if (!crawlRows.length) return null;
    const whereSql = where.join(' AND ');
    const [[totalRow]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM ${resourceRows} WHERE ${whereSql}`, values);
    const [countRows] = await this.pool.execute(
      `SELECT COUNT(*) AS allResources,
        SUM(${type} = 'stylesheet') AS stylesheets,
        SUM(${type} = 'script') AS scripts,
        SUM(${type} = 'image') AS images,
        SUM(${type} IN ('media', 'font')) AS mediaFonts,
        SUM(${loaded}) AS loaded,
        SUM(resource.discovery_status = 'Blocked by crawler') AS blocked,
        SUM(${errors}) AS errors
       FROM ${resourceRows}
       WHERE page.crawl_id = ? AND COALESCE(resource.resource_url, '') <> ''`,
      [id]
    );
    const [rows] = await this.pool.execute(
      `SELECT page.url AS source_url, resource.resource_url, resource.raw_url, resource.resource_type,
        resource.element_name, resource.attribute_name, resource.status_code, resource.size_bytes, resource.discovery_status
       FROM ${resourceRows}
       WHERE ${whereSql}
       ORDER BY ${sortColumns[sort]} ${direction}, page.page_number ASC, resource.resource_index ASC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );
    const counts = countRows[0] || {};
    return {
      offset, limit, total: Number(totalRow.total || 0),
      counts: {
        all: Number(counts.allResources || 0), stylesheet: Number(counts.stylesheets || 0), script: Number(counts.scripts || 0),
        image: Number(counts.images || 0), 'media-font': Number(counts.mediaFonts || 0), loaded: Number(counts.loaded || 0),
        blocked: Number(counts.blocked || 0), errors: Number(counts.errors || 0)
      },
      resources: rows.map(resource => ({
        url: resource.resource_url || '', rawUrl: resource.raw_url || '', resourceType: resource.resource_type || 'Other',
        element: resource.element_name || '', attribute: resource.attribute_name || '', statusCode: resource.status_code,
        sizeBytes: resource.size_bytes, discoveryStatus: resource.discovery_status || '', sourceUrl: resource.source_url || ''
      }))
    };
  }

  async compareCrawls(previousId, currentId) {
    if (!(await this.initialize()) || !this.pool) {
      throw new Error('Persistent crawl history is not connected.');
    }
    if (previousId === currentId) throw new Error('Choose two different saved crawls to compare.');
    const [crawlRows] = await this.pool.execute(
      `SELECT id, seed_url, status, stats_json, engine_json, created_at, started_at, completed_at
       FROM crawl_runs WHERE id IN (?, ?)`,
      [previousId, currentId]
    );
    const crawls = new Map(crawlRows.map(row => [row.id, {
      id: row.id, seedUrl: row.seed_url, status: row.status,
      stats: parseJson(row.stats_json, null), engine: parseJson(row.engine_json, null),
      createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at
    }]));
    const previous = crawls.get(previousId);
    const current = crawls.get(currentId);
    if (!previous || !current) throw new Error('One or both saved crawls could not be found.');

    // Keep the comparison payload light enough for large historical crawls:
    // the database calculates a content fingerprint, rather than returning
    // every page's LONGTEXT content to the browser.
    const [pageRows] = await this.pool.execute(
      `SELECT crawl_id AS crawlId, url, status_code AS statusCode, title,
        meta_description AS metaDescription, canonical, meta_robots AS metaRobots,
        h1, total_words AS totalWords, internal_links_count AS internalLinksCount,
        external_links_count AS externalLinksCount,
        SHA2(COALESCE(NULLIF(custom_text, ''), NULLIF(full_page_text, ''), ''), 256) AS contentHash
       FROM crawl_pages WHERE crawl_id IN (?, ?)
       ORDER BY crawl_id, page_number ASC`,
      [previousId, currentId]
    );
    const previousPages = new Map();
    const currentPages = new Map();
    for (const row of pageRows) {
      const target = row.crawlId === previousId ? previousPages : currentPages;
      // A crawl normally has one result per canonical URL. Retaining the
      // first row also makes comparison deterministic for older duplicate data.
      if (!target.has(row.url)) target.set(row.url, row);
    }

    const fields = [
      ['Status code', 'statusCode'], ['Page title', 'title'], ['Meta description', 'metaDescription'],
      ['Canonical', 'canonical'], ['Meta robots', 'metaRobots'], ['H1', 'h1'],
      ['Word count', 'totalWords'], ['Internal links', 'internalLinksCount'], ['External links', 'externalLinksCount']
    ];
    const comparable = value => value === null || value === undefined ? '' : String(value);
    const snapshot = page => ({
      statusCode: page.statusCode, title: page.title, metaDescription: page.metaDescription,
      canonical: page.canonical, metaRobots: page.metaRobots, h1: page.h1,
      totalWords: page.totalWords, internalLinksCount: page.internalLinksCount, externalLinksCount: page.externalLinksCount
    });
    const rows = [];
    let added = 0;
    let missing = 0;
    let changed = 0;
    let unchanged = 0;
    const urls = new Set([...previousPages.keys(), ...currentPages.keys()]);
    for (const url of urls) {
      const before = previousPages.get(url);
      const after = currentPages.get(url);
      if (!before) {
        added++;
        rows.push({ url, type: 'new', current: snapshot(after), changes: [] });
        continue;
      }
      if (!after) {
        missing++;
        rows.push({ url, type: 'missing', previous: snapshot(before), changes: [] });
        continue;
      }
      const changes = fields
        .filter(([, key]) => comparable(before[key]) !== comparable(after[key]))
        .map(([field, key]) => ({ field, previous: before[key] ?? null, current: after[key] ?? null }));
      if (before.contentHash !== after.contentHash) changes.push({ field: 'Rendered content', previous: 'Changed', current: 'Changed' });
      if (changes.length) {
        changed++;
        rows.push({ url, type: 'changed', previous: snapshot(before), current: snapshot(after), changes });
      } else {
        unchanged++;
      }
    }
    const typeOrder = { changed: 0, new: 1, missing: 2 };
    rows.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || a.url.localeCompare(b.url));
    return {
      previous,
      current,
      summary: { previousPages: previousPages.size, currentPages: currentPages.size, new: added, missing, changed, unchanged },
      rows
    };
  }

  async clearAllCrawls() {
    if (!(await this.initialize()) || !this.pool) {
      throw new Error('Persistent crawl history is not connected.');
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[linkCount]] = await connection.query('SELECT COUNT(*) AS total FROM crawl_links');
      const [[pageCount]] = await connection.query('SELECT COUNT(*) AS total FROM crawl_pages');
      const [[crawlCount]] = await connection.query('SELECT COUNT(*) AS total FROM crawl_runs');
      const [[resourceCount]] = await connection.query('SELECT COALESCE(SUM(JSON_LENGTH(resources_json)), 0) AS total FROM crawl_pages');
      await connection.query('DELETE FROM crawl_links');
      await connection.query('DELETE FROM crawl_pages');
      await connection.query('DELETE FROM crawl_runs');
      await connection.commit();
      return { crawls: crawlCount.total, pages: pageCount.total, links: linkCount.total, resources: resourceCount.total };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteCrawl(id) {
    if (!(await this.initialize()) || !this.pool) {
      throw new Error('Persistent crawl history is not connected.');
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[crawl]] = await connection.execute('SELECT id FROM crawl_runs WHERE id = ? FOR UPDATE', [id]);
      if (!crawl) {
        await connection.rollback();
        return null;
      }
      const [[linkCount]] = await connection.execute('SELECT COUNT(*) AS total FROM crawl_links WHERE crawl_id = ?', [id]);
      const [[pageCount]] = await connection.execute('SELECT COUNT(*) AS total FROM crawl_pages WHERE crawl_id = ?', [id]);
      const [[resourceCount]] = await connection.execute('SELECT COALESCE(SUM(JSON_LENGTH(resources_json)), 0) AS total FROM crawl_pages WHERE crawl_id = ?', [id]);
      await connection.execute('DELETE FROM crawl_links WHERE crawl_id = ?', [id]);
      await connection.execute('DELETE FROM crawl_pages WHERE crawl_id = ?', [id]);
      await connection.execute('DELETE FROM crawl_runs WHERE id = ?', [id]);
      await connection.commit();
      return { crawls: 1, pages: Number(pageCount.total || 0), links: Number(linkCount.total || 0), resources: Number(resourceCount.total || 0) };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordSecurityEvent({ eventType, outcome = 'success', adminSessionId = null, dashboardSessionId = null, ipAddress = null, userAgent = null, metadata = null }) {
    if (!(await this.initialize()) || !this.pool) return false;
    await this.pool.execute(
      `INSERT INTO security_events (
        event_type, outcome, admin_session_id, dashboard_session_id, ip_address, user_agent, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(eventType || 'unknown').slice(0, 96), String(outcome || 'success').slice(0, 24),
        nullable(adminSessionId && String(adminSessionId).slice(0, 36)),
        nullable(dashboardSessionId && String(dashboardSessionId).slice(0, 36)),
        nullable(ipAddress && String(ipAddress).slice(0, 64)),
        nullable(userAgent && String(userAgent).slice(0, 512)),
        metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : null
      ]
    );
    return true;
  }

  async listSecurityEvents(limit = 100, offset = 0) {
    if (!(await this.initialize()) || !this.pool) return [];
    const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
    const pageOffset = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), 1000000);
    const [rows] = await this.pool.execute(
      `SELECT id, event_type, outcome, admin_session_id, dashboard_session_id, ip_address, user_agent, metadata_json, created_at
       FROM security_events
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, pageOffset]
    );
    return rows.map(row => ({
      id: Number(row.id), eventType: row.event_type, outcome: row.outcome,
      adminSessionId: row.admin_session_id, dashboardSessionId: row.dashboard_session_id,
      ipAddress: row.ip_address || 'Unknown', userAgent: row.user_agent || 'Unknown user agent',
      metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at
    }));
  }

  async countSecurityEvents() {
    if (!(await this.initialize()) || !this.pool) return 0;
    const [[result]] = await this.pool.query('SELECT COUNT(*) AS total FROM security_events');
    return Number(result.total || 0);
  }

  async getDatabaseOverview() {
    if (!(await this.initialize()) || !this.pool) {
      throw new Error('Persistent crawl history is not connected.');
    }

    const [[counts]] = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM crawl_runs) AS crawls,
        (SELECT COUNT(*) FROM crawl_pages) AS pages,
        (SELECT COUNT(*) FROM crawl_links) AS links,
        (SELECT COUNT(*) FROM security_events) AS securityEvents,
        (SELECT COUNT(*) FROM auth_sessions) AS authSessions,
        (SELECT COALESCE(SUM(JSON_LENGTH(resources_json)), 0) FROM crawl_pages) AS resources,
        (SELECT COALESCE(SUM(CHAR_LENGTH(full_page_text)), 0) FROM crawl_pages) AS fullPageTextChars,
        (SELECT COALESCE(SUM(CHAR_LENGTH(custom_text)), 0) FROM crawl_pages) AS contentAreaTextChars,
        (SELECT MIN(created_at) FROM crawl_runs) AS oldestCrawlAt,
        (SELECT MAX(created_at) FROM crawl_runs) AS newestCrawlAt
    `);
    const [tables] = await this.pool.query(`
      SELECT
        table_name AS tableName,
        COALESCE(table_rows, 0) AS estimatedRows,
        COALESCE(data_length, 0) AS dataBytes,
        COALESCE(index_length, 0) AS indexBytes,
        COALESCE(data_length, 0) + COALESCE(index_length, 0) AS totalBytes
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('crawl_runs', 'crawl_pages', 'crawl_links', 'security_events', 'app_users', 'auth_sessions')
      ORDER BY table_name
    `);
    const [[latestCrawl]] = await this.pool.query(`
      SELECT seed_url AS seedUrl, status, created_at AS createdAt, completed_at AS completedAt
      FROM crawl_runs
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const totals = tables.reduce((sum, table) => ({
      dataBytes: sum.dataBytes + Number(table.dataBytes || 0),
      indexBytes: sum.indexBytes + Number(table.indexBytes || 0),
      totalBytes: sum.totalBytes + Number(table.totalBytes || 0)
    }), { dataBytes: 0, indexBytes: 0, totalBytes: 0 });

    return {
      database: process.env.DB_NAME || '',
      counts: {
        crawls: Number(counts.crawls || 0), pages: Number(counts.pages || 0), links: Number(counts.links || 0), securityEvents: Number(counts.securityEvents || 0),
        resources: Number(counts.resources || 0), fullPageTextChars: Number(counts.fullPageTextChars || 0),
        contentAreaTextChars: Number(counts.contentAreaTextChars || 0)
      },
      dates: { oldestCrawlAt: counts.oldestCrawlAt || null, newestCrawlAt: counts.newestCrawlAt || null },
      latestCrawl: latestCrawl || null,
      tables: tables.map(table => ({
        tableName: table.tableName, estimatedRows: Number(table.estimatedRows || 0), dataBytes: Number(table.dataBytes || 0),
        indexBytes: Number(table.indexBytes || 0), totalBytes: Number(table.totalBytes || 0)
      })),
      totals
    };
  }
}

export const crawlStorage = new CrawlStorage();
