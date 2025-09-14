# Overview

This project is an AI-powered agent system built with Mastra, designed to automatically discover and filter high-quality deals across multiple e-commerce platforms. The system uses web scraping, AI analysis, and automated filtering to identify legitimate deals and potential pricing glitches, with support for real-time notifications through Slack and Telegram.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Framework
The application is built on the **Mastra framework**, a TypeScript-based system for creating dynamic AI agents. It uses a modular architecture with clear separation between data collection, processing, and notification layers.

## Agent System
- **Dynamic Agents**: Agents that adapt their behavior based on runtime context (user tiers, preferences, etc.)
- **Tool-based Architecture**: Extensible system where agents use specialized tools for different tasks
- **Runtime Configuration**: Agents can modify their instructions, models, and available tools based on context

## Data Collection Layer
- **Web Scraping Tool**: Handles automated scraping of major e-commerce sites (Amazon, eBay, Walmart, Best Buy, Target)
- **Anti-Detection Measures**: Uses Puppeteer with stealth plugins and proxy rotation for reliable scraping
- **Rate Limiting**: Implements per-site rate limiting to avoid being blocked
- **Content Extraction**: Uses Cheerio for HTML parsing and content extraction

## AI Processing Layer
- **Deal Filtering Tool**: Uses AI models (Perplexity/OpenAI) to analyze deal legitimacy
- **Multi-model Support**: Primary AI provider (Perplexity) with OpenAI fallback
- **Confidence Scoring**: Assigns confidence scores and pricing glitch probabilities to deals
- **Intelligent Analysis**: Evaluates deals based on discount percentage, product quality, and market conditions

## Data Storage
- **MongoDB Integration**: Primary storage using MongoDB Atlas with Mongoose ODM
- **Flexible Storage**: Falls back to in-memory storage when MongoDB is unavailable
- **Deal Schema**: Structured data model for storing deal information, AI analysis, and metadata

## Workflow Orchestration
- **Inngest Integration**: Handles background job processing and workflow management
- **Scheduled Tasks**: Automated deal scraping every 4 hours
- **Event-driven Architecture**: Triggers and workflows based on various events

## Notification System
- **Multi-platform Support**: Slack and Telegram integration for real-time notifications
- **Webhook-based**: API endpoints for receiving platform-specific webhooks
- **Configurable Triggers**: Different notification triggers based on deal quality and user preferences

## Development Environment
- **TypeScript**: Full TypeScript implementation with strict type checking
- **ES Modules**: Modern module system for better tree-shaking and performance
- **Hot Reload**: Development server with automatic reloading during development

# External Dependencies

## AI Services
- **Perplexity AI**: Primary AI provider for deal analysis and filtering
- **OpenAI**: Fallback AI provider when Perplexity is unavailable
- **AI SDK**: Unified interface for multiple AI providers

## Database
- **MongoDB Atlas**: Cloud-hosted MongoDB for persistent data storage
- **Mongoose**: Object Document Mapper for MongoDB interactions

## Web Scraping
- **Puppeteer**: Headless Chrome automation for dynamic content scraping
- **Puppeteer Stealth**: Anti-detection plugin to avoid bot detection
- **Cheerio**: Server-side jQuery-like HTML parsing
- **Axios**: HTTP client for API requests and simple web scraping

## Workflow Management
- **Inngest**: Background job processing and workflow orchestration
- **Inngest Realtime**: Real-time workflow monitoring and debugging

## Communication Platforms
- **Slack Web API**: Integration for Slack notifications and bot interactions
- **Telegram Bot API**: Webhook-based integration for Telegram messaging

## Utilities
- **Zod**: Schema validation and type safety
- **User Agents**: Random user agent generation for web scraping
- **Dotenv**: Environment variable management
- **Pino**: High-performance logging system

## Development Tools
- **TSX**: TypeScript execution for development
- **Prettier**: Code formatting
- **Mastra CLI**: Framework-specific development tools