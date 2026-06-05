// ── SCHEMA DISCOVERY AGENT (per-DB) ──────────────────────────────────────────
// Introspects any registered Neo4j database on demand to discover ALL node
// labels, properties, relationship types, and sample values.
//
// Each DB's schema is stored in a Map<dbId, LiveSchema> so multiple databases
// can be served concurrently without state collision.
//
// Backward-compatible: all public functions accept an optional `dbId` and
// fall back to the current default DB when omitted, so existing callers
// (graphRAG.ts, server.ts) work without changes.

import { runRegisteredQuery } from "../db/connectionRegistry.js";
import { getDefaultDbId } from "../db/connectionRegistry.js";

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface NodeProperty {
  name: string;
  types: string[]; // e.g. ["String"], ["Boolean"], ["Long"]
  sampleValues: unknown[]; // 3-5 real values from the DB
}

export interface NodeSchema {
  label: string;
  properties: NodeProperty[];
  count: number;
}

export interface RelationshipSchema {
  type: string;
  fromLabel: string;
  toLabel: string;
  count: number;
}

export interface LiveSchema {
  nodes: NodeSchema[];
  relationships: RelationshipSchema[];
  discoveredAt: string;
  totalNodeLabels: number;
  totalRelTypes: number;
  totalProperties: number;
  /** The dbId this schema belongs to */
  dbId: string;
}

// ── PER-DB SCHEMA STORE ───────────────────────────────────────────────────────

/** Keyed by dbId — holds the live schema for every analyzed database. */
const _liveSchemas = new Map<string, LiveSchema>();

// ── PUBLIC GETTERS ────────────────────────────────────────────────────────────

/** Returns the live schema for a given DB, or null if not yet discovered. */
export function getLiveSchema(dbId?: string): LiveSchema | null {
  return _liveSchemas.get(dbId ?? getDefaultDbId()) ?? null;
}

/** Returns true if a schema has been discovered for the given DB. */
export function hasSchema(dbId: string): boolean {
  return _liveSchemas.has(dbId);
}

/** All valid node labels for a DB (empty set if schema not discovered). */
export function getValidNodeLabels(dbId?: string): Set<string> {
  const schema = _liveSchemas.get(dbId ?? getDefaultDbId());
  if (!schema) return new Set();
  return new Set(schema.nodes.map((n) => n.label));
}

/** All valid relationship types for a DB (empty set if schema not discovered). */
export function getValidRelationships(dbId?: string): Set<string> {
  const schema = _liveSchemas.get(dbId ?? getDefaultDbId());
  if (!schema) return new Set();
  return new Set(schema.relationships.map((r) => r.type));
}

// ── FORMATTED SCHEMA STRINGS (for LLM context) ───────────────────────────────

/** Format a single NodeSchema into a human/LLM-readable property string. */
function formatNodeSchema(node: NodeSchema): string {
  const props = node.properties.map((p) => {
    const typeStr = p.types.join("|");

    let hint = "";
    if (typeStr.includes("Boolean")) {
      hint = "(boolean)";
    } else if (
      typeStr.includes("Long") ||
      typeStr.includes("Double") ||
      typeStr.includes("Float")
    ) {
      hint = "(number)";
    } else {
      hint = "(string)";
    }

    const samples = p.sampleValues
      .filter((v) => v !== null && v !== undefined)
      .slice(0, 3);
    const sampleStr =
      samples.length > 0
        ? `, e.g. ${samples.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(", ")}`
        : "";

    let specialHint = "";
    if (
      /(amount|netamount|totalnetamount|totalamount)$/i.test(p.name) &&
      typeStr.includes("String")
    ) {
      specialHint = " — use toFloat() before arithmetic";
    }
    if (/date$/i.test(p.name) && typeStr.includes("String")) {
      specialHint = ' — string "YYYY-MM-DD", use date() to convert';
    }
    if (
      /(iscancelled|isblocked|ismarkedfor)/i.test(p.name) &&
      typeStr.includes("Boolean")
    ) {
      specialHint = " — use = true / = false";
    }

    return `${p.name}${hint}${sampleStr}${specialHint}`;
  });
  return `${node.label} {${props.join(", ")}}`;
}

/** Returns the formatted schema string for one node label in a specific DB. */
export function getFormattedNodeSchema(
  label: string,
  dbId?: string,
): string | null {
  const schema = _liveSchemas.get(dbId ?? getDefaultDbId());
  if (!schema) return null;
  const node = schema.nodes.find((n) => n.label === label);
  if (!node) return null;
  return formatNodeSchema(node);
}

/** Returns formatted schema strings for ALL node labels in a specific DB. */
export function getAllFormattedSchemas(dbId?: string): Record<string, string> {
  const schema = _liveSchemas.get(dbId ?? getDefaultDbId());
  if (!schema) return {};
  const result: Record<string, string> = {};
  for (const node of schema.nodes) {
    result[node.label] = formatNodeSchema(node);
  }
  return result;
}

// ── RELATIONSHIP HELPERS ──────────────────────────────────────────────────────

/** All relationship strings that involve a given node label (from or to). */
export function getRelationshipsForNode(
  label: string,
  dbId?: string,
): string[] {
  const schema = _liveSchemas.get(dbId ?? getDefaultDbId());
  if (!schema) return [];
  return schema.relationships
    .filter((r) => r.fromLabel === label || r.toLabel === label)
    .map((r) => `(${r.fromLabel})-[:${r.type}]->(${r.toLabel})`);
}

/** All relationship strings in the DB schema. */
export function getAllRelationshipStrings(dbId?: string): string[] {
  const schema = _liveSchemas.get(dbId ?? getDefaultDbId());
  if (!schema) return [];
  return schema.relationships.map(
    (r) => `(${r.fromLabel})-[:${r.type}]->(${r.toLabel})`,
  );
}

// ── SCHEMA DISCOVERY ──────────────────────────────────────────────────────────

/**
 * Introspect a registered Neo4j database and store its schema.
 *
 * @param dbId   The registry id of the database to analyze.
 *               Defaults to the current default DB when omitted.
 * @returns      The fully populated LiveSchema.
 */
export async function discoverSchema(dbId?: string): Promise<LiveSchema> {
  const resolvedId = dbId ?? getDefaultDbId();
  console.log(`  [SchemaAgent/${resolvedId}] Starting schema discovery...`);
  const startTime = Date.now();

  // ── Step 1: All node labels and counts ────────────────────────────────────
  const labelResults = await runRegisteredQuery(
    resolvedId,
    `
    MATCH (n)
    WITH labels(n)[0] AS label, count(n) AS cnt
    RETURN label, cnt
    ORDER BY cnt DESC
  `,
    {},
  );

  const labels = labelResults
    .map((r) => ({ label: r.label as string, count: r.cnt as number }))
    .filter((r) => r.label);

  console.log(
    `  [SchemaAgent/${resolvedId}] Found ${labels.length} node labels: ${labels.map((l) => l.label).join(", ")}`,
  );

  // ── Step 2: Properties + sample values per label ──────────────────────────
  const nodeSchemas: NodeSchema[] = [];

  for (const { label, count } of labels) {
    try {
      // Adaptive sample: small collections scanned fully, large ones sampled.
      const sampleLimit = count <= 500 ? count : count <= 5000 ? 100 : 50;

      const propResults = await runRegisteredQuery(
        resolvedId,
        `
        MATCH (n:\`${label}\`)
        WITH n LIMIT ${sampleLimit}
        UNWIND keys(n) AS propKey
        WITH propKey, collect(n[propKey])[0..5] AS samples
        RETURN propKey, samples
        ORDER BY propKey
      `,
        {},
      );

      const properties: NodeProperty[] = propResults.map((r) => {
        const samples = (r.samples as unknown[]) ?? [];
        const types: string[] = [];
        for (const s of samples) {
          if (s === null || s === undefined) continue;
          if (typeof s === "boolean") {
            if (!types.includes("Boolean")) types.push("Boolean");
          } else if (typeof s === "number") {
            if (!types.includes("Long")) types.push("Long");
          } else if (typeof s === "string") {
            if (!types.includes("String")) types.push("String");
          } else {
            if (!types.includes("Object")) types.push("Object");
          }
        }
        if (types.length === 0) types.push("String");

        return {
          name: r.propKey as string,
          types,
          sampleValues: samples
            .filter((s) => s !== null && s !== undefined)
            .slice(0, 3),
        };
      });

      nodeSchemas.push({ label, properties, count });
    } catch (err) {
      console.log(
        `  [SchemaAgent/${resolvedId}] Warning: Could not introspect ${label}: ${(err as Error).message?.substring(0, 60)}`,
      );
      nodeSchemas.push({ label, properties: [], count });
    }
  }

  // ── Step 3: Relationship types with start/end labels ──────────────────────
  const relResults = await runRegisteredQuery(
    resolvedId,
    `
    MATCH (a)-[r]->(b)
    WITH labels(a)[0] AS fromLabel, type(r) AS relType, labels(b)[0] AS toLabel, count(r) AS cnt
    RETURN fromLabel, relType, toLabel, cnt
    ORDER BY cnt DESC
  `,
    {},
  );

  const relationships: RelationshipSchema[] = relResults.map((r) => ({
    type: r.relType as string,
    fromLabel: r.fromLabel as string,
    toLabel: r.toLabel as string,
    count: r.cnt as number,
  }));

  console.log(
    `  [SchemaAgent/${resolvedId}] Found ${relationships.length} relationship types`,
  );

  // ── Step 4: Store ─────────────────────────────────────────────────────────
  const totalProperties = nodeSchemas.reduce(
    (sum, n) => sum + n.properties.length,
    0,
  );

  const liveSchema: LiveSchema = {
    nodes: nodeSchemas,
    relationships,
    discoveredAt: new Date().toISOString(),
    totalNodeLabels: nodeSchemas.length,
    totalRelTypes: relationships.length,
    totalProperties,
    dbId: resolvedId,
  };

  _liveSchemas.set(resolvedId, liveSchema);

  const elapsed = Date.now() - startTime;
  console.log(
    `  [SchemaAgent/${resolvedId}] Discovery complete in ${elapsed}ms — ${nodeSchemas.length} node types, ${relationships.length} rel types, ${totalProperties} properties`,
  );

  for (const node of nodeSchemas) {
    const propNames = node.properties.map((p) => p.name).join(", ");
    console.log(`    ${node.label} (${node.count} nodes): ${propNames}`);
  }

  return liveSchema;
}

/**
 * Remove a DB's schema from the in-memory store.
 * Called when a DB is deregistered.
 */
export function clearSchema(dbId: string): void {
  _liveSchemas.delete(dbId);
  console.log(`  [SchemaAgent] Schema cleared for: ${dbId}`);
}
