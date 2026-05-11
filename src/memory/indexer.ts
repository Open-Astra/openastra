import { createHash } from "node:crypto";
import { getTypesense } from "../config/typesense.js";
import { generateEmbedding, generateEmbeddings } from "./embeddings.js";
import type { DailyMemoryDoc, MemoryProfile } from "./types.js";

const COLLECTION = "memory_chunks";

// ── Deduplication ────────────────────────────────────────────────────
// Tracks recently indexed content hashes to prevent duplicate entries
// when the same fact is extracted multiple times in a session.

const recentHashes = new Map<string, number>(); // hash → timestamp
const DEDUP_TTL_MS = 10 * 60_000; // 10 minutes
const DEDUP_MAX_SIZE = 1000;

function contentHash(uid: string, content: string): string {
  return createHash("sha256").update(`${uid}:${content.toLowerCase().trim()}`).digest("hex").slice(0, 16);
}

function isDuplicate(uid: string, content: string): boolean {
  const hash = contentHash(uid, content);
  const existing = recentHashes.get(hash);
  if (existing && Date.now() - existing < DEDUP_TTL_MS) {
    return true;
  }

  // Cleanup if too large
  if (recentHashes.size > DEDUP_MAX_SIZE) {
    const now = Date.now();
    for (const [k, ts] of recentHashes) {
      if (now - ts > DEDUP_TTL_MS) recentHashes.delete(k);
    }
  }

  recentHashes.set(hash, Date.now());
  return false;
}

// ── Document ID Scheme ──────────────────────────────────────────────
// Deterministic IDs so re-indexing is idempotent (upsert, not duplicate).

function dailyChunkId(uid: string, date: string, index: number): string {
  return `${uid}:daily:${date}:${index}`;
}

function profileChunkId(uid: string, index: number): string {
  return `${uid}:profile:${index}`;
}

// ── Index Daily Memory ──────────────────────────────────────────────
// Splits each daily entry into a separate Typesense document.
// Called after memory_write appends a new entry.

export async function indexDailyMemory(
  uid: string,
  doc: DailyMemoryDoc,
): Promise<void> {
  const ts = getTypesense();

  const texts = doc.entries.map(
    (e) => `[${doc.date}] [${e.category}] ${e.content}`,
  );

  if (texts.length === 0) return;

  const embeddings = await generateEmbeddings(texts);

  const documents = doc.entries.map((entry, i) => ({
    id: dailyChunkId(uid, doc.date, i),
    uid,
    content: texts[i],
    source: "daily",
    category: entry.category,
    date: doc.date,
    timestamp: entry.timestamp,
    embedding: embeddings[i],
  }));

  await ts
    .collections(COLLECTION)
    .documents()
    .import(documents, { action: "upsert" });
}

// ── Index Single Daily Entry ────────────────────────────────────────
// More efficient for real-time indexing — indexes just the new entry
// instead of reprocessing the entire day.

export async function indexDailyEntry(
  uid: string,
  date: string,
  entryIndex: number,
  category: string,
  content: string,
  timestamp: number,
): Promise<void> {
  // Skip if this content was recently indexed (prevents duplicate entries
  // from auto-save, manual memory_write, and fact extraction all firing)
  if (isDuplicate(uid, content)) return;

  const ts = getTypesense();
  const text = `[${date}] [${category}] ${content}`;
  const embedding = await generateEmbedding(text);

  await ts
    .collections(COLLECTION)
    .documents()
    .upsert({
      id: dailyChunkId(uid, date, entryIndex),
      uid,
      content: text,
      source: "daily",
      category,
      date,
      timestamp,
      embedding,
    });
}

// ── Index Profile ───────────────────────────────────────────────────
// Breaks the profile into chunks: one per strategic note + one for
// the overview + one per domain section.

export async function indexProfile(
  uid: string,
  profile: MemoryProfile,
): Promise<void> {
  const ts = getTypesense();
  const chunks: string[] = [];

  // Overview chunk
  const overviewParts: string[] = [];
  if (profile.displayName)
    overviewParts.push(`Name: ${profile.displayName}`);
  if (profile.communicationStyle)
    overviewParts.push(`Style: ${profile.communicationStyle}`);
  if (profile.interests?.length)
    overviewParts.push(`Interests: ${profile.interests.join(", ")}`);
  if (profile.expertiseAreas?.length)
    overviewParts.push(`Expertise: ${profile.expertiseAreas.join(", ")}`);

  if (overviewParts.length > 0) {
    chunks.push(`[profile] ${overviewParts.join(". ")}`);
  }

  // Domain-specific chunks
  if (profile.domains) {
    for (const [domain, data] of Object.entries(profile.domains)) {
      const domainParts = Object.entries(data)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      if (domainParts.length) {
        chunks.push(`[profile:${domain}] ${domainParts.join(". ")}`);
      }
    }
  }

  // Strategic note chunks
  for (const note of profile.strategicNotes) {
    chunks.push(`[profile] [strategy] ${note}`);
  }

  if (chunks.length === 0) return;

  const embeddings = await generateEmbeddings(chunks);

  const documents = chunks.map((content, i) => ({
    id: profileChunkId(uid, i),
    uid,
    content,
    source: "profile",
    timestamp: profile.updatedAt,
    embedding: embeddings[i],
  }));

  // Delete old profile chunks before upserting (profile can shrink)
  try {
    await ts
      .collections(COLLECTION)
      .documents()
      .delete({ filter_by: `uid:=${uid} && source:=profile` });
  } catch {
    // Collection might not have old docs — that's fine
  }

  await ts
    .collections(COLLECTION)
    .documents()
    .import(documents, { action: "upsert" });
}

// ── Index Session Summary (post-compaction) ─────────────────────────
// After a session is compacted, its summary gets indexed for retrieval.

export async function indexSessionSummary(
  uid: string,
  sessionId: string,
  summary: string,
  timestamp: number,
): Promise<void> {
  const ts = getTypesense();
  const text = `[session] ${summary}`;
  const embedding = await generateEmbedding(text);

  await ts
    .collections(COLLECTION)
    .documents()
    .upsert({
      id: `${uid}:session:${sessionId}`,
      uid,
      content: text,
      source: "session",
      timestamp,
      embedding,
    });
}
