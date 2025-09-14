import { inngest } from "../mastra/inngest";
import { webScrapingTool } from "../mastra/tools/webScrapingTool";
import { dealFilteringTool } from "../mastra/tools/dealFilteringTool";
import { dealStorage } from "../mastra/storage";

// Trigger for scraping electronics deals every 4 hours
export const electronicsScrapingTrigger = inngest.createFunction(
  { id: "electronics-deal-scraper" },
  { cron: "0 */4 * * *" }, // Every 4 hours
  async ({ event, step }) => {
    const logger = console; // Basic logging

    try {
      logger.log("🔄 Starting scheduled electronics scraping...");

      // Execute scraping tool for electronics
      const scrapingResult = await step.run("scrape-electronics", async () => {
        return await webScrapingTool.execute({
          context: { 
            searchQuery: "electronics deals clearance sale",
            sites: ["Amazon", "eBay", "Walmart", "Best Buy", "Target"],
            maxResults: 100
          },
          mastra: null // Using null for scheduled trigger
        });
      });

      if (!scrapingResult.success) {
        throw new Error(`Scraping failed: ${scrapingResult.error}`);
      }

      logger.log(`✅ Scraped ${scrapingResult.totalResults} deals from ${scrapingResult.sitesProcessed} sites`);

      // Filter deals with AI
      const filteringResult = await step.run("filter-deals", async () => {
        return await dealFilteringTool.execute({
          context: {
            deals: scrapingResult.deals,
            minDiscountPercentage: 70,
            minConfidenceScore: 60,
            maxResults: 50
          },
          mastra: null
        });
      });

      logger.log(`🧠 AI filtered to ${filteringResult.filteredDeals.length} high-quality deals`);

      // Save filtered deals to storage
      const savedDeals = await step.run("save-deals", async () => {
        const saved = [];
        for (const deal of filteringResult.filteredDeals) {
          try {
            const savedDeal = await dealStorage.saveDeal(deal);
            saved.push(savedDeal);
          } catch (error) {
            logger.warn(`Failed to save deal: ${deal.title}`, error);
          }
        }
        return saved;
      });

      logger.log(`💾 Saved ${savedDeals.length} deals to storage`);

      return {
        success: true,
        totalScraped: scrapingResult.totalResults,
        sitesProcessed: scrapingResult.sitesProcessed,
        filteredDeals: filteringResult.filteredDeals.length,
        savedDeals: savedDeals.length,
        topDeal: savedDeals[0]?.title,
        summary: filteringResult.filteringSummary
      };

    } catch (error) {
      logger.error("❌ Scheduled scraping failed:", error);
      throw error;
    }
  }
);

// Trigger for scraping home and garden deals every 6 hours
export const homeGardenScrapingTrigger = inngest.createFunction(
  { id: "home-garden-deal-scraper" },
  { cron: "0 */6 * * *" }, // Every 6 hours
  async ({ event, step }) => {
    const logger = console;

    try {
      logger.log("🏠 Starting scheduled home & garden scraping...");

      const scrapingResult = await step.run("scrape-home-garden", async () => {
        return await webScrapingTool.execute({
          context: { 
            searchQuery: "home garden tools furniture clearance",
            sites: ["Amazon", "eBay", "Walmart", "Target"],
            maxResults: 80
          },
          mastra: null
        });
      });

      if (!scrapingResult.success) {
        throw new Error(`Scraping failed: ${scrapingResult.error}`);
      }

      const filteringResult = await step.run("filter-deals", async () => {
        return await dealFilteringTool.execute({
          context: {
            deals: scrapingResult.deals,
            minDiscountPercentage: 60,
            minConfidenceScore: 55,
            maxResults: 40
          },
          mastra: null
        });
      });

      const savedDeals = await step.run("save-deals", async () => {
        const saved = [];
        for (const deal of filteringResult.filteredDeals) {
          try {
            const savedDeal = await dealStorage.saveDeal(deal);
            saved.push(savedDeal);
          } catch (error) {
            logger.warn(`Failed to save deal: ${deal.title}`, error);
          }
        }
        return saved;
      });

      return {
        success: true,
        category: "home-garden",
        totalScraped: scrapingResult.totalResults,
        savedDeals: savedDeals.length
      };

    } catch (error) {
      logger.error("❌ Home & garden scraping failed:", error);
      throw error;
    }
  }
);

// Trigger for high-frequency fashion deals scraping every 8 hours
export const fashionScrapingTrigger = inngest.createFunction(
  { id: "fashion-deal-scraper" },
  { cron: "0 */8 * * *" }, // Every 8 hours
  async ({ event, step }) => {
    const logger = console;

    try {
      logger.log("👗 Starting scheduled fashion scraping...");

      const scrapingResult = await step.run("scrape-fashion", async () => {
        return await webScrapingTool.execute({
          context: { 
            searchQuery: "clothing shoes accessories sale clearance",
            sites: ["Amazon", "eBay", "Target"],
            maxResults: 60
          },
          mastra: null
        });
      });

      if (!scrapingResult.success) {
        throw new Error(`Scraping failed: ${scrapingResult.error}`);
      }

      const filteringResult = await step.run("filter-deals", async () => {
        return await dealFilteringTool.execute({
          context: {
            deals: scrapingResult.deals,
            minDiscountPercentage: 50,
            minConfidenceScore: 50,
            maxResults: 30
          },
          mastra: null
        });
      });

      const savedDeals = await step.run("save-deals", async () => {
        const saved = [];
        for (const deal of filteringResult.filteredDeals) {
          try {
            const savedDeal = await dealStorage.saveDeal(deal);
            saved.push(savedDeal);
          } catch (error) {
            logger.warn(`Failed to save deal: ${deal.title}`, error);
          }
        }
        return saved;
      });

      return {
        success: true,
        category: "fashion",
        totalScraped: scrapingResult.totalResults,
        savedDeals: savedDeals.length
      };

    } catch (error) {
      logger.error("❌ Fashion scraping failed:", error);
      throw error;
    }
  }
);

// Manual trigger for pricing glitch detection (can be called on-demand)
export const pricingGlitchDetectionTrigger = inngest.createFunction(
  { id: "pricing-glitch-detector" },
  { event: "pricing-glitch/detect" },
  async ({ event, step }) => {
    const logger = console;

    try {
      logger.log("⚡ Starting pricing glitch detection...");

      // High-value electronics most likely to have pricing glitches
      const scrapingResult = await step.run("scrape-high-value-electronics", async () => {
        return await webScrapingTool.execute({
          context: { 
            searchQuery: "apple iphone samsung laptop gaming console",
            sites: ["Amazon", "eBay", "Walmart", "Best Buy", "Target"],
            maxResults: 200
          },
          mastra: null
        });
      });

      if (!scrapingResult.success) {
        throw new Error(`Scraping failed: ${scrapingResult.error}`);
      }

      // More aggressive filtering for pricing glitches
      const filteringResult = await step.run("detect-glitches", async () => {
        return await dealFilteringTool.execute({
          context: {
            deals: scrapingResult.deals,
            minDiscountPercentage: 80, // Very high discounts
            minConfidenceScore: 70,    // High confidence required
            maxResults: 25
          },
          mastra: null
        });
      });

      // Only save deals with high pricing glitch probability
      const glitchDeals = filteringResult.filteredDeals.filter(
        deal => deal.pricingGlitchProbability >= 70
      );

      const savedDeals = await step.run("save-glitch-deals", async () => {
        const saved = [];
        for (const deal of glitchDeals) {
          try {
            const savedDeal = await dealStorage.saveDeal({
              ...deal,
              tags: ['pricing-glitch', 'high-value']
            });
            saved.push(savedDeal);
          } catch (error) {
            logger.warn(`Failed to save glitch deal: ${deal.title}`, error);
          }
        }
        return saved;
      });

      logger.log(`⚡ Found ${savedDeals.length} potential pricing glitches`);

      return {
        success: true,
        totalScraped: scrapingResult.totalResults,
        potentialGlitches: savedDeals.length,
        topGlitch: savedDeals[0]?.title,
        avgGlitchProbability: savedDeals.length > 0 
          ? Math.round(savedDeals.reduce((sum, d) => sum + d.pricingGlitchProbability, 0) / savedDeals.length)
          : 0
      };

    } catch (error) {
      logger.error("❌ Pricing glitch detection failed:", error);
      throw error;
    }
  }
);