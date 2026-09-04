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
        seed_url TEXT NOT NULL,
        config_json JSON NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'starting',
        stats_json JSON NULL,
        engine_json JSON NULL,
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
        INDEX idx_crawl_links_crawl_id (crawl_id),
        INDEX idx_crawl_links_page_id (page_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Existing Hostinger databases were created before asset persistence was
    // introduced. Add the column once without disturbing stored crawls.
    try {
      await this.pool.query('ALTER TABLE crawl_pages ADD COLUMN resources_json JSON NULL AFTER full_page_text');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }

  async createCrawl({ id, sessionId, seedUrl, config }) {
    if (!(await this.initialize())) return false;
    await this.pool.execute(
      `INSERT INTO crawl_runs (id, session_id, seed_url, config_json, status)
       VALUES (?, ?, ?, ?, 'starting')`,
      [id, sessionId, seedUrl, JSON.stringify(config)]
    );
    return true;
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

  async savePage(crawlId, result) {
    if (!this.pool) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const custom = result.customContent || {};
      const [pageInsert] = await connection.execute(
        `INSERT INTO crawl_pages (
          crawl_id, page_number, url, depth, source_url, status_code, status_text, response_time_ms,
          title, meta_description, canonical, meta_robots, h1, h1_list, h2_list, images_count,
          total_words, internal_links_count, external_links_count, custom_links_count, custom_detected,
          custom_selector, custom_detection_method, custom_word_count, custom_headings, custom_text,
          full_page_text, resources_json, render_mode, render_error, error_text, crawled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          url = VALUES(url), depth = VALUES(depth), source_url = VALUES(source_url), status_code = VALUES(status_code),
          status_text = VALUES(status_text), response_time_ms = VALUES(response_time_ms), title = VALUES(title),
          meta_description = VALUES(meta_description), canonical = VALUES(canonical), meta_robots = VALUES(meta_robots),
          h1 = VALUES(h1), h1_list = VALUES(h1_list), h2_list = VALUES(h2_list), images_count = VALUES(images_count),
          total_words = VALUES(total_words), internal_links_count = VALUES(internal_links_count),
          external_links_count = VALUES(external_links_count), custom_links_count = VALUES(custom_links_count),
          custom_detected = VALUES(custom_detected), custom_selector = VALUES(custom_selector),
          custom_detection_method = VALUES(custom_detection_method), custom_word_count = VALUES(custom_word_count),
          custom_headings = VALUES(custom_headings), custom_text = VALUES(custom_text), full_page_text = VALUES(full_page_text), resources_json = VALUES(resources_json),
          render_mode = VALUES(render_mode), render_error = VALUES(render_error), error_text = VALUES(error_text), crawled_at = VALUES(crawled_at)`,
        [
          crawlId, result.id || null, result.url, result.depth || 0, nullable(result.sourceUrl), nullable(result.statusCode),
          nullable(result.statusText), nullable(result.responseTimeMs), nullable(result.title), nullable(result.metaDescription),
          nullable(result.canonical), nullable(result.metaRobots), nullable(result.h1), JSON.stringify(result.h1List || []),
          JSON.stringify(result.h2List || []), nullable(result.imagesCount), nullable(result.totalWords),
          nullable(result.internalLinksCount), nullable(result.externalLinksCount), nullable(result.customLinksCount),
          custom.detected ? 1 : 0, nullable(custom.selectorUsed), nullable(custom.detectionMethod), nullable(custom.wordCount),
          JSON.stringify(custom.headings || []), nullable(custom.fullText || custom.textSnippet), nullable(result.fullPageText),
          JSON.stringify(result.resources || []),
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
          link.isInsideCustom ? 1 : 0, link.isValidHttp ? 1 : 0, nullable(link.statusCode)
        ]);
        await connection.query(
          `INSERT INTO crawl_links (
            crawl_id, page_id, source_url, target_url, raw_href, anchor_text, link_type, rel_value,
            target_value, is_nofollow, is_inside_content, is_valid_http, status_code
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

  async listCrawls(limit = 25) {
    if (!(await this.initialize())) return [];
    const [rows] = await this.pool.execute(
      `SELECT id, seed_url, status, stats_json, engine_json, created_at, started_at, completed_at
       FROM crawl_runs ORDER BY created_at DESC LIMIT ?`,
      [Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100)]
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
        isValidHttp: Boolean(link.is_valid_http), statusCode: link.status_code
      });
      linksByPage.set(link.page_id, pageLinks);
    }
    const crawl = crawlRows[0];
    return {
      crawl: {
        id: crawl.id, seedUrl: crawl.seed_url, status: crawl.status, config: parseJson(crawl.config_json, {}),
        stats: parseJson(crawl.stats_json, null), engine: parseJson(crawl.engine_json, null), createdAt: crawl.created_at,
        startedAt: crawl.started_at, completedAt: crawl.completed_at
      },
      results: pageRows.map(page => ({
        id: page.page_number, url: page.url, depth: page.depth, sourceUrl: page.source_url, statusCode: page.status_code,
        statusText: page.status_text, responseTimeMs: page.response_time_ms, title: page.title, metaDescription: page.meta_description,
        canonical: page.canonical, metaRobots: page.meta_robots, h1: page.h1, h1List: parseJson(page.h1_list, []),
        h2List: parseJson(page.h2_list, []), imagesCount: page.images_count, totalWords: page.total_words,
        internalLinksCount: page.internal_links_count, externalLinksCount: page.external_links_count,
        customLinksCount: page.custom_links_count, renderMode: page.render_mode, renderError: page.render_error,
        error: page.error_text, timestamp: page.crawled_at,
        fullPageText: page.full_page_text || '',
        resources: parseJson(page.resources_json, []),
        customContent: {
          detected: Boolean(page.custom_detected), selectorUsed: page.custom_selector || '',
          detectionMethod: page.custom_detection_method || 'none', wordCount: page.custom_word_count || 0,
          headings: parseJson(page.custom_headings, []), fullText: page.custom_text || '', textSnippet: page.custom_text || ''
        },
        links: linksByPage.get(page.id) || []
      }))
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
      await connection.query('DELETE FROM crawl_links');
      await connection.query('DELETE FROM crawl_pages');
      await connection.query('DELETE FROM crawl_runs');
      await connection.commit();
      return { crawls: crawlCount.total, pages: pageCount.total, links: linkCount.total };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
}

export const crawlStorage = new CrawlStorage();
