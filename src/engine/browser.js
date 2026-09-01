import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

let sparticuzRuntimePromise = null;

const localTmpDir = path.join(process.cwd(), '.tmp');
try {
  if (!fs.existsSync(localTmpDir)) {
    fs.mkdirSync(localTmpDir, { recursive: true, mode: 0o755 });
  }
  process.env.TMPDIR = localTmpDir;
  process.env.TMP = localTmpDir;
  process.env.TEMP = localTmpDir;
} catch (e) {}

export function findChromiumExecutable() {
  const candidateDirs = [
    path.join(process.env.HOME || '', '.cache/ms-playwright'),
    path.join(process.cwd(), 'node_modules/playwright-core/.local-browsers'),
    '/tmp/.cache/ms-playwright'
  ];

  let headlessShellPath = null;
  let standardChromePath = null;

  for (const baseDir of candidateDirs) {
    if (fs.existsSync(baseDir)) {
      try {
        const entries = fs.readdirSync(baseDir, { recursive: true });
        for (const entry of entries) {
          const fullPath = path.join(baseDir, String(entry));
          if (fullPath.endsWith('/chrome-headless-shell-linux64/chrome-headless-shell') && fs.existsSync(fullPath)) {
            headlessShellPath = fullPath;
            break;
          }
          if (
            (fullPath.endsWith('/chrome-linux64/chrome') || 
             fullPath.endsWith('/chrome-linux/chrome') ||
             fullPath.endsWith('/chrome.exe') ||
             fullPath.endsWith('/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')) &&
            fs.existsSync(fullPath)
          ) {
            standardChromePath = fullPath;
          }
        }
      } catch (err) {}
    }
  }

  // Prioritize headless shell (doesn't require desktop X11 / GTK libatk libraries)
  if (headlessShellPath) return headlessShellPath;
  if (standardChromePath) return standardChromePath;

  try {
    const defaultPath = chromium.executablePath();
    if (defaultPath && fs.existsSync(defaultPath)) {
      return defaultPath;
    }
  } catch (e) {}

  return null;
}

export function ensureExecutablePermission(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o755);
    }
  } catch (e) {}
}

async function getSparticuzRuntime() {
  if (!sparticuzRuntimePromise) {
    sparticuzRuntimePromise = (async () => {
      const sparticuzChromium = (await import('@sparticuz/chromium')).default;
      sparticuzChromium.setGraphicsMode = false;
      const executablePath = await sparticuzChromium.executablePath();
      if (!executablePath) {
        throw new Error('@sparticuz/chromium did not return an executable path');
      }
      ensureExecutablePermission(executablePath);
      return { sparticuzChromium, executablePath };
    })().catch(error => {
      sparticuzRuntimePromise = null;
      throw error;
    });
  }
  return sparticuzRuntimePromise;
}

export class BrowserManager {
  constructor(options = {}) {
    this.browser = null;
    this.initPromise = null;
    this.restartPromise = null;
    this.provider = null;
    this.executablePath = null;
    this.browserVersion = null;
    this.launchErrors = [];
    this.launchCount = 0;
    this.restartCount = 0;
    this.disconnectCount = 0;
    this.headless = options.headless !== undefined ? options.headless : true;
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.proxy = options.proxy || null;
    this.geo = options.geo || null;
    this.blockCrossDomainRedirects = options.blockCrossDomainRedirects !== false;
    this.targetHostname = options.targetHostname || '';
  }

  async init() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browser && !this.browser.isConnected()) this.browser = null;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.launchPreferredEngine();
    try {
      const browser = await this.initPromise;
      this.browser = browser;
      this.launchCount++;
      browser.once('disconnected', () => {
        if (this.browser === browser) {
          this.browser = null;
          this.disconnectCount++;
          console.warn(`Chromium disconnected unexpectedly (disconnect #${this.disconnectCount}). It will be relaunched for the next page.`);
        }
      });
      return browser;
    } finally {
      this.initPromise = null;
    }
  }

  async launchPreferredEngine() {
    this.launchErrors = [];
    // Managed Linux hosts usually cannot install Playwright's OS packages. Prefer the
    // self-contained serverless build on Linux unless the deployment overrides it.
    const preferredEngine = process.env.CHROMIUM_ENGINE || (process.platform === 'linux' ? 'sparticuz' : 'playwright');

    if (preferredEngine !== 'playwright') {
      try {
        return await this.launchSparticuz();
      } catch (err) {
        this.recordLaunchError('sparticuz', err);
      }
    }

    if (preferredEngine !== 'sparticuz-only') {
      try {
        return await this.launchPlaywright();
      } catch (err) {
        this.recordLaunchError('playwright', err);
      }
    }

    const details = this.launchErrors.map(item => `${item.provider}: ${item.message}`).join(' | ');
    throw new Error(`No compatible Chromium engine could be launched. ${details}`);
  }

  async launchSparticuz() {
    // All crawler sessions share one extraction promise. Without this lock, two
    // simultaneous cold starts can execute Chromium while the other call is still
    // replacing the binary, which Linux rejects with ETXTBSY (text file busy).
    const { sparticuzChromium, executablePath } = await getSparticuzRuntime();
    const useSingleProcess = process.env.CHROMIUM_SINGLE_PROCESS === 'true';
    const incompatibleHostingerArgs = new Set(['--single-process', '--no-zygote']);
    const serverlessArgs = sparticuzChromium.args.filter(arg => useSingleProcess || !incompatibleHostingerArgs.has(arg));
    const launchOptions = {
      headless: true,
      executablePath,
      args: [...new Set([
        ...serverlessArgs,
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage'
      ])]
    };
    if (this.proxy) launchOptions.proxy = { server: this.proxy };

    console.log('Launching Hostinger-compatible @sparticuz/chromium at:', executablePath);
    let browser = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        browser = await chromium.launch(launchOptions);
        break;
      } catch (error) {
        const isExecutableBusy = /ETXTBSY|text file busy/i.test(error?.message || '');
        if (!isExecutableBusy || attempt === 3) throw error;
        const retryDelayMs = attempt * 300;
        console.warn(`Chromium executable is temporarily busy; retrying launch in ${retryDelayMs}ms.`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    this.provider = 'sparticuz';
    this.executablePath = executablePath;
    this.browserVersion = browser.version();
    console.log(`Chromium started successfully with @sparticuz/chromium (${this.browserVersion}).`);
    return browser;
  }

  async launchPlaywright() {
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      throw new Error('No local Playwright Chromium executable was found. Run "npx playwright install chromium" for local development.');
    }

    ensureExecutablePermission(executablePath);
    const args = ['--disable-blink-features=AutomationControlled'];
    if (process.platform === 'linux') {
      args.push(
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      );
      if (process.env.CHROMIUM_SINGLE_PROCESS === 'true') {
        args.push('--no-zygote', '--single-process');
      }
    }

    const launchOptions = {
      headless: this.headless,
      executablePath,
      args
    };
    if (this.proxy) launchOptions.proxy = { server: this.proxy };

    console.log('Launching local Playwright Chromium at:', executablePath);
    const browser = await chromium.launch(launchOptions);
    this.provider = 'playwright';
    this.executablePath = executablePath;
    this.browserVersion = browser.version();
    console.log(`Chromium started successfully with Playwright (${this.browserVersion}).`);
    return browser;
  }

  recordLaunchError(provider, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.launchErrors.push({ provider, message });
    console.error(`Chromium launch failed using ${provider}:`, message);
  }

  getDiagnostics() {
    return {
      available: Boolean(this.browser),
      provider: this.provider,
      executablePath: this.executablePath,
      browserVersion: this.browserVersion,
      launchErrors: [...this.launchErrors],
      launchCount: this.launchCount,
      restartCount: this.restartCount,
      disconnectCount: this.disconnectCount
    };
  }

  async restart(reason = 'browser recovery') {
    if (this.restartPromise) return this.restartPromise;

    this.restartPromise = (async () => {
      console.warn(`Restarting Chromium after ${reason}.`);
      await this.close();
      this.restartCount++;
      return this.init();
    })();

    try {
      return await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
  }

  async createPageContext() {
    const browser = await this.init();

    const locale = this.geo?.locale || 'en-US';
    const timezoneId = this.geo?.timezoneId || 'UTC';
    const geolocation = this.geo?.geolocation || null;
    const ip = this.geo?.ip || '154.160.0.1';
    const countryCode = this.geo?.countryCode || 'US';

    const extraHeaders = {
      'Accept-Language': `${locale},en;q=0.9`,
      'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'X-Forwarded-For': ip,
      'CF-IPCountry': countryCode,
      'X-Real-IP': ip,
      'X-Country-Code': countryCode,
      'X-Geo-Country': countryCode
    };

    const contextOptions = {
      userAgent: this.userAgent,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale,
      timezoneId,
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      extraHTTPHeaders: extraHeaders
    };

    if (geolocation) {
      contextOptions.geolocation = geolocation;
      contextOptions.permissions = ['geolocation'];
    }

    const context = await browser.newContext(contextOptions);

    // SEO extraction only needs the DOM. Avoid expensive media, font, analytics, and
    // anti-bot resources that can exhaust managed-hosting browser memory.
    await context.route('**/*', async route => {
      const request = route.request();
      const resourceType = request.resourceType();
      const requestUrl = request.url();
      const isHeavyAsset = resourceType === 'image' || resourceType === 'media' || resourceType === 'font';
      const isNonEssentialThirdParty = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|connect\.facebook\.net|\/recaptcha\//i.test(requestUrl);

      try {
        if (isHeavyAsset || isNonEssentialThirdParty) {
          await route.abort();
        } else {
          await route.continue();
        }
      } catch (e) {}
    });

    // Mask webdriver and set geo scripts
    await context.addInitScript(({ spoofLocale, spoofTimezone }) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (spoofLocale) {
        Object.defineProperty(navigator, 'language', { get: () => spoofLocale });
        Object.defineProperty(navigator, 'languages', { get: () => [spoofLocale, 'en'] });
      }
    }, { spoofLocale: locale, spoofTimezone: timezoneId });

    const page = await context.newPage();

    // Prevent cross-domain client redirect if target hostname is set
    if (this.blockCrossDomainRedirects && this.targetHostname) {
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          try {
            const currentHost = new URL(frame.url()).hostname;
            if (currentHost && currentHost !== this.targetHostname && !currentHost.endsWith('.' + this.targetHostname)) {
              console.warn(`[Geo Guard] Blocked cross-domain redirect to ${currentHost}, remaining on target ${this.targetHostname}`);
            }
          } catch (e) {}
        }
      });
    }

    return { context, page };
  }

  /**
   * Smoothly scroll down the page and any inner scrollable containers (Nuxt, Next, SPAs)
   */
  async autoScroll(page, maxScrollTimeMs = 3000) {
    try {
      await page.evaluate(async (maxTime) => {
        await new Promise((resolve) => {
          const startTime = Date.now();
          const distance = 400;

          // Find all potential scrollable elements in SPAs
          const scrollContainers = [
            window,
            document.querySelector('#main-content'),
            document.querySelector('main'),
            document.querySelector('[class*="overflow-y-auto"]'),
            document.querySelector('[class*="scroll"]'),
            document.body,
            document.documentElement
          ].filter(Boolean);

          const timer = setInterval(() => {
            for (const target of scrollContainers) {
              try {
                if (target === window) {
                  window.scrollBy(0, distance);
                } else if (target.scrollBy) {
                  target.scrollBy(0, distance);
                }
              } catch (e) {}
            }

            if (Date.now() - startTime >= maxTime) {
              clearInterval(timer);
              resolve();
            }
          }, 150);
        });
      }, maxScrollTimeMs);
    } catch (err) {
      // Non-fatal if page was destroyed or frame detached
    }
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }
}
