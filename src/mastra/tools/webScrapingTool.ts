import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "puppeteer";
import * as cheerio from "cheerio";
import axios, { AxiosRequestConfig } from "axios";
import UserAgent from "user-agents";

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Define the deal data structure
const DealSchema = z.object({
  title: z.string().describe("Product title"),
  originalPrice: z.number().nullable().describe("Original price in USD"),
  currentPrice: z.number().describe("Current/sale price in USD"),
  discountPercentage: z.number().describe("Discount percentage"),
  url: z.string().describe("Product URL"),
  image: z.string().nullable().describe("Product image URL"),
  site: z.string().describe("Website name"),
  availability: z.string().describe("Product availability status"),
});

type Deal = z.infer<typeof DealSchema>;

// Premium proxy configuration - use environment variables for production
// Free proxies are unreliable and unsafe for production use
const getProxyList = (): string[] => {
  // Use premium proxy service if configured
  if (process.env.PROXY_SERVICE_URL) {
    return [process.env.PROXY_SERVICE_URL];
  }
  
  // Fallback to rotating free proxies (not recommended for production)
  return [
    'http://proxy.toolip.io:31337',
    'http://proxy-server.scraperapi.com:8001',
    'http://gateway.scraperapi.com:8001'
  ];
};

const PROXY_LIST = getProxyList();

// Proxy health status cache
const PROXY_HEALTH: Map<string, { working: boolean; lastChecked: number }> = new Map();
const PROXY_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// User agent rotation setup
const userAgentGenerator = new UserAgent();

// Site-specific selectors and parsers
interface SiteConfig {
  name: string;
  baseUrl: string;
  searchUrl: (query: string) => string;
  requiresJS: boolean;
  selectors: {
    productContainer: string;
    title: string;
    originalPrice?: string;
    currentPrice: string;
    image: string;
    link: string;
    availability?: string;
  };
  priceParser: (priceText: string) => number | null;
}

const SITE_CONFIGS: SiteConfig[] = [
  {
    name: "Amazon",
    baseUrl: "https://www.amazon.com",
    searchUrl: (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}&ref=sr_pg_1`,
    requiresJS: true,
    selectors: {
      productContainer: '[data-component-type="s-search-result"]',
      title: 'h2 a span, h2 span',
      originalPrice: '.a-price-was, .a-text-price',
      currentPrice: '.a-price-current, .a-price',
      image: 'img.s-image',
      link: 'h2 a',
      availability: '.a-size-base-plus',
    },
    priceParser: (text) => {
      // Enhanced price parsing to handle cents, ranges, and multiple price formats
      const cleanText = text.replace(/[,$]/g, '').replace(/\s+/g, ' ').trim();
      
      // Handle separate dollar and cent elements (e.g., "99" + "99" for $99.99)
      const dollarsAndCents = cleanText.match(/(\d+)\s*(\d{2})(?!\d)/);
      if (dollarsAndCents && dollarsAndCents[2].length === 2) {
        return parseFloat(dollarsAndCents[1] + '.' + dollarsAndCents[2]);
      }
      
      // Handle price ranges (take the lower price)
      const rangeMatch = cleanText.match(/(\d+\.?\d{0,2})\s*-\s*(\d+\.?\d{0,2})/);
      if (rangeMatch) {
        return parseFloat(rangeMatch[1]);
      }
      
      // Handle standard price with optional cents
      const priceMatch = cleanText.match(/(\d+)(?:\.(\d{1,2}))?/);
      if (priceMatch) {
        const dollars = parseInt(priceMatch[1]);
        const cents = priceMatch[2] ? parseInt(priceMatch[2].padEnd(2, '0')) : 0;
        return dollars + (cents / 100);
      }
      
      return null;
    },
  },
  {
    name: "eBay",
    baseUrl: "https://www.ebay.com",
    searchUrl: (query) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`,
    requiresJS: false,
    selectors: {
      productContainer: '.s-item',
      title: '.s-item__title',
      originalPrice: '.s-item__trending-price .STRIKETHROUGH',
      currentPrice: '.s-item__price',
      image: '.s-item__image img',
      link: '.s-item__link',
    },
    priceParser: (text) => {
      // Enhanced price parsing to handle cents, ranges, and multiple price formats
      const cleanText = text.replace(/[,$]/g, '').replace(/\s+/g, ' ').trim();
      
      // Handle separate dollar and cent elements (e.g., "99" + "99" for $99.99)
      const dollarsAndCents = cleanText.match(/(\d+)\s*(\d{2})(?!\d)/);
      if (dollarsAndCents && dollarsAndCents[2].length === 2) {
        return parseFloat(dollarsAndCents[1] + '.' + dollarsAndCents[2]);
      }
      
      // Handle price ranges (take the lower price)
      const rangeMatch = cleanText.match(/(\d+\.?\d{0,2})\s*-\s*(\d+\.?\d{0,2})/);
      if (rangeMatch) {
        return parseFloat(rangeMatch[1]);
      }
      
      // Handle standard price with optional cents
      const priceMatch = cleanText.match(/(\d+)(?:\.(\d{1,2}))?/);
      if (priceMatch) {
        const dollars = parseInt(priceMatch[1]);
        const cents = priceMatch[2] ? parseInt(priceMatch[2].padEnd(2, '0')) : 0;
        return dollars + (cents / 100);
      }
      
      return null;
    },
  },
  {
    name: "Walmart",
    baseUrl: "https://www.walmart.com",
    searchUrl: (query) => `https://www.walmart.com/search?q=${encodeURIComponent(query)}`,
    requiresJS: true,
    selectors: {
      productContainer: '[data-testid="item"]',
      title: '[data-testid="product-title"]',
      originalPrice: '[data-testid="product-price-strikethrough"]',
      currentPrice: '[data-testid="product-price"]',
      image: '[data-testid="product-image"] img',
      link: 'a',
    },
    priceParser: (text) => {
      // Enhanced price parsing to handle cents, ranges, and multiple price formats
      const cleanText = text.replace(/[,$]/g, '').replace(/\s+/g, ' ').trim();
      
      // Handle separate dollar and cent elements (e.g., "99" + "99" for $99.99)
      const dollarsAndCents = cleanText.match(/(\d+)\s*(\d{2})(?!\d)/);
      if (dollarsAndCents && dollarsAndCents[2].length === 2) {
        return parseFloat(dollarsAndCents[1] + '.' + dollarsAndCents[2]);
      }
      
      // Handle price ranges (take the lower price)
      const rangeMatch = cleanText.match(/(\d+\.?\d{0,2})\s*-\s*(\d+\.?\d{0,2})/);
      if (rangeMatch) {
        return parseFloat(rangeMatch[1]);
      }
      
      // Handle standard price with optional cents
      const priceMatch = cleanText.match(/(\d+)(?:\.(\d{1,2}))?/);
      if (priceMatch) {
        const dollars = parseInt(priceMatch[1]);
        const cents = priceMatch[2] ? parseInt(priceMatch[2].padEnd(2, '0')) : 0;
        return dollars + (cents / 100);
      }
      
      return null;
    },
  },
  {
    name: "Best Buy",
    baseUrl: "https://www.bestbuy.com",
    searchUrl: (query) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(query)}`,
    requiresJS: true,
    selectors: {
      productContainer: '.sku-item',
      title: '.sku-header a',
      originalPrice: '.sr-only, .visuallyhidden',  // Fixed: removed :contains selector
      currentPrice: '.pricing-current-price',
      image: '.product-image img',
      link: '.sku-header a',
    },
    priceParser: (text) => {
      // Enhanced price parsing to handle cents, ranges, and multiple price formats
      const cleanText = text.replace(/[,$]/g, '').replace(/\s+/g, ' ').trim();
      
      // Handle separate dollar and cent elements (e.g., "99" + "99" for $99.99)
      const dollarsAndCents = cleanText.match(/(\d+)\s*(\d{2})(?!\d)/);
      if (dollarsAndCents && dollarsAndCents[2].length === 2) {
        return parseFloat(dollarsAndCents[1] + '.' + dollarsAndCents[2]);
      }
      
      // Handle price ranges (take the lower price)
      const rangeMatch = cleanText.match(/(\d+\.?\d{0,2})\s*-\s*(\d+\.?\d{0,2})/);
      if (rangeMatch) {
        return parseFloat(rangeMatch[1]);
      }
      
      // Handle standard price with optional cents
      const priceMatch = cleanText.match(/(\d+)(?:\.(\d{1,2}))?/);
      if (priceMatch) {
        const dollars = parseInt(priceMatch[1]);
        const cents = priceMatch[2] ? parseInt(priceMatch[2].padEnd(2, '0')) : 0;
        return dollars + (cents / 100);
      }
      
      return null;
    },
  },
  {
    name: "Target",
    baseUrl: "https://www.target.com",
    searchUrl: (query) => `https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`,
    requiresJS: true,
    selectors: {
      productContainer: '[data-test="product-item"]',
      title: '[data-test="product-title"]',
      originalPrice: '[data-test="product-price-reg"]',
      currentPrice: '[data-test="product-price"]',
      image: '[data-test="product-image"] img',
      link: 'a',
      availability: '[data-test="fulfillment-availability"]',
    },
    priceParser: (text) => {
      // Enhanced price parsing to handle cents, ranges, and multiple price formats
      const cleanText = text.replace(/[,$]/g, '').replace(/\s+/g, ' ').trim();
      
      // Handle separate dollar and cent elements (e.g., "99" + "99" for $99.99)
      const dollarsAndCents = cleanText.match(/(\d+)\s*(\d{2})(?!\d)/);
      if (dollarsAndCents && dollarsAndCents[2].length === 2) {
        return parseFloat(dollarsAndCents[1] + '.' + dollarsAndCents[2]);
      }
      
      // Handle price ranges (take the lower price)
      const rangeMatch = cleanText.match(/(\d+\.?\d{0,2})\s*-\s*(\d+\.?\d{0,2})/);
      if (rangeMatch) {
        return parseFloat(rangeMatch[1]);
      }
      
      // Handle standard price with optional cents
      const priceMatch = cleanText.match(/(\d+)(?:\.(\d{1,2}))?/);
      if (priceMatch) {
        const dollars = parseInt(priceMatch[1]);
        const cents = priceMatch[2] ? parseInt(priceMatch[2].padEnd(2, '0')) : 0;
        return dollars + (cents / 100);
      }
      
      return null;
    },
  },
];

class WebScrapingService {
  private browser: Browser | null = null;
  private proxyIndex = 0;
  private logger?: IMastraLogger;

  constructor(logger?: IMastraLogger) {
    this.logger = logger;
  }

  private async checkProxyHealth(proxy: string): Promise<boolean> {
    const cached = PROXY_HEALTH.get(proxy);
    const now = Date.now();
    
    // Use cached result if recent
    if (cached && (now - cached.lastChecked) < PROXY_CHECK_INTERVAL) {
      return cached.working;
    }

    try {
      this.logger?.info('🔍 [WebScrapingService] Checking proxy health:', { proxy });
      
      const response = await axios.get('https://httpbin.org/ip', {
        proxy: {
          protocol: new URL(proxy).protocol.replace(':', '') as 'http' | 'https',
          host: new URL(proxy).hostname,
          port: parseInt(new URL(proxy).port),
        },
        timeout: 5000,
      });
      
      const isWorking = response.status === 200;
      PROXY_HEALTH.set(proxy, { working: isWorking, lastChecked: now });
      
      this.logger?.info('✅ [WebScrapingService] Proxy health check completed:', { proxy, working: isWorking });
      return isWorking;
      
    } catch (error) {
      PROXY_HEALTH.set(proxy, { working: false, lastChecked: now });
      this.logger?.warn('⚠️ [WebScrapingService] Proxy health check failed:', { proxy, error: error instanceof Error ? error.message : error });
      return false;
    }
  }

  private async getNextProxy(): Promise<string | undefined> {
    if (PROXY_LIST.length === 0) return undefined;
    
    // Try to find a working proxy
    for (let attempts = 0; attempts < PROXY_LIST.length; attempts++) {
      const proxy = PROXY_LIST[this.proxyIndex % PROXY_LIST.length];
      this.proxyIndex++;
      
      if (await this.checkProxyHealth(proxy)) {
        this.logger?.info('🌐 [WebScrapingService] Using healthy proxy:', { proxy });
        return proxy;
      }
    }
    
    this.logger?.warn('⚠️ [WebScrapingService] No healthy proxies available, using direct connection');
    return undefined;
  }

  private getRandomUserAgent(): string {
    return userAgentGenerator.random().toString();
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    siteName: string = 'Unknown'
  ): Promise<T> {
    let lastError: Error = new Error('Operation failed');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger?.info('🔄 [WebScrapingService] Attempting operation:', { siteName, attempt, maxRetries });
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger?.warn('⚠️ [WebScrapingService] Operation failed, retrying:', { 
          siteName, 
          attempt, 
          maxRetries, 
          error: lastError.message 
        });
        
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
          await this.sleep(delay);
        }
      }
    }
    
    this.logger?.error('❌ [WebScrapingService] Operation failed after all retries:', { 
      siteName, 
      maxRetries, 
      finalError: lastError.message 
    });
    throw lastError;
  }

  async initBrowser(): Promise<void> {
    if (this.browser) return;

    this.logger?.info('🚀 [WebScrapingService] Initializing browser...');
    
    const browserOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: true,
      // Enhanced anti-detection browser arguments
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-web-security',
        '--disable-features=site-per-process',
        '--aggressive-cache-discard',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
        '--max_old_space_size=4096',
        // Additional anti-detection measures
        '--disable-features=TranslateUI',
        '--disable-features=BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-extensions-file-access-check',
        '--disable-component-extensions-with-background-pages',
        '--disable-permissions-api',
        '--disable-features=VizDisplayCompositor',
        '--user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"'
      ],
      defaultViewport: { width: 1920, height: 1080 },
      timeout: 60000,
    };

    // Add proxy if available
    const proxy = await this.getNextProxy();
    if (proxy) {
      const proxyUrl = new URL(proxy);
      browserOptions.args?.push(`--proxy-server=${proxyUrl.origin}`);
      this.logger?.info('🌐 [WebScrapingService] Using proxy for browser:', { proxy: proxyUrl.origin });
    }

    this.browser = await puppeteer.launch(browserOptions);
    this.logger?.info('✅ [WebScrapingService] Browser initialized successfully');
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.logger?.info('🔒 [WebScrapingService] Browser closed');
    }
  }

  private async scrapeWithPuppeteer(url: string, siteConfig: SiteConfig): Promise<Deal[]> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    this.logger?.info('🤖 [WebScrapingService] Scraping with Puppeteer:', { url, site: siteConfig.name });

    const page = await this.browser.newPage();
    
    try {
      // Set random user agent and additional anti-detection measures
      await page.setUserAgent(this.getRandomUserAgent());
      
      // Set viewport with some randomization
      const viewports = [
        { width: 1920, height: 1080 },
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 }
      ];
      const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];
      await page.setViewport(randomViewport);

      // Block unnecessary resources for better performance and stealth
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Remove automation indicators
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
        
        window.chrome = {
          runtime: {},
        };
      });

      // Navigate with timeout
      await page.goto(url, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });

      // Wait for content to load
      await page.waitForSelector(siteConfig.selectors.productContainer, { timeout: 10000 });

      // Extract data
      const deals = await page.evaluate((config) => {
        const products = document.querySelectorAll(config.selectors.productContainer);
        const results: any[] = [];

        products.forEach((product, index) => {
          if (index >= 20) return; // Limit results for performance

          try {
            const titleEl = product.querySelector(config.selectors.title);
            const currentPriceEl = product.querySelector(config.selectors.currentPrice);
            const originalPriceEl = config.selectors.originalPrice ? 
              product.querySelector(config.selectors.originalPrice) : null;
            const imageEl = product.querySelector(config.selectors.image);
            const linkEl = product.querySelector(config.selectors.link);
            const availabilityEl = config.selectors.availability ?
              product.querySelector(config.selectors.availability) : null;

            if (!titleEl || !currentPriceEl) return;

            const title = titleEl.textContent?.trim();
            const currentPriceText = currentPriceEl.textContent?.trim();
            const originalPriceText = originalPriceEl?.textContent?.trim();
            const imageUrl = imageEl?.getAttribute('src') || imageEl?.getAttribute('data-src');
            const productUrl = linkEl?.getAttribute('href');
            const availability = availabilityEl?.textContent?.trim() || 'Unknown';

            if (!title || !currentPriceText) return;

            results.push({
              title,
              currentPriceText,
              originalPriceText,
              imageUrl,
              productUrl,
              availability,
            });
          } catch (err) {
            console.error('Error extracting product data:', err);
          }
        });

        return results;
      }, siteConfig);

      // Process the extracted data
      const processedDeals: Deal[] = [];

      for (const deal of deals) {
        try {
          const currentPrice = siteConfig.priceParser(deal.currentPriceText);
          const originalPrice = deal.originalPriceText ? 
            siteConfig.priceParser(deal.originalPriceText) : null;

          if (!currentPrice || currentPrice <= 0) continue;

          // Calculate discount
          let discountPercentage = 0;
          if (originalPrice && originalPrice > currentPrice) {
            discountPercentage = ((originalPrice - currentPrice) / originalPrice) * 100;
          }

          // Skip deals without significant discount - will be filtered later by minDiscountPercentage
          if (discountPercentage < 10) continue; // Only skip completely insignificant discounts

          // Construct full URL
          let fullUrl = deal.productUrl;
          if (fullUrl && !fullUrl.startsWith('http')) {
            fullUrl = siteConfig.baseUrl + (fullUrl.startsWith('/') ? '' : '/') + fullUrl;
          }

          // Construct full image URL
          let fullImageUrl = deal.imageUrl;
          if (fullImageUrl && !fullImageUrl.startsWith('http') && !fullImageUrl.startsWith('data:')) {
            fullImageUrl = siteConfig.baseUrl + (fullImageUrl.startsWith('/') ? '' : '/') + fullImageUrl;
          }

          const processedDeal: Deal = {
            title: deal.title,
            originalPrice,
            currentPrice,
            discountPercentage: Math.round(discountPercentage),
            url: fullUrl || url,
            image: fullImageUrl,
            site: siteConfig.name,
            availability: deal.availability,
          };

          processedDeals.push(processedDeal);
        } catch (err) {
          this.logger?.warn('⚠️ [WebScrapingService] Error processing deal:', { error: err });
        }
      }

      this.logger?.info('✅ [WebScrapingService] Puppeteer scraping completed:', { 
        site: siteConfig.name, 
        dealsFound: processedDeals.length 
      });

      return processedDeals;

    } catch (error) {
      this.logger?.error('❌ [WebScrapingService] Puppeteer scraping failed:', { 
        error: error instanceof Error ? error.message : error,
        site: siteConfig.name,
        url 
      });
      throw error;
    } finally {
      await page.close();
    }
  }

  private async scrapeWithCheerio(url: string, siteConfig: SiteConfig): Promise<Deal[]> {
    this.logger?.info('🕷️ [WebScrapingService] Scraping with Cheerio:', { url, site: siteConfig.name });

    try {
      const axiosConfig: AxiosRequestConfig = {
        timeout: 15000,
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
      };

      // Add proxy if available
      const proxy = await this.getNextProxy();
      if (proxy) {
        const proxyUrl = new URL(proxy);
        axiosConfig.proxy = {
          protocol: proxyUrl.protocol.replace(':', '') as 'http' | 'https',
          host: proxyUrl.hostname,
          port: parseInt(proxyUrl.port),
        };
        this.logger?.info('🌐 [WebScrapingService] Using proxy for Cheerio:', { proxy: proxyUrl.origin });
      }

      const response = await axios.get(url, axiosConfig);
      const $ = cheerio.load(response.data);

      const deals: Deal[] = [];
      const products = $(siteConfig.selectors.productContainer);

      this.logger?.info('📦 [WebScrapingService] Found products:', { count: products.length, site: siteConfig.name });

      products.each((index, element) => {
        if (index >= 20) return; // Limit results for performance

        try {
          const $product = $(element);
          
          const title = $product.find(siteConfig.selectors.title).text().trim();
          const currentPriceText = $product.find(siteConfig.selectors.currentPrice).text().trim();
          const originalPriceText = siteConfig.selectors.originalPrice ?
            $product.find(siteConfig.selectors.originalPrice).text().trim() : '';
          const imageUrl = $product.find(siteConfig.selectors.image).attr('src') ||
                          $product.find(siteConfig.selectors.image).attr('data-src') || null;
          const productUrl = $product.find(siteConfig.selectors.link).attr('href') || null;
          const availability = siteConfig.selectors.availability ?
            $product.find(siteConfig.selectors.availability).text().trim() : 'Unknown';

          if (!title || !currentPriceText) return;

          const currentPrice = siteConfig.priceParser(currentPriceText);
          const originalPrice = originalPriceText ? siteConfig.priceParser(originalPriceText) : null;

          if (!currentPrice || currentPrice <= 0) return;

          // Calculate discount
          let discountPercentage = 0;
          if (originalPrice && originalPrice > currentPrice) {
            discountPercentage = ((originalPrice - currentPrice) / originalPrice) * 100;
          }

          // Skip deals without significant discount - will be filtered later by minDiscountPercentage
          if (discountPercentage < 10) return; // Only skip completely insignificant discounts

          // Construct full URLs
          let fullUrl = productUrl;
          if (fullUrl && !fullUrl.startsWith('http')) {
            fullUrl = siteConfig.baseUrl + (fullUrl.startsWith('/') ? '' : '/') + fullUrl;
          }

          let fullImageUrl = imageUrl;
          if (fullImageUrl && !fullImageUrl.startsWith('http') && !fullImageUrl.startsWith('data:')) {
            fullImageUrl = siteConfig.baseUrl + (fullImageUrl.startsWith('/') ? '' : '/') + fullImageUrl;
          }

          const deal: Deal = {
            title,
            originalPrice,
            currentPrice,
            discountPercentage: Math.round(discountPercentage),
            url: fullUrl || url,
            image: fullImageUrl,
            site: siteConfig.name,
            availability,
          };

          deals.push(deal);
        } catch (err) {
          this.logger?.warn('⚠️ [WebScrapingService] Error processing product:', { error: err });
        }
      });

      this.logger?.info('✅ [WebScrapingService] Cheerio scraping completed:', { 
        site: siteConfig.name, 
        dealsFound: deals.length 
      });

      return deals;

    } catch (error) {
      this.logger?.error('❌ [WebScrapingService] Cheerio scraping failed:', { 
        error: error instanceof Error ? error.message : error,
        site: siteConfig.name,
        url 
      });
      throw error;
    }
  }

  async scrapeDeals(query: string, sitesToScrape?: string[]): Promise<Deal[]> {
    this.logger?.info('🔍 [WebScrapingService] Starting deal scraping:', { query, sitesToScrape });

    const allDeals: Deal[] = [];
    const sitesConfig = sitesToScrape ? 
      SITE_CONFIGS.filter(config => sitesToScrape.includes(config.name)) : 
      SITE_CONFIGS;

    // Initialize browser for JS-heavy sites, with fallback to Cheerio
    const hasJSSites = sitesConfig.some(config => config.requiresJS);
    let browserInitialized = false;
    if (hasJSSites) {
      try {
        await this.initBrowser();
        browserInitialized = true;
      } catch (error) {
        this.logger?.warn('⚠️ [WebScrapingService] Browser initialization failed, will use Cheerio for all sites:', { 
          error: error instanceof Error ? error.message : error 
        });
      }
    }

    // Telemetry data
    const telemetry = {
      sitesAttempted: sitesConfig.length,
      sitesSucceeded: 0,
      sitesFailed: 0,
      totalDeals: 0,
      errors: [] as string[]
    };

    for (const siteConfig of sitesConfig) {
      try {
        this.logger?.info('🏪 [WebScrapingService] Scraping site:', { site: siteConfig.name });

        const searchUrl = siteConfig.searchUrl(query);
        
        // Apply retry logic to scraping operations
        const siteDeals = await this.retryWithBackoff(async () => {
          if (siteConfig.requiresJS && browserInitialized) {
            return await this.scrapeWithPuppeteer(searchUrl, siteConfig);
          } else {
            // Use Cheerio as fallback if browser failed to initialize or site doesn't require JS
            return await this.scrapeWithCheerio(searchUrl, siteConfig);
          }
        }, 3, 2000, siteConfig.name);

        allDeals.push(...siteDeals);
        telemetry.sitesSucceeded++;
        telemetry.totalDeals += siteDeals.length;
        
        this.logger?.info('📊 [WebScrapingService] Site scraping completed:', { 
          site: siteConfig.name, 
          dealsFound: siteDeals.length 
        });

        // Add delay between sites to be respectful
        await this.sleep(2000);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        telemetry.sitesFailed++;
        telemetry.errors.push(`${siteConfig.name}: ${errorMsg}`);
        
        this.logger?.error('💥 [WebScrapingService] Site scraping failed after retries:', { 
          site: siteConfig.name,
          error: errorMsg 
        });
        // Continue with other sites even if one fails
      }
    }

    // Log comprehensive telemetry
    this.logger?.info('📈 [WebScrapingService] Scraping telemetry:', {
      query,
      sitesAttempted: telemetry.sitesAttempted,
      sitesSucceeded: telemetry.sitesSucceeded,
      sitesFailed: telemetry.sitesFailed,
      successRate: `${Math.round((telemetry.sitesSucceeded / telemetry.sitesAttempted) * 100)}%`,
      totalDealsFound: telemetry.totalDeals,
      errorsEncountered: telemetry.errors.length,
      errors: telemetry.errors.slice(0, 3) // Log first 3 errors to avoid spam
    });

    // Sort by discount percentage (highest first)
    const sortedDeals = allDeals.sort((a, b) => b.discountPercentage - a.discountPercentage);

    this.logger?.info('🎯 [WebScrapingService] Deal scraping completed:', { 
      totalDeals: sortedDeals.length,
      query 
    });

    return sortedDeals;
  }
}

export const webScrapingTool = createTool({
  id: "web-scraping-deal-finder",
  description: `Scrapes major e-commerce websites (Amazon, eBay, Walmart, Best Buy) to find products with high discounts (50%+ off). Uses both Puppeteer for JavaScript-heavy sites and Cheerio for lightweight scraping. Includes user-agent rotation and proxy support for reliability.`,
  inputSchema: z.object({
    query: z.string().describe("Search query for products (e.g., 'laptop', 'headphones', 'smartphone')"),
    sites: z.array(z.enum(["Amazon", "eBay", "Walmart", "Best Buy"])).optional().describe("Specific sites to scrape (defaults to all sites)"),
    minDiscountPercentage: z.number().min(0).max(100).default(90).describe("Minimum discount percentage to include in results"),
  }),
  outputSchema: z.object({
    deals: z.array(DealSchema),
    summary: z.object({
      totalDeals: z.number(),
      avgDiscount: z.number(),
      sitesScraped: z.array(z.string()),
      topDeal: DealSchema.nullable(),
    }),
  }),
  execute: async ({ context: { query, sites, minDiscountPercentage }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [WebScrapingTool] Starting execution with params:', { query, sites, minDiscountPercentage });

    const scraper = new WebScrapingService(logger);

    try {
      // Scrape deals from specified sites
      const allDeals = await scraper.scrapeDeals(query, sites);

      // Filter by minimum discount percentage
      const filteredDeals = allDeals.filter(deal => deal.discountPercentage >= minDiscountPercentage);

      // Calculate summary statistics
      const sitesScraped = [...new Set(allDeals.map(deal => deal.site))];
      const avgDiscount = filteredDeals.length > 0 ? 
        filteredDeals.reduce((sum, deal) => sum + deal.discountPercentage, 0) / filteredDeals.length : 0;
      const topDeal = filteredDeals.length > 0 ? filteredDeals[0] : null;

      const result = {
        deals: filteredDeals,
        summary: {
          totalDeals: filteredDeals.length,
          avgDiscount: Math.round(avgDiscount),
          sitesScraped,
          topDeal,
        },
      };

      logger?.info('✅ [WebScrapingTool] Execution completed successfully:', {
        totalDealsFound: result.deals.length,
        avgDiscount: result.summary.avgDiscount,
        sitesScraped: result.summary.sitesScraped,
        topDiscountPercentage: topDeal?.discountPercentage || 0,
      });

      return result;

    } catch (error) {
      logger?.error('❌ [WebScrapingTool] Execution failed:', {
        error: error instanceof Error ? error.message : error,
        query,
        sites,
      });
      throw error;
    } finally {
      // Always clean up browser resources
      await scraper.closeBrowser();
    }
  },
});