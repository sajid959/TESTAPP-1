import mongoose from "mongoose";
import { z } from "zod";

// MongoDB connection setup
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/mastra-deals";

// Initialize MongoDB connection
let isConnected = false;

export async function connectToMongoDB() {
  if (isConnected) return;

  try {
    await mongoose.connect(MONGODB_URI);
    isConnected = true;
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    throw error;
  }
}

// Deal schema for MongoDB
const dealSchema = new mongoose.Schema({
  hash: { type: String, unique: true, required: true },
  title: { type: String, required: true },
  originalPrice: { type: Number, default: null },
  currentPrice: { type: Number, required: true },
  discountPercentage: { type: Number, required: true },
  url: { type: String, required: true },
  image: { type: String, default: null },
  site: { type: String, required: true },
  availability: { type: String, default: 'Unknown' },
  confidenceScore: { type: Number, default: 0 },
  pricingGlitchProbability: { type: Number, default: 0 },
  filteringReason: { type: String, default: '' },
  validationFlags: [{ type: String }],
  aiAnalysis: { type: String, default: '' },
  suspiciousFactors: [{ type: String }],
  recommendationLevel: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
  sourceMeta: {
    scrapedAt: { type: Date, default: Date.now },
    userAgent: { type: String },
    proxy: { type: String }
  }
}, {
  timestamps: true,
  collection: 'deals'
});

// Create indexes for performance
dealSchema.index({ discountPercentage: -1, createdAt: -1 });
dealSchema.index({ site: 1, createdAt: -1 });
dealSchema.index({ confidenceScore: -1 });
dealSchema.index({ pricingGlitchProbability: -1 });
dealSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); // 7 days TTL

export const Deal = mongoose.model('Deal', dealSchema);

// Simple in-memory storage for Mastra's internal needs
// Production apps should use proper storage
class SimpleMemoryStorage {
  private data = new Map<string, any>();
  private telemetry: any = null;
  private logger: any = null;

  async get(key: string) {
    return this.data.get(key) || null;
  }

  async set(key: string, value: any) {
    this.data.set(key, value);
    return;
  }

  async delete(key: string) {
    this.data.delete(key);
    return;
  }

  async has(key: string) {
    return this.data.has(key);
  }

  // Required Mastra interface methods
  __setTelemetry(telemetry: any) {
    this.telemetry = telemetry;
    return;
  }

  __setLogger(logger: any) {
    this.logger = logger;
    return;
  }

  async init() {
    // Initialize storage - no-op for memory storage
    return Promise.resolve();
  }

  async clear() {
    this.data.clear();
    return;
  }

  async keys() {
    return Array.from(this.data.keys());
  }

  async values() {
    return Array.from(this.data.values());
  }

  async entries() {
    return Array.from(this.data.entries());
  }
}

export const sharedPostgresStorage = new SimpleMemoryStorage();

// Deal storage service
export class DealStorage {
  constructor() {
    connectToMongoDB();
  }

  async saveDeal(dealData: any) {
    const hash = this.generateDealHash(dealData);
    
    try {
      const deal = await Deal.findOneAndUpdate(
        { hash },
        { ...dealData, hash },
        { upsert: true, new: true }
      );
      return deal;
    } catch (error) {
      console.error('Error saving deal:', error);
      throw error;
    }
  }

  async getDeals(filters: any = {}, limit: number = 50, sort: any = { createdAt: -1 }) {
    try {
      const deals = await Deal.find(filters)
        .sort(sort)
        .limit(limit)
        .lean();
      return deals;
    } catch (error) {
      console.error('Error fetching deals:', error);
      throw error;
    }
  }

  async getTopDeals(minDiscount: number = 50, limit: number = 25) {
    try {
      const deals = await Deal.find({
        discountPercentage: { $gte: minDiscount },
        confidenceScore: { $gte: 60 }
      })
      .sort({ discountPercentage: -1, confidenceScore: -1 })
      .limit(limit)
      .lean();
      return deals;
    } catch (error) {
      console.error('Error fetching top deals:', error);
      throw error;
    }
  }

  async getPricingGlitches(minProbability: number = 70, limit: number = 25) {
    try {
      const deals = await Deal.find({
        pricingGlitchProbability: { $gte: minProbability }
      })
      .sort({ pricingGlitchProbability: -1, confidenceScore: -1 })
      .limit(limit)
      .lean();
      return deals;
    } catch (error) {
      console.error('Error fetching pricing glitches:', error);
      throw error;
    }
  }

  private generateDealHash(deal: any): string {
    const key = `${deal.site}-${deal.title?.toLowerCase().trim()}-${deal.currentPrice}`;
    return Buffer.from(key).toString('base64').substring(0, 32);
  }
}

export const dealStorage = new DealStorage();
