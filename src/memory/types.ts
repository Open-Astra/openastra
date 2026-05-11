// ── Three-Tier Memory System ────────────────────────────────────────
// Maps OpenClaw's Markdown-file memory to Firestore documents.
//
// Tier 1: Ephemeral  → session messages (see sessions/types.ts)
// Tier 2: Daily      → users/{uid}/agent/memory/daily/{YYYY-MM-DD}
// Tier 3: Long-term  → users/{uid}/agent/memory/profile

// ── Daily Memory ────────────────────────────────────────────────────

export interface DailyMemoryDoc {
  date: string; // YYYY-MM-DD
  entries: DailyMemoryEntry[];
  updatedAt: number;
}

export interface DailyMemoryEntry {
  timestamp: number;
  category: "decision" | "outcome" | "strategy" | "note" | "interaction";
  content: string;
  weight?: number;     // 0.0-1.0, starts at 1.0, decays with age; undefined = 1.0
  metadata?: Record<string, unknown>;
}

// ── Long-Term Memory Profile ────────────────────────────────────────
// Domain-agnostic user profile. The `domains` map holds domain-specific
// data (e.g., sports-betting, finance, dev-ops) so the core profile
// stays generic while agents can extend it for their vertical.

export interface MemoryProfile {
  // User identity & preferences
  displayName?: string;
  timezone?: string;
  locale?: string;
  communicationStyle?: "concise" | "detailed" | "casual" | "formal";

  // Curated strategic notes — agent proposes, user can edit
  strategicNotes: string[];

  // User interests and expertise
  interests?: string[];
  expertiseAreas?: string[];

  // Notification preferences
  notificationPreferences?: {
    enabled: boolean;
    channels?: string[];    // "email", "sms", "slack", "push", etc.
    quietHoursStart?: number; // 0-23
    quietHoursEnd?: number;
  };

  // Domain-specific data — agents extend this for their vertical
  domains?: Record<string, Record<string, unknown>>;

  updatedAt: number;
}

// ── Memory Search Result ────────────────────────────────────────────

export interface MemorySearchResult {
  content: string;
  source: "daily" | "profile" | "session";
  date?: string;
  score: number;
}
