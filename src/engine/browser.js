import { chromium } from 'playwright';

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
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      };

      if (this.proxy) {
        launchOptions.proxy = {
          server: this.proxy
        };
      }

      this.browser = await chromium.launch(launchOptions);
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
