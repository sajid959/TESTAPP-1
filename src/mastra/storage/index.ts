import { PostgreSQLDealStorage } from "./postgresql";

// Import PostgreSQL storage instead of MongoDB
const USE_POSTGRESQL = process.env.DATABASE_URL ? true : false;

export async function connectToDatabase() {
  if (USE_POSTGRESQL) {
    console.log("✅ Using PostgreSQL for persistent storage");
    return true;
  } else {
    console.log("⚠️ DATABASE_URL not configured, using in-memory storage for deals");
    return false;
  }
}

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

  // Additional required methods for Mastra telemetry
  async batchTraceInsert(traces: any[]) {
    // No-op for memory storage
    return Promise.resolve();
  }

  async getTraces(filters: any) {
    // No-op for memory storage
    return Promise.resolve([]);
  }

  async getTrace(id: string) {
    // No-op for memory storage
    return Promise.resolve(null);
  }

  async deleteTrace(id: string) {
    // No-op for memory storage
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

// Use PostgreSQL storage instead of MongoDB
export const dealStorage = new PostgreSQLDealStorage();
