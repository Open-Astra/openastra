import type { SkillDefinition } from "../../types.js";

const skillDef: SkillDefinition = {
  name: "Google Analytics 4",
  version: "1.0.0",
  init: async () => {
    // No initialization required—tools are auto-registered
  },
  manifest: {
    id: "ga4",
    name: "Google Analytics 4",
    description: "Query and report on GA4 analytics data—pageviews, events, users, conversions, real-time traffic",
    category: "analyze",
    tools: ["ga4-query", "ga4-realtime"],
    configFields: [],
    version: "1.0.0",
  },
  getPromptContext: () => ({
    skillId: "ga4",
    instructions: `You have access to Google Analytics 4 (GA4) reporting tools for querying analytics data.

## Available Tools
- **ga4-query**: Execute flexible analytics queries with dimensions, metrics, and filters
  - Metrics: activeUsers, screenPageViews, eventCount, conversions, sessions, bounceRate, etc.
  - Dimensions: pagePath, country, deviceCategory, eventName, city, browser, etc.
  - Supports date ranges: "yesterday", "7daysAgo", "2024-01-15", etc.

- **ga4-realtime**: Get real-time active users and traffic (last 30 minutes)

## Setup Required
Workspace admin must set GOOGLE_SERVICE_ACCOUNT_JSON in workspace secrets with a service account that has Analytics API access.

## Example Questions You Can Answer
- "How many visitors hit page X yesterday?"
- "What's our traffic by country this week?"
- "Show me active users right now"
- "Which devices drive the most conversions?"`,
  }),
};

export default skillDef;
