import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { z } from "zod";
import axios from "axios";

// AI client setup - Perplexity first, OpenAI fallback
const perplexity = createOpenAI({
  baseURL: "https://api.perplexity.ai",
  apiKey: process.env.PERPLEXITY_API_KEY,
});

const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  apiKey: process.env.OPENAI_API_KEY,
});

// Deal schema - matching the webScrapingTool schema
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

// Enhanced deal schema with filtering metadata
const FilteredDealSchema = DealSchema.extend({
  confidenceScore: z.number().min(0).max(100).describe("Confidence score (0-100) for deal validity"),
  pricingGlitchProbability: z.number().min(0).max(100).describe("Probability this is a pricing glitch (0-100%)"),
  filteringReason: z.string().describe("Reason why this deal was selected"),
  validationFlags: z.array(z.string()).describe("List of validation flags/warnings"),
  aiAnalysis: z.string().describe("AI analysis of the deal legitimacy"),
  suspiciousFactors: z.array(z.string()).describe("Factors that make this deal suspicious or noteworthy"),
  recommendationLevel: z.enum(["HIGH", "MEDIUM", "LOW"]).describe("Recommendation level for this deal"),
});

type Deal = z.infer<typeof DealSchema>;
type FilteredDeal = z.infer<typeof FilteredDealSchema>;

// AI analysis prompt template
const AI_ANALYSIS_PROMPT = `You are an expert deal analyst tasked with identifying legitimate high-discount deals and potential pricing glitches. Analyze this product deal:

**Product:** {title}
**Site:** {site}
**Original Price:** {originalPrice}
**Current Price:** {currentPrice}
**Discount:** {discountPercentage}%
**Availability:** {availability}

Analyze this deal considering:
1. **Price Validity**: Is this discount mathematically correct?
2. **Market Reality**: Is this price realistic for this type of product?
3. **Pricing Glitch Detection**: Could this be a pricing error/system glitch?
4. **Title Analysis**: Does the product title seem legitimate?
5. **Discount Reasonableness**: Is this discount too good to be true?

Respond with a JSON object:
{
  "isLegitimate": boolean,
  "confidenceScore": number (0-100),
  "pricingGlitchProbability": number (0-100),
  "analysis": "detailed analysis",
  "suspiciousFactors": ["list", "of", "red", "flags"],
  "recommendation": "HIGH|MEDIUM|LOW"
}`;

interface PricingAnalysisResult {
  isLegitimate: boolean;
  confidenceScore: number;
  pricingGlitchProbability: number;
  analysis: string;
  suspiciousFactors: string[];
  recommendation: "HIGH" | "MEDIUM" | "LOW";
}

class DealFilteringService {
  private logger?: IMastraLogger;
  private seenDeals: Set<string> = new Set(); // For deduplication

  constructor(logger?: IMastraLogger) {
    this.logger = logger;
  }

  private generateDealHash(deal: Deal): string {
    // Create a hash based on title, site, and current price for deduplication
    const key = `${deal.site}-${deal.title.toLowerCase().trim()}-${deal.currentPrice}`;
    return Buffer.from(key).toString('base64').substring(0, 32);
  }

  private validateDiscountMath(deal: Deal): { valid: boolean; actualDiscount: number; flags: string[] } {
    const flags: string[] = [];
    let actualDiscount = 0;

    this.logger?.info('🔍 [DealFilteringService] Validating discount math:', {
      title: deal.title,
      originalPrice: deal.originalPrice,
      currentPrice: deal.currentPrice,
      reportedDiscount: deal.discountPercentage
    });

    if (!deal.originalPrice || deal.originalPrice <= 0) {
      flags.push("No valid original price provided");
      return { valid: false, actualDiscount: 0, flags };
    }

    if (deal.currentPrice <= 0) {
      flags.push("Invalid current price");
      return { valid: false, actualDiscount: 0, flags };
    }

    if (deal.currentPrice >= deal.originalPrice) {
      flags.push("Current price is not lower than original price");
      return { valid: false, actualDiscount: 0, flags };
    }

    // Calculate actual discount
    actualDiscount = ((deal.originalPrice - deal.currentPrice) / deal.originalPrice) * 100;
    const discountDifference = Math.abs(actualDiscount - deal.discountPercentage);

    this.logger?.info('📊 [DealFilteringService] Discount calculation:', {
      actualDiscount: actualDiscount.toFixed(2),
      reportedDiscount: deal.discountPercentage,
      difference: discountDifference.toFixed(2)
    });

    if (discountDifference > 5) { // Allow 5% tolerance
      flags.push(`Discount mismatch: calculated ${actualDiscount.toFixed(1)}% vs reported ${deal.discountPercentage}%`);
    }

    if (actualDiscount > 95) {
      flags.push("Extremely high discount (>95%) - likely pricing glitch");
    }

    if (actualDiscount < 50 && deal.discountPercentage >= 90) {
      flags.push("Reported discount much higher than calculated - suspicious");
      return { valid: false, actualDiscount, flags };
    }

    return {
      valid: actualDiscount >= 50, // Require at least 50% real discount
      actualDiscount,
      flags
    };
  }

  private detectSuspiciousPricing(deal: Deal): string[] {
    const suspiciousFactors: string[] = [];

    this.logger?.info('🚩 [DealFilteringService] Detecting suspicious pricing patterns:', {
      title: deal.title,
      currentPrice: deal.currentPrice
    });

    // Check for common pricing glitch patterns
    if (deal.currentPrice < 1) {
      suspiciousFactors.push("Price under $1 - likely pricing error");
    }

    if (deal.currentPrice === 0.01) {
      suspiciousFactors.push("Penny pricing - classic pricing glitch");
    }

    // Check for round number patterns that might indicate errors
    const roundNumbers = [0.1, 0.5, 1.0, 5.0, 10.0, 20.0, 50.0];
    if (roundNumbers.includes(deal.currentPrice) && deal.originalPrice && deal.originalPrice > 100) {
      suspiciousFactors.push("Suspiciously round pricing for expensive item");
    }

    // Check title for obvious quality indicators
    const title = deal.title.toLowerCase();
    const qualityBrands = ['apple', 'samsung', 'sony', 'nike', 'adidas', 'louis vuitton', 'gucci', 'prada'];
    const hasQualityBrand = qualityBrands.some(brand => title.includes(brand));
    
    if (hasQualityBrand && deal.currentPrice < 20) {
      suspiciousFactors.push("High-end brand at very low price - potential glitch");
    }

    // Check for title quality issues
    if (title.length < 10) {
      suspiciousFactors.push("Very short product title - possibly incomplete");
    }

    if (/\d{10,}/.test(title)) {
      suspiciousFactors.push("Title contains long number sequences - possibly corrupted");
    }

    // Check availability for glitch indicators
    if (deal.availability.toLowerCase().includes('limited') && deal.discountPercentage > 90) {
      suspiciousFactors.push("Limited availability with extreme discount - possible error");
    }

    return suspiciousFactors;
  }

  private async analyzeWithAI(deal: Deal): Promise<PricingAnalysisResult> {
    this.logger?.info('🤖 [DealFilteringService] Starting AI analysis:', {
      title: deal.title,
      site: deal.site,
      discount: deal.discountPercentage
    });

    const prompt = AI_ANALYSIS_PROMPT
      .replace('{title}', deal.title)
      .replace('{site}', deal.site)
      .replace('{originalPrice}', deal.originalPrice?.toString() || 'N/A')
      .replace('{currentPrice}', deal.currentPrice.toString())
      .replace('{discountPercentage}', deal.discountPercentage.toString())
      .replace('{availability}', deal.availability);

    // Try Perplexity first
    try {
      this.logger?.info('🔍 [DealFilteringService] Trying Perplexity API first...');
      
      const { text } = await generateText({
        model: perplexity("llama-3.1-sonar-small-128k-online"),
        messages: [
          {
            role: "user",
            content: prompt + "\n\nRespond with valid JSON only, no additional text.",
          },
        ],
        temperature: 0.2,
      });

      return await this.parseAIResponse(text, 'Perplexity');

    } catch (perplexityError) {
      this.logger?.warn('⚠️ [DealFilteringService] Perplexity failed, trying OpenAI fallback:', {
        error: perplexityError instanceof Error ? perplexityError.message : perplexityError
      });

      try {
        const { text } = await generateText({
          model: openai("gpt-5"), // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
          messages: [
            {
              role: "user",
              content: prompt + "\n\nRespond with valid JSON only, no additional text.",
            },
          ],
          temperature: 0.3,
        });

        return await this.parseAIResponse(text, 'OpenAI');

      } catch (openaiError) {
        this.logger?.error('❌ [DealFilteringService] Both AI services failed:', {
          perplexityError: perplexityError instanceof Error ? perplexityError.message : perplexityError,
          openaiError: openaiError instanceof Error ? openaiError.message : openaiError
        });
        throw openaiError;
      }
    }
  }

  private async parseAIResponse(text: string, provider: string): Promise<PricingAnalysisResult> {
    this.logger?.info(`✅ [DealFilteringService] Got response from ${provider}`);

    try {

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : text;
      const parsedResponse = JSON.parse(jsonStr);

      // Validate and sanitize the parsed response
      const response = {
        isLegitimate: Boolean(parsedResponse.isLegitimate),
        confidenceScore: Math.max(0, Math.min(100, Number(parsedResponse.confidenceScore) || 50)),
        pricingGlitchProbability: Math.max(0, Math.min(100, Number(parsedResponse.pricingGlitchProbability) || 0)),
        analysis: String(parsedResponse.analysis || 'No analysis provided'),
        suspiciousFactors: Array.isArray(parsedResponse.suspiciousFactors) ? parsedResponse.suspiciousFactors : [],
        recommendation: ["HIGH", "MEDIUM", "LOW"].includes(parsedResponse.recommendation) ? parsedResponse.recommendation : "MEDIUM"
      };

      this.logger?.info(`✅ [DealFilteringService] ${provider} analysis completed:`, {
        isLegitimate: response.isLegitimate,
        confidenceScore: response.confidenceScore,
        pricingGlitchProbability: response.pricingGlitchProbability,
        recommendation: response.recommendation
      });

      return response;

    } catch (parseError) {
      this.logger?.warn(`⚠️ [DealFilteringService] Failed to parse ${provider} response:`, {
        error: parseError instanceof Error ? parseError.message : parseError,
        response: text.substring(0, 200)
      });
      throw new Error(`Failed to parse ${provider} analysis response`);
    }
  }

  private calculateOverallScore(
    mathValidation: { valid: boolean; actualDiscount: number; flags: string[] },
    aiAnalysis: PricingAnalysisResult,
    suspiciousFactors: string[]
  ): number {
    let score = 50; // Base score

    // Discount quality (0-30 points)
    if (mathValidation.valid) {
      const discountScore = Math.min(30, mathValidation.actualDiscount * 0.3);
      score += discountScore;
      this.logger?.info('📈 [DealFilteringService] Added discount score:', { discountScore });
    } else {
      score -= 20;
      this.logger?.info('📉 [DealFilteringService] Reduced score for invalid discount math');
    }

    // AI confidence (0-40 points)
    const aiScore = (aiAnalysis.confidenceScore / 100) * 40;
    score += aiScore;
    this.logger?.info('🧠 [DealFilteringService] Added AI confidence score:', { aiScore });

    // Penalty for suspicious factors (-5 points each)
    const suspicionPenalty = Math.min(30, suspiciousFactors.length * 5);
    score -= suspicionPenalty;
    this.logger?.info('⚠️ [DealFilteringService] Applied suspicion penalty:', { suspicionPenalty });

    // Bonus for pricing glitch potential (+20 points if >70% chance)
    if (aiAnalysis.pricingGlitchProbability > 70) {
      score += 20;
      this.logger?.info('🎯 [DealFilteringService] Added pricing glitch bonus');
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  async filterDeals(
    deals: Deal[],
    minDiscountPercentage: number = 90,
    minConfidenceScore: number = 60,
    maxResults: number = 50
  ): Promise<FilteredDeal[]> {
    this.logger?.info('🔧 [DealFilteringService] Starting deal filtering process:', {
      inputDeals: deals.length,
      minDiscountPercentage,
      minConfidenceScore,
      maxResults
    });

    const filteredDeals: FilteredDeal[] = [];
    let processed = 0;
    let duplicatesSkipped = 0;
    let mathInvalid = 0;
    let lowConfidence = 0;

    for (const deal of deals) {
      try {
        processed++;
        this.logger?.info('🔍 [DealFilteringService] Processing deal:', {
          progress: `${processed}/${deals.length}`,
          title: deal.title,
          site: deal.site
        });

        // Check for duplicates
        const dealHash = this.generateDealHash(deal);
        if (this.seenDeals.has(dealHash)) {
          duplicatesSkipped++;
          this.logger?.info('⏭️ [DealFilteringService] Skipping duplicate deal:', { title: deal.title });
          continue;
        }
        this.seenDeals.add(dealHash);

        // Validate discount math
        const mathValidation = this.validateDiscountMath(deal);
        if (!mathValidation.valid && mathValidation.actualDiscount < 50) {
          mathInvalid++;
          this.logger?.info('❌ [DealFilteringService] Deal failed math validation:', {
            title: deal.title,
            flags: mathValidation.flags
          });
          continue;
        }

        // AI analysis
        const aiAnalysis = await this.analyzeWithAI(deal);

        // Detect additional suspicious factors
        const suspiciousFactors = this.detectSuspiciousPricing(deal);

        // Calculate overall confidence score
        const confidenceScore = this.calculateOverallScore(
          mathValidation,
          aiAnalysis,
          suspiciousFactors
        );

        // Determine if this qualifies as a high-discount deal or pricing glitch
        const qualifiesAsHighDiscount = mathValidation.actualDiscount >= minDiscountPercentage;
        const qualifiesAsPricingGlitch = aiAnalysis.pricingGlitchProbability >= 70;
        const meetsConfidenceThreshold = confidenceScore >= minConfidenceScore;

        // Must qualify as either high discount OR pricing glitch, and meet confidence threshold
        if ((qualifiesAsHighDiscount || qualifiesAsPricingGlitch) && meetsConfidenceThreshold) {
          const filteringReason = qualifiesAsPricingGlitch 
            ? `Potential pricing glitch (${aiAnalysis.pricingGlitchProbability}% probability)`
            : `High discount deal (${mathValidation.actualDiscount.toFixed(1)}% off)`;

          const filteredDeal: FilteredDeal = {
            ...deal,
            confidenceScore,
            pricingGlitchProbability: aiAnalysis.pricingGlitchProbability,
            filteringReason,
            validationFlags: mathValidation.flags,
            aiAnalysis: aiAnalysis.analysis,
            suspiciousFactors: [...suspiciousFactors, ...aiAnalysis.suspiciousFactors],
            recommendationLevel: aiAnalysis.recommendation,
          };

          filteredDeals.push(filteredDeal);

          this.logger?.info('✅ [DealFilteringService] Deal passed filtering:', {
            title: deal.title,
            confidenceScore,
            pricingGlitchProbability: aiAnalysis.pricingGlitchProbability,
            actualDiscount: mathValidation.actualDiscount,
            recommendation: aiAnalysis.recommendation
          });
        } else {
          lowConfidence++;
          this.logger?.info('⚠️ [DealFilteringService] Deal filtered out:', {
            title: deal.title,
            confidenceScore,
            qualifiesAsHighDiscount,
            qualifiesAsPricingGlitch,
            reason: !meetsConfidenceThreshold ? 'Low confidence' : 'Does not meet criteria'
          });
        }

        // Respect rate limits
        if (processed % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (error) {
        this.logger?.error('❌ [DealFilteringService] Error processing deal:', {
          title: deal.title,
          error: error instanceof Error ? error.message : error
        });
      }
    }

    // Sort by confidence score and pricing glitch probability
    filteredDeals.sort((a, b) => {
      const scoreA = a.confidenceScore + (a.pricingGlitchProbability * 0.5);
      const scoreB = b.confidenceScore + (b.pricingGlitchProbability * 0.5);
      return scoreB - scoreA;
    });

    const finalResults = filteredDeals.slice(0, maxResults);

    this.logger?.info('🎯 [DealFilteringService] Filtering completed:', {
      inputDeals: deals.length,
      processed,
      duplicatesSkipped,
      mathInvalid,
      lowConfidence,
      finalResults: finalResults.length,
      topConfidenceScore: finalResults[0]?.confidenceScore,
      topPricingGlitchProb: finalResults[0]?.pricingGlitchProbability
    });

    return finalResults;
  }
}

export const dealFilteringTool = createTool({
  id: "ai-deal-filtering-analyzer",
  description: `Advanced AI-powered tool that analyzes and filters deals to identify genuine 90%+ discounts and potential pricing glitches. Uses OpenAI to evaluate deal legitimacy, validate pricing math, detect suspicious patterns, and provide confidence scores. Filters for high-value deals and pricing errors while avoiding scams and false advertising.`,
  inputSchema: z.object({
    deals: z.array(DealSchema).describe("Array of deals to analyze and filter"),
    minDiscountPercentage: z.number().min(50).max(99).default(90).describe("Minimum discount percentage to qualify (50-99%)"),
    minConfidenceScore: z.number().min(0).max(100).default(60).describe("Minimum confidence score required (0-100)"),
    maxResults: z.number().min(1).max(100).default(25).describe("Maximum number of filtered deals to return"),
  }),
  outputSchema: z.object({
    filteredDeals: z.array(FilteredDealSchema),
    filteringSummary: z.object({
      inputDeals: z.number(),
      processedDeals: z.number(),
      duplicatesRemoved: z.number(),
      mathValidationFailures: z.number(),
      lowConfidenceFiltered: z.number(),
      finalResults: z.number(),
      averageConfidenceScore: z.number(),
      averagePricingGlitchProbability: z.number(),
      topRecommendations: z.number(),
      pricingGlitchesFound: z.number(),
    }),
  }),
  execute: async ({ context: { deals, minDiscountPercentage, minConfidenceScore, maxResults }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔧 [DealFilteringTool] Starting execution with params:', {
      inputDeals: deals.length,
      minDiscountPercentage,
      minConfidenceScore,
      maxResults
    });

    if (!process.env.PERPLEXITY_API_KEY && !process.env.OPENAI_API_KEY) {
      const error = 'Neither Perplexity nor OpenAI API keys configured - at least one is required for deal analysis';
      logger?.error('❌ [DealFilteringTool] Configuration error:', { error });
      throw new Error(error);
    }

    if (!process.env.PERPLEXITY_API_KEY) {
      logger?.warn('⚠️ [DealFilteringTool] Perplexity API key not configured - will use OpenAI only');
    }
    
    if (!process.env.OPENAI_API_KEY) {
      logger?.warn('⚠️ [DealFilteringTool] OpenAI API key not configured - will use Perplexity only');
    }

    const filteringService = new DealFilteringService(logger);

    try {
      const filteredDeals = await filteringService.filterDeals(
        deals,
        minDiscountPercentage,
        minConfidenceScore,
        maxResults
      );

      // Calculate summary statistics
      const averageConfidenceScore = filteredDeals.length > 0
        ? Math.round(filteredDeals.reduce((sum, deal) => sum + deal.confidenceScore, 0) / filteredDeals.length)
        : 0;

      const averagePricingGlitchProbability = filteredDeals.length > 0
        ? Math.round(filteredDeals.reduce((sum, deal) => sum + deal.pricingGlitchProbability, 0) / filteredDeals.length)
        : 0;

      const topRecommendations = filteredDeals.filter(deal => deal.recommendationLevel === "HIGH").length;
      const pricingGlitchesFound = filteredDeals.filter(deal => deal.pricingGlitchProbability >= 70).length;

      const filteringSummary = {
        inputDeals: deals.length,
        processedDeals: deals.length,
        duplicatesRemoved: 0, // This would need to be tracked in the service
        mathValidationFailures: 0, // This would need to be tracked in the service
        lowConfidenceFiltered: 0, // This would need to be tracked in the service
        finalResults: filteredDeals.length,
        averageConfidenceScore,
        averagePricingGlitchProbability,
        topRecommendations,
        pricingGlitchesFound,
      };

      logger?.info('✅ [DealFilteringTool] Execution completed successfully:', {
        finalResults: filteredDeals.length,
        averageConfidenceScore,
        topRecommendations,
        pricingGlitchesFound,
        topDeal: filteredDeals[0]?.title
      });

      return {
        filteredDeals,
        filteringSummary
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error('❌ [DealFilteringTool] Execution failed:', { error: errorMessage });
      throw new Error(`Deal filtering failed: ${errorMessage}`);
    }
  },
});