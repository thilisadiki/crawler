import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function findChromiumExecutable() {
  const candidateDirs = [
    '/home/u178924454/.cache/ms-playwright',
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
  } catch (e) {
    try {
      execSync(`chmod 755 "${filePath}"`);
    } catch (err) {}
  }
}

export class BrowserManager {
  constructor(options = {}) {
    this.browser = null;
    this.headless = options.headless !== undefined ? options.headless : true;
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.proxy = options.proxy || null;
    this.geo = options.geo || null;
    this.blockCrossDomainRedirects = options.blockCrossDomainRedirects !== false;
    this.targetHostname = options.targetHostname || '';
  }

  async init() {
    if (!this.browser) {
      const launchOptions = {
        headless: this.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      };

      const detectedExe = findChromiumExecutable();
      if (detectedExe) {
        ensureExecutablePermission(detectedExe);
        launchOptions.executablePath = detectedExe;
        console.log('Using detected Chromium executable at:', detectedExe);
      }

      if (this.proxy) {
        launchOptions.proxy = {
          server: this.proxy
        };
      }

      try {
        this.browser = await chromium.launch(launchOptions);
      } catch (err) {
        console.warn('Standard Chromium launch failed (' + err.message + '). Attempting bundled cloud binary fallback...');
        try {
          const sparticuzChromium = (await import('@sparticuz/chromium')).default;
          const sparticuzExe = await sparticuzChromium.executablePath();
          if (sparticuzExe) {
            ensureExecutablePermission(sparticuzExe);
            console.log('Using standalone @sparticuz/chromium binary at:', sparticuzExe);
            const sparticuzLaunchOptions = {
              headless: true,
              executablePath: sparticuzExe,
              args: [
                ...sparticuzChromium.args,
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--no-sandbox',
                '--disable-setuid-sandbox'
              ]
            };
            if (this.proxy) sparticuzLaunchOptions.proxy = { server: this.proxy };
            this.browser = await chromium.launch(sparticuzLaunchOptions);
            return this.browser;
          }
        } catch (sparticuzErr) {
          console.warn('@sparticuz/chromium fallback error:', sparticuzErr.message);
        }

        if (err.message.includes("Executable doesn't exist") || err.message.includes("playwright install")) {
          console.warn('Chromium executable missing. Running automatic runtime install...');
          try {
            execSync('npx playwright install chromium', { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' } });
            const retryExe = findChromiumExecutable();
            if (retryExe) {
              ensureExecutablePermission(retryExe);
              launchOptions.executablePath = retryExe;
            }
            this.browser = await chromium.launch(launchOptions);
          } catch (installErr) {
            console.error('Failed to auto-install Playwright Chromium:', installErr);
            throw installErr;
          }
        } else {
          console.warn('Attempting single-process fallback launch:', err.message);
          if (launchOptions.executablePath) ensureExecutablePermission(launchOptions.executablePath);
          launchOptions.args.push('--single-process');
          this.browser = await chromium.launch(launchOptions);
        }
      }
    }
    return this.browser;
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
      extraHTTPHeaders: extraHeaders
    };

    if (geolocation) {
      contextOptions.geolocation = geolocation;
      contextOptions.permissions = ['geolocation'];
    }

    const context = await browser.newContext(contextOptions);

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
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
