import type { ChatMessage } from "../inference/types.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { getEventBus } from "../events/index.js";

const log = createLogger("memory-refiner");

// ── Types ────────────────────────────────────────────────────────────

export interface RefinementResult {
  consolidated: number;
  conflicts: Array<{ entry1Id: string; entry2Id: string; reason: string }>;
  superseded: Array<{ oldId: string; newId?: string; reason: string }>;
  timestamp: number;
}

interface DailyMemoryEntry {
  id: string;
  category: string;
  content: string;
  createdAt: string;
}

// ── Main Refiner Function ────────────────────────────────────────────

export async function refineMemoriesForSession(
  uid: string,
  sessionId: string,
  messages: ChatMessage[],
): Promise<RefinementResult> {
  const pool = getPool();

  try {
    // Query recent daily memory entries for this uid
    const memResult = await pool.query<DailyMemoryEntry>(
      `SELECT id, category, content, created_at
       FROM daily_memory
       WHERE uid = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [uid],
    );

    const entries = memResult.rows;
    const result: RefinementResult = {
      consolidated: 0,
      conflicts: [],
      superseded: [],
      timestamp: Date.now(),
    };

    if (entries.length === 0) {
      return result;
    }

    // Detect contradictions: entries that directly conflict
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const e1 = entries[i];
        const e2 = entries[j];

        // Simple heuristic: look for opposite keywords or direct negation
        if (detectContradiction(e1.content, e2.content)) {
          result.conflicts.push({
            entry1Id: e1.id,
            entry2Id: e2.id,
            reason: "Direct contradiction detected",
          });
        }
      }
    }

    // Detect superseded entries: older entries that are invalidated by newer information
    const recentUserContent = messages
      .filter((m) => m.role === "user")
      .slice(-5)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join(" ");

    for (const entry of entries) {
      if (isSuperseeded(entry.content, recentUserContent)) {
        result.superseded.push({
          oldId: entry.id,
          reason: "Superseded by recent conversation",
        });
      }
    }

    // Perform consolidation: merge similar entries
    const consolidated = performConsolidation(entries);
    result.consolidated = consolidated.merged;

    // Fire event with before/after comparison
    const bus = getEventBus();
    bus.emit("memory.refined" as any, {
      uid,
      sessionId,
      consolidatedCount: result.consolidated,
      conflictCount: result.conflicts.length,
      supersededCount: result.superseded.length,
      timestamp: result.timestamp,
    });

    log.info(
      `Memory refinement uid=${uid} session=${sessionId} consolidated=${result.consolidated} conflicts=${result.conflicts.length} superseded=${result.superseded.length}`,
    );

    return result;
  } catch (err) {
    log.error(`Memory refinement failed uid=${uid} session=${sessionId} error=${String(err)}`);
    return {
      consolidated: 0,
      conflicts: [],
      superseded: [],
      timestamp: Date.now(),
    };
  }
}

// ── Helper Functions ────────────────────────────────────────────────

function detectContradiction(content1: string, content2: string): boolean {
  // Normalize to lowercase for comparison
  const norm1 = content1.toLowerCase();
  const norm2 = content2.toLowerCase();

  // Check for negation patterns
  const negationPatterns = ["not", "doesn't", "isn't", "won't", "can't", "no longer"];

  // Simple heuristic: if one says X and the other says "not X" or "no longer X"
  // Extract first 30 chars of each normalized content
  const key1 = norm1.slice(0, 30);
  const key2 = norm2.slice(0, 30);

  for (const pattern of negationPatterns) {
    if (key1.includes(pattern) !== key2.includes(pattern)) {
      // Check if similar topics but opposite sentiment
      if (hasSimilarKeywords(norm1, norm2)) {
        return true;
      }
    }
  }

  return false;
}

function isSuperseeded(entryContent: string, recentUserContent: string): boolean {
  const norm1 = entryContent.toLowerCase();
  const norm2 = recentUserContent.toLowerCase();

  // Check if the recent user content explicitly mentions or overrides the entry
  const keywords = norm1.split(/\s+/).filter((w) => w.length > 3).slice(0, 5);

  // If recent content contains all/most keywords from entry, likely superseded
  const matchCount = keywords.filter((k) => norm2.includes(k)).length;
  const threshold = Math.ceil(keywords.length * 0.6);

  return matchCount >= threshold && entryContent.length < 200; // Only short entries can be superseded
}

function hasSimilarKeywords(text1: string, text2: string): boolean {
  // Extract important words (>4 chars)
  const words1 = new Set(text1.split(/\s+/).filter((w) => w.length > 4));
  const words2 = new Set(text2.split(/\s+/).filter((w) => w.length > 4));

  // Calculate Jaccard similarity
  let intersectionCount = 0;
  const unionSet = new Set<string>();

  // Add all words from set1 to union
  words1.forEach((w) => {
    unionSet.add(w);
    if (words2.has(w)) {
      intersectionCount++;
    }
  });

  // Add all words from set2 to union
  words2.forEach((w) => {
    unionSet.add(w);
  });

  if (unionSet.size === 0) return false;
  return intersectionCount / unionSet.size > 0.3; // >30% similarity
}

interface ConsolidationResult {
  merged: number;
}

function performConsolidation(entries: DailyMemoryEntry[]): ConsolidationResult {
  const result = { merged: 0 };

  // Group entries by category
  const byCategory = new Map<string, DailyMemoryEntry[]>();
  for (const entry of entries) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
    }
    const categoryList = byCategory.get(entry.category);
    if (categoryList) {
      categoryList.push(entry);
    }
  }

  // Within each category, check for near-duplicates
  byCategory.forEach((categoryEntries) => {
    for (let i = 0; i < categoryEntries.length; i++) {
      for (let j = i + 1; j < categoryEntries.length; j++) {
        const e1 = categoryEntries[i];
        const e2 = categoryEntries[j];

        // Simple content similarity check
        if (contentSimilarity(e1.content, e2.content) > 0.85) {
          result.merged++;
        }
      }
    }
  });

  return result;
}

function contentSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  let intersectionCount = 0;
  const unionSet = new Set<string>();

  words1.forEach((w) => {
    unionSet.add(w);
    if (words2.has(w)) {
      intersectionCount++;
    }
  });

  words2.forEach((w) => {
    unionSet.add(w);
  });

  if (unionSet.size === 0) return 0;
  return intersectionCount / unionSet.size;
}
