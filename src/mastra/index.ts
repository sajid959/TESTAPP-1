import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";
import { webScrapingTool } from "./tools/webScrapingTool";
import { dealFilteringTool } from "./tools/dealFilteringTool";

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  agents: {},
  workflows: {},
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: { webScrapingTool, dealFilteringTool },
    }),
  },
  bundler: {
    // A few dependencies are not properly picked up by
    // the bundler if they are not added directly to the
    // entrypoint.
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
    ],
    // sourcemaps are good for debugging.
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              // This is typically a non-retirable error. It means that the request was not
              // setup correctly to pass in the necessary parameters.
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            // Validation errors are never retriable.
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      // This API route is used to register the Mastra workflow (inngest function) on the inngest server
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
      // Dashboard API routes
      {
        path: "/api/deals",
        method: "GET",
        createHandler: async ({ mastra }) => {
          const { dealStorage } = await import("./storage");
          
          return async (c) => {
            try {
              const query = c.req.query();
              const limit = Math.min(parseInt(query.limit || "25"), 100); // Cap at 100
              const minDiscount = Math.max(0, parseInt(query.minDiscount || "50"));
              const site = query.site;
              
              // Whitelist allowed sort fields for security
              const allowedSorts = ['createdAt', 'discountPercentage', 'confidenceScore', 'pricingGlitchProbability'];
              const sort = allowedSorts.includes(query.sort) ? query.sort : "createdAt";
              const order = query.order === "asc" ? 1 : -1;

              const filters: any = {
                discountPercentage: { $gte: minDiscount }
              };

              if (site && site !== "all") {
                filters.site = site;
              }

              const sortObj: any = {};
              sortObj[sort] = order;

              const deals = await dealStorage.getDeals(filters, limit, sortObj);
              
              return c.json({ 
                success: true, 
                deals,
                count: deals.length,
                filters: { minDiscount, site, sort, order, limit }
              });
            } catch (error) {
              mastra?.getLogger()?.error("Error fetching deals:", error);
              return c.json({ 
                success: false, 
                error: error instanceof Error ? error.message : "Unknown error" 
              }, 500);
            }
          };
        },
      },
      {
        path: "/api/deals/top",
        method: "GET",
        createHandler: async ({ mastra }) => {
          const { dealStorage } = await import("./storage");
          
          return async (c) => {
            try {
              const query = c.req.query();
              const limit = parseInt(query.limit || "25");
              const minDiscount = parseInt(query.minDiscount || "70");

              const deals = await dealStorage.getTopDeals(minDiscount, limit);
              
              return c.json({ 
                success: true, 
                deals,
                count: deals.length,
                type: "top_deals"
              });
            } catch (error) {
              mastra?.getLogger()?.error("Error fetching top deals:", error);
              return c.json({ 
                success: false, 
                error: error instanceof Error ? error.message : "Unknown error" 
              }, 500);
            }
          };
        },
      },
      {
        path: "/api/deals/glitches",
        method: "GET",
        createHandler: async ({ mastra }) => {
          const { dealStorage } = await import("./storage");
          
          return async (c) => {
            try {
              const query = c.req.query();
              const limit = parseInt(query.limit || "25");
              const minProbability = parseInt(query.minProbability || "70");

              const deals = await dealStorage.getPricingGlitches(minProbability, limit);
              
              return c.json({ 
                success: true, 
                deals,
                count: deals.length,
                type: "pricing_glitches"
              });
            } catch (error) {
              mastra?.getLogger()?.error("Error fetching pricing glitches:", error);
              return c.json({ 
                success: false, 
                error: error instanceof Error ? error.message : "Unknown error" 
              }, 500);
            }
          };
        },
      },
      {
        path: "/api/scrape",
        method: "POST",
        createHandler: async ({ mastra }) => {
          const { webScrapingTool } = await import("./tools/webScrapingTool");
          const { dealFilteringTool } = await import("./tools/dealFilteringTool");
          const { dealStorage } = await import("./storage");
          
          return async (c) => {
            try {
              // Handle both JSON and form data
              let body: any;
              const contentType = c.req.header('content-type') || '';
              
              if (contentType.includes('application/json')) {
                body = await c.req.json();
              } else {
                // Handle form data or URL-encoded data
                const formData = await c.req.parseBody();
                body = {};
                
                // Parse HTMX vals if they exist
                if (formData.query) {
                  body.query = formData.query;
                }
                if (formData.sites) {
                  // Parse sites array if it's a JSON string
                  try {
                    body.sites = JSON.parse(formData.sites as string);
                  } catch {
                    body.sites = [formData.sites];
                  }
                }
              }
              
              const { query = "electronics", sites = ["Amazon", "eBay", "Walmart", "Best Buy", "Target"] } = body;
              
              mastra?.getLogger()?.info("Starting manual scrape:", { query, sites });
              
              // Execute scraping tool
              const scrapingResult = await webScrapingTool.execute({
                context: { query: query, sites: sites, minDiscountPercentage: 50 },
                mastra
              });
              
              if (!scrapingResult || !scrapingResult.deals) {
                throw new Error("Scraping failed - no deals returned");
              }
              
              // Filter deals with AI
              const filteringResult = await dealFilteringTool.execute({
                context: { 
                  deals: scrapingResult.deals,
                  minDiscountPercentage: 70,
                  minConfidenceScore: 60,
                  maxResults: 25
                },
                mastra
              });
              
              // Save filtered deals to MongoDB
              const savedDeals = [];
              for (const deal of filteringResult.filteredDeals) {
                try {
                  const savedDeal = await dealStorage.saveDeal(deal);
                  savedDeals.push(savedDeal);
                } catch (error) {
                  mastra?.getLogger()?.warn("Failed to save deal:", { error, deal: deal.title });
                }
              }
              
              return c.json({
                success: true,
                message: "Scraping completed successfully",
                stats: {
                  totalScraped: scrapingResult.totalResults,
                  sitesProcessed: scrapingResult.sitesProcessed,
                  filteredDeals: filteringResult.filteredDeals.length,
                  savedDeals: savedDeals.length,
                  filteringSummary: filteringResult.filteringSummary
                },
                deals: savedDeals.slice(0, 10) // Return first 10 deals
              });
              
            } catch (error) {
              mastra?.getLogger()?.error("Manual scrape failed:", error);
              return c.json({ 
                success: false, 
                error: error instanceof Error ? error.message : "Unknown error" 
              }, 500);
            }
          };
        },
      },
      {
        path: "/",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c) => {
            return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Deal Finder Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/htmx.org@1.9.6"></script>
    <style>
        .deal-card { transition: all 0.3s ease; }
        .deal-card:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .discount-badge { background: linear-gradient(45deg, #ff6b6b, #ff8e8e); }
        .glitch-badge { background: linear-gradient(45deg, #4ecdc4, #44a08d); }
        .loading { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <header class="mb-8">
            <h1 class="text-4xl font-bold text-gray-800 mb-2">🛒 Deal Finder Dashboard</h1>
            <p class="text-gray-600">Real-time deal discovery across top e-commerce sites</p>
        </header>

        <div class="grid md:grid-cols-4 gap-4 mb-8">
            <button 
                class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-6 rounded-lg transition-colors"
                hx-post="/api/scrape" 
                hx-vals='{"query": "electronics", "sites": ["Amazon", "eBay", "Walmart", "Best Buy", "Target"]}'
                hx-headers='{"Content-Type": "application/json"}'
                hx-target="#scrape-results"
                hx-indicator="#loading"
            >
                🔍 Scrape Electronics
            </button>
            <button 
                class="bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-6 rounded-lg transition-colors"
                hx-get="/api/deals/top" 
                hx-target="#deals-container"
                hx-indicator="#loading"
            >
                ⭐ Top Deals
            </button>
            <button 
                class="bg-purple-500 hover:bg-purple-600 text-white font-bold py-3 px-6 rounded-lg transition-colors"
                hx-get="/api/deals/glitches" 
                hx-target="#deals-container"
                hx-indicator="#loading"
            >
                ⚡ Price Glitches
            </button>
            <button 
                class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-6 rounded-lg transition-colors"
                hx-get="/api/deals" 
                hx-target="#deals-container"
                hx-indicator="#loading"
            >
                📋 All Deals
            </button>
        </div>

        <div id="loading" class="loading hidden">
            <div class="bg-blue-100 border border-blue-400 text-blue-700 px-4 py-3 rounded mb-4">
                <div class="flex items-center">
                    <div class="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-700 mr-2"></div>
                    Processing request...
                </div>
            </div>
        </div>

        <div id="scrape-results" class="mb-8"></div>

        <div id="deals-container" class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div class="col-span-full text-center text-gray-500 py-8">
                Click a button above to load deals
            </div>
        </div>
    </div>

    <script>
        // Auto-refresh deals every 5 minutes
        setInterval(() => {
            if (document.querySelector('#deals-container .deal-card')) {
                htmx.trigger('#deals-container', 'refresh');
            }
        }, 300000);

        // Handle HTMX responses
        document.body.addEventListener('htmx:afterRequest', function(evt) {
            if (evt.detail.xhr.status >= 400) {
                document.getElementById('deals-container').innerHTML = 
                    '<div class="col-span-full bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">Error loading deals. Please try again.</div>';
            }
        });
        
        // Template for deals
        function renderDeals(response) {
            if (!response.success || !response.deals || response.deals.length === 0) {
                return '<div class="col-span-full text-center text-gray-500 py-8">No deals found</div>';
            }
            
            return response.deals.map(deal => \`
                <div class="deal-card bg-white rounded-xl shadow-md overflow-hidden">
                    <div class="relative">
                        <img src="\${deal.image || '/api/placeholder/300/200'}" alt="\${deal.title}" class="w-full h-48 object-cover">
                        <div class="absolute top-2 right-2">
                            <span class="\${deal.pricingGlitchProbability > 70 ? 'glitch-badge' : 'discount-badge'} text-white px-3 py-1 rounded-full text-sm font-bold">
                                \${deal.discountPercentage}% OFF
                            </span>
                        </div>
                    </div>
                    <div class="p-4">
                        <h3 class="font-bold text-lg mb-2 line-clamp-2">\${deal.title}</h3>
                        <div class="flex justify-between items-center mb-2">
                            <div>
                                <span class="text-2xl font-bold text-green-600">$\${deal.currentPrice}</span>
                                \${deal.originalPrice ? \`<span class="text-gray-500 line-through ml-2">$\${deal.originalPrice}</span>\` : ''}
                            </div>
                            <span class="bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">\${deal.site}</span>
                        </div>
                        <div class="flex justify-between items-center text-sm text-gray-600 mb-3">
                            <span>Confidence: \${deal.confidenceScore}%</span>
                            \${deal.pricingGlitchProbability > 70 ? \`<span class="text-purple-600">⚡ Glitch: \${deal.pricingGlitchProbability}%</span>\` : ''}
                        </div>
                        <a href="\${deal.url}" target="_blank" class="block w-full bg-blue-500 hover:bg-blue-600 text-white text-center py-2 rounded-lg transition-colors">
                            View Deal
                        </a>
                    </div>
                </div>
            \`).join('');
        }
        
        // Custom HTMX response handler for deals
        document.body.addEventListener('htmx:beforeSwap', function(evt) {
            if (evt.detail.target.id === 'deals-container') {
                try {
                    const response = JSON.parse(evt.detail.xhr.responseText);
                    evt.detail.serverResponse = renderDeals(response);
                } catch (e) {
                    console.error('Failed to parse response:', e);
                }
            }
        });
    </script>
</body>
</html>`);
          };
        },
      },
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

/*  Sanity check 1: Throw an error if there are more than 1 workflows.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

/*  Sanity check 2: Throw an error if there are more than 1 agents.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}
