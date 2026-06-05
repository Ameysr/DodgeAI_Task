// ── GraphRAG: Per-DB Few-Shot Retriever + Schema Selector ───────────────────
// Retrieves DB-specific example queries and builds a targeted live-schema
// context for the LLM. Works for both the original SAP graph and any newly
// registered database that has been schema-discovered.

import { getLocalEmbedding } from "./embedding.js";
import { cosineSimilarity } from "../utils/math.js";
import { getQueryLibraryForDb } from "./exampleGenerator.js";
import {
  discoverSchema,
  getLiveSchema,
  getFormattedNodeSchema,
  getRelationshipsForNode,
  getAllFormattedSchemas,
  getAllRelationshipStrings,
} from "./schemaAgent.js";
import { DEFAULT_DB_ID } from "../db/connectionRegistry.js";
import type { QueryExample } from "./queryLibrary.js";

const GENERIC_NOTES = `
CRITICAL RULES:
- Use ONLY node labels, properties, and relationships present in the discovered schema below.
- Do NOT invent relationships, labels, or property names.
- For aggregation queries (COUNT, SUM, AVG) place LIMIT AFTER the aggregation, not before.
- If a value looks numeric but the schema says string, convert it with toFloat() before arithmetic.
- If a field looks like a date stored as string, convert it explicitly before date math.
- Always alias returned columns with human-readable names.
- Prefer OPTIONAL MATCH when a relationship may be missing.`.trim();

const DEFAULT_DB_NOTES = `
SAP DATASET HINTS:
- Customer.id = SalesOrder.soldToParty = BillingHeader.soldToParty = Payment.customer
- Revenue should use active BillingHeader.totalNetAmount, not SalesOrder totals.
- billingDocumentIsCancelled and businessPartnerIsBlocked are booleans.
- DeliveryItem has no material property; join through SalesOrderItem when product context is required.
- BillingHeader → Payment often joins via accountingDocument in addition to relationships.
- Dataset dates are mostly April 2025, so “this month” style questions may need explicit date interpretation.`.trim();

const CONTEXT_CACHE_TTL_MS = parseInt(
  process.env.GRAPHRAG_CONTEXT_CACHE_TTL_MS ?? "600000",
  10,
);
const CONTEXT_CACHE_MAX = parseInt(
  process.env.GRAPHRAG_CONTEXT_CACHE_MAX ?? "100",
  10,
);
const contextCache = new Map<
  string,
  { value: GraphRAGContext; expiresAt: number }
>();
const embeddedLibraries = new Set<string>();

export interface GraphRAGContext {
  fewShotExamples: string;
  schemaSubset: string;
  matchedExamples: string[];
}

export async function retrieveContext(
  dbId: string,
  question: string,
  topK: number = 5,
): Promise<GraphRAGContext> {
  const cacheKey = `${dbId}|${question.trim().toLowerCase()}|topK=${topK}`;
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let liveSchema = getLiveSchema(dbId);
  if (!liveSchema) {
    try {
      liveSchema = await discoverSchema(dbId);
    } catch (err) {
      console.log(
        `  [GraphRAG/${dbId}] Live schema unavailable: ${(err as Error).message?.substring(0, 100)}`,
      );
    }
  }

  const library = getQueryLibraryForDb(dbId);
  embedLibrary(dbId, library);

  const queryEmb = getLocalEmbedding(question);
  const scored = library
    .filter((ex) => ex.embedding)
    .map((ex) => ({
      example: ex,
      score: cosineSimilarity(queryEmb, ex.embedding!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));

  console.log(`  [GraphRAG/${dbId}] Top-${topK} matches:`);
  for (const { example, score } of scored) {
    console.log(
      `    ${score.toFixed(3)} → "${example.question.substring(0, 60)}..."`,
    );
  }

  const fewShotExamples =
    scored.length > 0
      ? scored
          .map(
            ({ example }, i) =>
              `Example ${i + 1}:\nQ: "${example.question}"\nCypher: ${example.cypher}`,
          )
          .join("\n\n")
      : "No curated examples available for this database yet. Use the live schema below carefully.";

  const relevantNodes = new Set<string>();
  for (const { example } of scored) {
    for (const node of example.schemaNodes) {
      relevantNodes.add(node);
    }
  }

  if (liveSchema) {
    const questionLower = question.toLowerCase();
    for (const node of liveSchema.nodes) {
      if (questionLower.includes(node.label.toLowerCase())) {
        relevantNodes.add(node.label);
      }
    }

    if (relevantNodes.size === 0) {
      for (const node of [...liveSchema.nodes]
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)) {
        relevantNodes.add(node.label);
      }
    }
  }

  let nodeLines: string[] = [];
  let relLines: string[] = [];

  if (liveSchema) {
    nodeLines = Array.from(relevantNodes)
      .map((label) => getFormattedNodeSchema(label, dbId))
      .filter((s): s is string => s !== null)
      .map((s) => `- ${s}`);

    if (nodeLines.length < 3) {
      nodeLines = Object.values(getAllFormattedSchemas(dbId)).map(
        (s) => `- ${s}`,
      );
    }

    const relSet = new Set<string>();
    for (const label of relevantNodes) {
      for (const rel of getRelationshipsForNode(label, dbId)) {
        relSet.add(rel);
      }
    }
    if (relSet.size < 3) {
      for (const rel of getAllRelationshipStrings(dbId)) {
        relSet.add(rel);
      }
    }
    relLines = Array.from(relSet);
  }

  const notes =
    dbId === DEFAULT_DB_ID
      ? `${GENERIC_NOTES}\n\n${DEFAULT_DB_NOTES}`
      : GENERIC_NOTES;

  const schemaSubset = liveSchema
    ? `Node types (LIVE — auto-discovered from database):\n${nodeLines.join("\n")}\n\nRelationships:\n${relLines.join("\n")}\n\n${notes}`
    : `Schema discovery has not succeeded for this database yet. Use very conservative Cypher and do not assume unavailable labels or relationships.\n\n${notes}`;

  const ctx: GraphRAGContext = {
    fewShotExamples,
    schemaSubset,
    matchedExamples: scored.map((s) => s.example.question),
  };

  contextCache.set(cacheKey, {
    value: ctx,
    expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
  });
  if (contextCache.size > CONTEXT_CACHE_MAX) {
    const oldestKey = contextCache.keys().next().value as string | undefined;
    if (oldestKey) contextCache.delete(oldestKey);
  }

  return ctx;
}

function embedLibrary(dbId: string, library: QueryExample[]): void {
  if (embeddedLibraries.has(dbId)) return;

  console.log(
    `  [GraphRAG/${dbId}] Embedding ${library.length} example queries...`,
  );
  for (const example of library) {
    if (!example.embedding) {
      example.embedding = getLocalEmbedding(example.question);
    }
  }
  embeddedLibraries.add(dbId);
  console.log(`  [GraphRAG/${dbId}] Library embedded (TF-IDF) ✓`);
}
