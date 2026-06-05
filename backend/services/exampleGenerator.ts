// ── Per-DB GraphRAG Example Generator ────────────────────────────────────────
// For the original SAP dataset we keep the hand-curated query library.
// For any newly registered DB, we deterministically synthesize a small few-shot
// library from the discovered live schema so GraphRAG has DB-specific examples.

import { DEFAULT_DB_ID } from '../db/connectionRegistry.js';
import { getLiveSchema, type LiveSchema, type NodeSchema } from './schemaAgent.js';
import { QUERY_LIBRARY, type QueryExample } from './queryLibrary.js';

const generatedLibraryCache = new Map<string, QueryExample[]>();

export function clearGeneratedLibrary(dbId: string): void {
  generatedLibraryCache.delete(dbId);
}

export function getQueryLibraryForDb(dbId: string): QueryExample[] {
  if (dbId === DEFAULT_DB_ID) {
    return QUERY_LIBRARY;
  }

  const cached = generatedLibraryCache.get(dbId);
  if (cached) return cached;

  const schema = getLiveSchema(dbId);
  if (!schema) {
    return QUERY_LIBRARY.slice(0, 8);
  }

  const generated = buildLibraryFromSchema(schema);
  generatedLibraryCache.set(dbId, generated);
  return generated;
}

function buildLibraryFromSchema(schema: LiveSchema): QueryExample[] {
  const examples: QueryExample[] = [];
  const topNodes = [...schema.nodes].sort((a, b) => b.count - a.count).slice(0, 5);
  const topRelationships = [...schema.relationships].sort((a, b) => b.count - a.count).slice(0, 4);

  for (const node of topNodes) {
    const idProp = pickIdProperty(node);
    const nameProp = pickNameProperty(node);
    const numericProp = pickNumericLikeProperty(node);

    examples.push({
      question: `List sample ${node.label} records`,
      cypher: buildSampleQuery(node.label, idProp, nameProp),
      schemaNodes: [node.label],
    });

    examples.push({
      question: `How many ${node.label} records exist?`,
      cypher: `MATCH (n:\`${node.label}\`) RETURN count(n) AS totalCount LIMIT 1`,
      schemaNodes: [node.label],
    });

    if (numericProp) {
      examples.push({
        question: `What is the total ${numericProp} across ${node.label}?`,
        cypher: `MATCH (n:\`${node.label}\`) WHERE n.\`${numericProp}\` IS NOT NULL RETURN sum(toFloat(n.\`${numericProp}\`)) AS totalValue LIMIT 1`,
        schemaNodes: [node.label],
      });
    }
  }

  for (const rel of topRelationships) {
    examples.push({
      question: `Show sample ${rel.fromLabel} to ${rel.toLabel} connections`,
      cypher: `MATCH (a:\`${rel.fromLabel}\`)-[:${rel.type}]->(b:\`${rel.toLabel}\`) RETURN a, b LIMIT 10`,
      schemaNodes: [rel.fromLabel, rel.toLabel],
    });
  }

  // Deduplicate by question while keeping first occurrence.
  const deduped = new Map<string, QueryExample>();
  for (const example of examples) {
    if (!deduped.has(example.question)) {
      deduped.set(example.question, example);
    }
  }

  return Array.from(deduped.values()).slice(0, 12);
}

function buildSampleQuery(label: string, idProp: string | null, nameProp: string | null): string {
  const fields: string[] = [];
  if (idProp) fields.push(`n.\`${idProp}\` AS id`);
  if (nameProp && nameProp !== idProp) fields.push(`n.\`${nameProp}\` AS name`);
  if (fields.length === 0) fields.push('n AS record');
  return `MATCH (n:\`${label}\`) RETURN ${fields.join(', ')} LIMIT 10`;
}

function pickIdProperty(node: NodeSchema): string | null {
  const propNames = node.properties.map((p) => p.name);
  return propNames.find((p) => ['id', `${lowerFirst(node.label)}Id`, `${node.label.toLowerCase()}Id`].includes(p))
    ?? propNames.find((p) => /(^id$|code$|number$|document$|order$)/i.test(p))
    ?? null;
}

function pickNameProperty(node: NodeSchema): string | null {
  const propNames = node.properties.map((p) => p.name);
  return propNames.find((p) => /name|description|title|label/i.test(p)) ?? null;
}

function pickNumericLikeProperty(node: NodeSchema): string | null {
  for (const prop of node.properties) {
    const typeStr = prop.types.join('|');
    if (/(amount|total|value|quantity|qty|count|price|cost)/i.test(prop.name)) {
      return prop.name;
    }
    if (/(Long|Double|Float|Integer|Number|String)/i.test(typeStr) && /(revenue|sales|metric)/i.test(prop.name)) {
      return prop.name;
    }
  }
  return null;
}

function lowerFirst(value: string): string {
  return value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;
}
