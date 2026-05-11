import { appendDailyMemory, getDailyEntryCount } from "../memory/store.js";
import { indexDailyEntry } from "../memory/indexer.js";
import { extractEntityMentions, findOrCreateEntity } from "../memory/graph.js";
import { scanContent, detectPII, redactPII } from "../secrets/scanner.js";
import { loadEnv } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { extractFacts } from "../memory/fact-extractor.js";
import { scoreImportance } from "../memory/importance.js";
import { detectConflicts } from "../memory/conflict-detector.js";

const log = createLogger("post-turn-save");

// ── Post-Turn Auto-Save ─────────────────────────────────────────────
// Automatically extracts key facts from the user message and assistant
// response after each turn. Runs fire-and-forget to avoid adding
// latency to the response.
//
// What gets saved:
//   - Decisions (user chose something)
//   - Outcomes (results mentioned)
//   - Entity mentions (people, teams → knowledge graph)
//
// This is a lightweight complement to the auto_save skill. The skill
// requires the agent to explicitly call it; this runs automatically.

const DECISION_SIGNALS = [
  "decided", "going with", "betting on", "picking", "choosing",
  "will take", "locking in", "let's go", "i'll take", "i want",
  "my pick", "going all in",
];

const OUTCOME_SIGNALS = [
  "won", "lost", "hit", "missed", "cashed", "busted",
  "covered", "pushed", "result was", "final score",
];

const MIN_SENTENCE_LENGTH = 20;
const MAX_SAVES_PER_TURN = 3;

/**
 * Write a PII detection event to the audit_log table (fire-and-forget).
 */
async function logPiiAudit(uid: string, types: string[], action: string): Promise<void> {
  try {
    const { getPool } = await import("../config/postgres.js");
    const pool = getPool();
    await pool.query(
      `INSERT INTO audit_log (event, uid, user_id, agent_id, action, details, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [
        "pii.detected",
        uid,
        uid,
        "system",
        action,
        JSON.stringify({ types, action }),
        JSON.stringify({ types, action }),
        Date.now(),
      ],
    );
  } catch {
    // Fire-and-forget — audit failures must not block memory writes
  }
}

function applyPiiPolicy(
  content: string,
  policy: "block" | "redact" | "allow",
  uid?: string,
): { allowed: true; content: string } | { allowed: false } {
  // "allow" = off — skip PII processing entirely
  if (policy === "allow") return { allowed: true, content };
  if (policy === "redact") {
    const { redacted, found } = redactPII(content);
    if (found.length > 0) {
      const types = [...new Set(found.map((f) => f.type))].join(", ");
      log.warn(`PII redacted before memory write [types: ${types}]`);
      if (uid) {
        logPiiAudit(uid, [...new Set(found.map((f) => f.type))], "redacted").catch(() => {});
      }
    }
    return { allowed: true, content: redacted };
  }
  // policy === "block" — detect PII, log to audit, block write
  const found = detectPII(content);
  if (found.length > 0) {
    const types = [...new Set(found.map((f) => f.type))].join(", ");
    log.warn(`PII detected — blocking memory write [types: ${types}]`);
    if (uid) {
      logPiiAudit(uid, [...new Set(found.map((f) => f.type))], "blocked").catch(() => {});
    }
    return { allowed: false };
  }
  return { allowed: true, content };
}

export async function postTurnAutoSave(
  uid: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const policy = loadEnv().piiDetectionPolicy;
  const today = new Date().toISOString().slice(0, 10);
  let saveCount = 0;

  // Extract facts from the user message (not the assistant response,
  // to avoid saving the agent's own generated text)
  const sentences = userMessage
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LENGTH);

  for (const sentence of sentences) {
    if (saveCount >= MAX_SAVES_PER_TURN) break;
    const lower = sentence.toLowerCase();

    let category: "decision" | "outcome" | null = null;

    if (DECISION_SIGNALS.some((s) => lower.includes(s))) {
      category = "decision";
    } else if (OUTCOME_SIGNALS.some((s) => lower.includes(s))) {
      category = "outcome";
    }

    if (category) {
      // Score importance — skip low-value saves
      const importance = scoreImportance(sentence, { isUserMessage: true });
      if (importance.overall < 0.3) continue;

      const { hasPotentialSecrets, sanitized } = scanContent(sentence);
      const secretSafe = hasPotentialSecrets ? sanitized : sentence;
      const piiResult = applyPiiPolicy(secretSafe, policy, uid);
      if (!piiResult.allowed) continue;
      const safeContent = piiResult.content;
      const entry = { timestamp: Date.now(), category, content: safeContent };
      const count = await getDailyEntryCount(uid, today);
      await appendDailyMemory(uid, entry);
      indexDailyEntry(uid, today, count, category, safeContent, Date.now()).catch(() => {});
      saveCount++;

      // Fire-and-forget conflict detection against existing memories
      detectConflicts(safeContent, uid, "").catch(() => {});
    }
  }

  // Extract entity mentions from the full exchange and reinforce in graph
  const fullText = `${userMessage} ${assistantResponse}`;
  const mentions = extractEntityMentions(fullText);

  // Limit to 5 entities per turn to avoid spam
  const uniqueMentions = mentions.slice(0, 5);

  for (const mention of uniqueMentions) {
    findOrCreateEntity(uid, mention.type, mention.name, "").catch(() => {});
  }

  // Extract structured facts from the assistant response (fire-and-forget)
  // High-confidence facts (>0.7) are stored as "note" category entries with
  // fact type recorded in metadata.
  void (async () => {
    try {
      const facts = extractFacts(assistantResponse);
      const highConfidenceFacts = facts.filter((f) => f.confidence > 0.7);

      for (const fact of highConfidenceFacts.slice(0, 3)) {
        const { hasPotentialSecrets, sanitized } = scanContent(fact.value);
        const safeValue = hasPotentialSecrets ? sanitized : fact.value;
        const piiResult = applyPiiPolicy(safeValue, policy, uid);
        if (!piiResult.allowed) continue;

        const factEntry = {
          timestamp: Date.now(),
          category: "note" as const,
          content: `[fact:${fact.type}] ${piiResult.content}`,
          confidence: fact.confidence,
          metadata: { factType: fact.type, raw: fact.raw, confidence: fact.confidence },
        };
        appendDailyMemory(uid, factEntry).catch(() => {});
      }
    } catch {
      // Fact extraction is best-effort — never block the main flow
    }
  })();
}
