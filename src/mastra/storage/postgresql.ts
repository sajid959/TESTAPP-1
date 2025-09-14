import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

// Configure WebSocket for Neon
neonConfig.webSocketConstructor = ws;
import { pgTable, text, integer, decimal, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { eq, gte, desc, and } from 'drizzle-orm';

// Define the deals table schema
export const dealsTable = pgTable('deals', {
  id: text('id').primaryKey(),
  hash: text('hash').unique().notNull(),
  title: text('title').notNull(),
  originalPrice: decimal('original_price'),
  currentPrice: decimal('current_price').notNull(),
  discountPercentage: integer('discount_percentage').notNull(),
  url: text('url').notNull(),
  image: text('image'),
  site: text('site').notNull(),
  availability: text('availability').default('Unknown'),
  confidenceScore: integer('confidence_score').default(0),
  pricingGlitchProbability: integer('pricing_glitch_probability').default(0),
  filteringReason: text('filtering_reason').default(''),
  validationFlags: jsonb('validation_flags').default([]),
  aiAnalysis: text('ai_analysis').default(''),
  suspiciousFactors: jsonb('suspicious_factors').default([]),
  recommendationLevel: text('recommendation_level').default('MEDIUM'),
  sourceMeta: jsonb('source_meta').default({}),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  discountIdx: index('discount_idx').on(table.discountPercentage, table.createdAt),
  siteIdx: index('site_idx').on(table.site, table.createdAt),
  confidenceIdx: index('confidence_idx').on(table.confidenceScore),
  glitchIdx: index('glitch_idx').on(table.pricingGlitchProbability),
}));

// Database connection
let db: ReturnType<typeof drizzle> | null = null;
let isConnected = false;

export async function connectToPostgreSQL() {
  if (isConnected && db) return db;

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    const pool = new Pool({ 
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    db = drizzle(pool, { schema: { deals: dealsTable } });
    
    // Create table if it doesn't exist using CREATE TABLE IF NOT EXISTS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        hash TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        original_price DECIMAL,
        current_price DECIMAL NOT NULL,
        discount_percentage INTEGER NOT NULL,
        url TEXT NOT NULL,
        image TEXT,
        site TEXT NOT NULL,
        availability TEXT DEFAULT 'Unknown',
        confidence_score INTEGER DEFAULT 0,
        pricing_glitch_probability INTEGER DEFAULT 0,
        filtering_reason TEXT DEFAULT '',
        validation_flags JSONB DEFAULT '[]',
        ai_analysis TEXT DEFAULT '',
        suspicious_factors JSONB DEFAULT '[]',
        recommendation_level TEXT DEFAULT 'MEDIUM',
        source_meta JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS discount_idx ON deals (discount_percentage DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS site_idx ON deals (site, created_at DESC);
      CREATE INDEX IF NOT EXISTS confidence_idx ON deals (confidence_score DESC);
      CREATE INDEX IF NOT EXISTS glitch_idx ON deals (pricing_glitch_probability DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS hash_idx ON deals (hash);
    `);
    
    isConnected = true;
    console.log("✅ Connected to PostgreSQL");
    return db;
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error);
    throw error;
  }
}

// Deal storage service using PostgreSQL
export class PostgreSQLDealStorage {
  private db: ReturnType<typeof drizzle> | null = null;
  private memoryDeals: any[] = []; // Fallback for testing
  
  constructor() {
    this.initializeDB();
  }

  private async initializeDB() {
    try {
      this.db = await connectToPostgreSQL();
    } catch (error) {
      console.warn('⚠️ PostgreSQL connection failed, using memory fallback:', error);
    }
  }

  async saveDeal(dealData: any) {
    const hash = this.generateDealHash(dealData);
    const dealWithDefaults = {
      hash,
      title: dealData.title,
      originalPrice: dealData.originalPrice ? dealData.originalPrice.toString() : null,
      currentPrice: dealData.currentPrice.toString(),
      discountPercentage: Math.round(dealData.discountPercentage || 0),
      url: dealData.url,
      image: dealData.image || null,
      site: dealData.site,
      availability: dealData.availability || 'Unknown',
      confidenceScore: Math.round(dealData.confidenceScore || 0),
      pricingGlitchProbability: Math.round(dealData.pricingGlitchProbability || 0),
      filteringReason: dealData.filteringReason || '',
      validationFlags: dealData.validationFlags || [],
      aiAnalysis: dealData.aiAnalysis || '',
      suspiciousFactors: dealData.suspiciousFactors || [],
      recommendationLevel: dealData.recommendationLevel || 'MEDIUM',
      sourceMeta: dealData.sourceMeta || {},
    };
    
    try {
      if (this.db && isConnected) {
        // Try to update existing deal, or insert new one
        const existing = await this.db.select().from(dealsTable).where(eq(dealsTable.hash, hash)).limit(1);
        
        if (existing.length > 0) {
          const [updated] = await this.db
            .update(dealsTable)
            .set({ ...dealWithDefaults, updatedAt: new Date() })
            .where(eq(dealsTable.hash, hash))
            .returning();
          return this.formatDeal(updated);
        } else {
          const [inserted] = await this.db
            .insert(dealsTable)
            .values(dealWithDefaults)
            .returning();
          return this.formatDeal(inserted);
        }
      } else {
        // Fallback to memory storage
        const existingIndex = this.memoryDeals.findIndex(d => d.hash === hash);
        const dealWithMeta = { 
          ...dealWithDefaults, 
          id: hash, 
          createdAt: new Date(), 
          updatedAt: new Date() 
        };
        
        if (existingIndex >= 0) {
          this.memoryDeals[existingIndex] = dealWithMeta;
        } else {
          this.memoryDeals.push(dealWithMeta);
        }
        
        // Keep only last 1000 deals in memory
        if (this.memoryDeals.length > 1000) {
          this.memoryDeals = this.memoryDeals.slice(-1000);
        }
        
        return this.formatDeal(dealWithMeta);
      }
    } catch (error) {
      console.error('Error saving deal:', error);
      throw error;
    }
  }

  async getDeals(filters: any = {}, limit: number = 50, sort: any = { createdAt: -1 }) {
    try {
      if (this.db && isConnected) {
        let query = this.db.select().from(dealsTable);
        
        // Apply filters
        const conditions = [];
        if (filters.discountPercentage && filters.discountPercentage.$gte) {
          conditions.push(gte(dealsTable.discountPercentage, filters.discountPercentage.$gte));
        }
        if (filters.site) {
          conditions.push(eq(dealsTable.site, filters.site));
        }
        
        if (conditions.length > 0) {
          query = query.where(and(...conditions));
        }
        
        // Apply sort and limit
        const sortKey = Object.keys(sort)[0] || 'createdAt';
        const sortOrder = sort[sortKey] || -1;
        
        if (sortKey === 'createdAt') {
          query = sortOrder === 1 ? query.orderBy(dealsTable.createdAt) : query.orderBy(desc(dealsTable.createdAt));
        } else if (sortKey === 'discountPercentage') {
          query = sortOrder === 1 ? query.orderBy(dealsTable.discountPercentage) : query.orderBy(desc(dealsTable.discountPercentage));
        }
        
        const deals = await query.limit(limit);
        return deals.map(deal => this.formatDeal(deal));
      } else {
        // Fallback to memory storage
        let filteredDeals = [...this.memoryDeals];
        
        // Apply filters
        if (filters.discountPercentage && filters.discountPercentage.$gte) {
          filteredDeals = filteredDeals.filter(d => d.discountPercentage >= filters.discountPercentage.$gte);
        }
        if (filters.site) {
          filteredDeals = filteredDeals.filter(d => d.site === filters.site);
        }
        
        // Apply sort
        const sortKey = Object.keys(sort)[0] || 'createdAt';
        const sortOrder = sort[sortKey] || -1;
        filteredDeals.sort((a, b) => {
          const aVal = a[sortKey];
          const bVal = b[sortKey];
          return sortOrder === 1 ? (aVal > bVal ? 1 : -1) : (aVal < bVal ? 1 : -1);
        });
        
        return filteredDeals.slice(0, limit).map(deal => this.formatDeal(deal));
      }
    } catch (error) {
      console.error('Error fetching deals:', error);
      throw error;
    }
  }

  async getTopDeals(minDiscount: number = 50, limit: number = 25) {
    try {
      if (this.db && isConnected) {
        const deals = await this.db
          .select()
          .from(dealsTable)
          .where(and(
            gte(dealsTable.discountPercentage, minDiscount),
            gte(dealsTable.confidenceScore, 60)
          ))
          .orderBy(desc(dealsTable.discountPercentage), desc(dealsTable.confidenceScore))
          .limit(limit);
        
        return deals.map(deal => this.formatDeal(deal));
      } else {
        // Fallback to memory storage
        return this.memoryDeals
          .filter(d => d.discountPercentage >= minDiscount && (d.confidenceScore || 0) >= 60)
          .sort((a, b) => (b.discountPercentage - a.discountPercentage) || ((b.confidenceScore || 0) - (a.confidenceScore || 0)))
          .slice(0, limit)
          .map(deal => this.formatDeal(deal));
      }
    } catch (error) {
      console.error('Error fetching top deals:', error);
      throw error;
    }
  }

  async getPricingGlitches(minProbability: number = 70, limit: number = 25) {
    try {
      if (this.db && isConnected) {
        const deals = await this.db
          .select()
          .from(dealsTable)
          .where(gte(dealsTable.pricingGlitchProbability, minProbability))
          .orderBy(desc(dealsTable.pricingGlitchProbability), desc(dealsTable.confidenceScore))
          .limit(limit);
        
        return deals.map(deal => this.formatDeal(deal));
      } else {
        // Fallback to memory storage
        return this.memoryDeals
          .filter(d => (d.pricingGlitchProbability || 0) >= minProbability)
          .sort((a, b) => ((b.pricingGlitchProbability || 0) - (a.pricingGlitchProbability || 0)) || ((b.confidenceScore || 0) - (a.confidenceScore || 0)))
          .slice(0, limit)
          .map(deal => this.formatDeal(deal));
      }
    } catch (error) {
      console.error('Error fetching pricing glitches:', error);
      throw error;
    }
  }

  private formatDeal(deal: any) {
    return {
      ...deal,
      originalPrice: deal.originalPrice ? parseFloat(deal.originalPrice) : null,
      currentPrice: parseFloat(deal.currentPrice),
      _id: deal.id,
    };
  }

  private generateDealHash(deal: any): string {
    const key = `${deal.site}-${deal.title?.toLowerCase().trim()}-${deal.currentPrice}`;
    return Buffer.from(key).toString('base64').substring(0, 32);
  }
}