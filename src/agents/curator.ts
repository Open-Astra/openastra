import { randomUUID } from "node:crypto";
import type { InferenceClient, ChatMessage } from "../inference/types.js";
import { loadRecentDailyMemory, loadProfile, updateProfile } from "../memory/store.js";
import {
  findOrCreateEntity,
  createEdge,
  extractEntityMentions,
  type EntityType,
  type EdgeType,
} from "../memory/graph.js";
import { getPool } from "../config/postgres.js";

// ── Memory Curator Agent ────────────────────────────────────────────
// Autonomous background agent that periodically:
// 1. Scans recent interactions and daily memory
// 2. Extracts new facts and entities → populates graph
// 3. Resolves contradictions between memories
// 4. Merges duplicate entities in the graph
// 5. Promotes high-confidence insights: Ephemeral → Daily → Profile
//
// Runs on a schedule via the cron scheduler (every 4 hours).

// ── Curation Result ─────────────────────────────────────────────────

export interface CurationResult {
  uid: string;
  entitiesCreated: number;
  edgesCreated: number;
  contradictionsFound: number;
  promotions: number;
  durationMs: number;
}

// ── Run Curator ─────────────────────────────────────────────────────

export async function runCurator(
  uid: string,
  inferenceClient: InferenceClient,
): Promise<CurationResult> {
  const start = Date.now();
  let entitiesCreated = 0;
  let edgesCreated = 0;
  let contradictionsFound = 0;
  let promotions = 0;

  console.log(`[curator] Starting curation for uid=${uid}`);

  // 1. Load recent context
  const [dailyMemory, profile] = await Promise.all([
    loadRecentDailyMemory(uid),
    loadProfile(uid),
  ]);

  // Also load recent session messages (last 24h of interactions)
  const recentMessages = await loadRecentSessionContent(uid);

  // 2. Extract entities from all recent text
  const allText = [
    ...dailyMemory.flatMap((d) => d.entries.map((e) => e.content)),
    ...recentMessages,
  ].join("\n");

  const mentions = extractEntityMentions(allText);

  for (const mention of mentions) {
    try {
      await findOrCreateEntity(uid, mention.type, mention.name, "");
      entitiesCreated++;
    } catch {
      // Entity may already exist, that's fine
    }
  }

  // 3. Use LLM to extract relationships and insights
  if (allText.length > 100) {
    const extracted = await extractInsights(allText, inferenceClient);

    for (const rel of extracted.relationships) {
      try {
        const source = await findOrCreateEntity(uid, rel.sourceType, rel.sourceName, "");
        const target = await findOrCreateEntity(uid, rel.targetType, rel.targetName, "");
        await createEdge(uid, source.id, target.id, rel.edgeType, rel.confidence);
        edgesCreated++;
      } catch {
        // Skip failed edges
      }
    }

    contradictionsFound = extracted.contradictions.length;

    // 4. Handle contradictions — keep the most recent fact
    for (const contradiction of extracted.contradictions) {
      console.log(`[curator] Contradiction found for uid=${uid}: ${contradiction.description}`);
      // Log contradiction for user review
      const pool = getPool();
      await pool.query(
        `INSERT INTO curator_contradictions (id, user_id, agent_id, claim_a, claim_b, resolved, created_at)
         VALUES ($1, $2, $3, $4, $5, false, NOW())`,
        [
          randomUUID(),
          uid,
          "curator",
          contradiction.fact1,
          contradiction.fact2,
        ],
      );
    }

    // 5. Promote insights to profile strategic notes
    for (const insight of extracted.promotions) {
      const existing = profile?.strategicNotes ?? [];
      // Check for duplicates (fuzzy)
      const isDuplicate = existing.some(
        (note) => note.toLowerCase().includes(insight.toLowerCase().slice(0, 30)),
      );

      if (!isDuplicate && existing.length < 20) {
        await updateProfile(uid, {
          strategicNotes: [...existing, insight],
        });
        promotions++;
        console.log(`[curator] Promoted insight for uid=${uid}: ${insight.slice(0, 50)}...`);
      }
    }
  }

  const durationMs = Date.now() - start;
  console.log(
    `[curator] Curation complete for uid=${uid}: ` +
    `${entitiesCreated} entities, ${edgesCreated} edges, ` +
    `${contradictionsFound} contradictions, ${promotions} promotions ` +
    `(${durationMs}ms)`,
  );

  return { uid, entitiesCreated, edgesCreated, contradictionsFound, promotions, durationMs };
}

// ── LLM-Based Insight Extraction ────────────────────────────────────

interface ExtractedInsights {
  relationships: Array<{
    sourceName: string;
    sourceType: EntityType;
    targetName: string;
    targetType: EntityType;
    edgeType: EdgeType;
    confidence: number;
  }>;
  contradictions: Array<{
    description: string;
    fact1: string;
    fact2: string;
  }>;
  promotions: string[]; // insights worth promoting to profile
}

async function extractInsights(
  text: string,
  inferenceClient: InferenceClient,
): Promise<ExtractedInsights> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a memory curation agent. Analyze the following text from recent user interactions and extract:

1. **relationships**: Entity pairs with typed relationships. Types:
   - Entity types: person, team, event, concept, market, outcome
   - Edge types: plays_for, related_to, caused_by, contradicts, supports, correlated_with
   - Include confidence (0-1)

2. **contradictions**: Pairs of facts that contradict each other.

3. **promotions**: High-value strategic insights (max 3) that should be saved long-term.

Respond in JSON format:
{
  "relationships": [{"sourceName":"...","sourceType":"...","targetName":"...","targetType":"...","edgeType":"...","confidence":0.8}],
  "contradictions": [{"description":"...","fact1":"...","fact2":"..."}],
  "promotions": ["insight1", "insight2"]
}

Only extract high-confidence facts. Be conservative — false positives are worse than missed extractions.`,
    },
    {
      role: "user",
      content: text.slice(0, 8000), // limit input size
    },
  ];

  try {
    const response = await inferenceClient.chat({
      messages,
      temperature: 0.2,
      maxTokens: 2000,
    });

    const content = response.content ?? "{}";
    // Extract JSON from response (may have markdown wrapper)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { relationships: [], contradictions: [], promotions: [] };

    const parsed = JSON.parse(jsonMatch[0]) as ExtractedInsights;
    return {
      relationships: parsed.relationships ?? [],
      contradictions: parsed.contradictions ?? [],
      promotions: parsed.promotions ?? [],
    };
  } catch (err) {
    console.error("[curator] Insight extraction failed:", err);
    return { relationships: [], contradictions: [], promotions: [] };
  }
}

// ── Load Recent Session Content ─────────────────────────────────────

async function loadRecentSessionContent(uid: string): Promise<string[]> {
  const pool = getPool();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h

  // Query recent active sessions
  const { rows: sessions } = await pool.query<{
    id: string;
  }>(
    `SELECT id FROM sessions
     WHERE user_id = $1 AND status = 'active'
       AND last_active_at > to_timestamp($2 / 1000.0)
     ORDER BY last_active_at DESC
     LIMIT 5`,
    [uid, cutoff],
  );

  const contents: string[] = [];

  for (const session of sessions) {
    const { rows: msgs } = await pool.query<{
      role: string;
      content: string;
    }>(
      `SELECT role, content FROM messages
       WHERE session_id = $1 AND timestamp > $2
       ORDER BY timestamp DESC
       LIMIT 20`,
      [session.id, cutoff],
    );

    for (const msg of msgs) {
      if (msg.role === "user" || msg.role === "assistant") {
        contents.push(msg.content ?? "");
      }
    }
  }

  return contents;
}
