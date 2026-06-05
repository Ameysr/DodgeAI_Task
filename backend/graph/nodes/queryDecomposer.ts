// ── QUERY DECOMPOSITION ENGINE ────────────────────────────────────────────────
// Breaks complex multi-part questions into simpler sub-queries, executes each
// independently, and merges the results. This dramatically improves accuracy
// for questions that need multiple hops or combine different metrics.

import { callLLM } from "../../services/llm.js";
import { runQuery } from "../../db.js";
import { retrieveContext } from "../../services/graphRAG.js";
import { validateCypher, enforceSizeLimit } from "./guardrail.js";
import type { QueryResult } from "../../types/index.js";

export interface DecomposedQuery {
  subQuestion: string;
  purpose: string;
  cypher: string;
}

export interface DecompositionResult {
  wasDecomposed: boolean;
  subQueries: DecomposedQuery[];
  mergedResults: QueryResult[];
  errors: string[];
}

// ── DETECT IF A QUESTION NEEDS DECOMPOSITION ────────────────────────────────
// Returns true for questions that combine multiple independent data lookups
// or need multi-step reasoning that can't be done in a single Cypher query.

export function needsDecomposition(question: string): boolean {
  const lower = question.toLowerCase();

  // Pattern 1: Multiple explicit conjunctions asking for different things
  // "Show orders AND their payments AND the customer details"
  const conjunctionParts = lower
    .split(
      /\b(?:and also|and then|and|also|plus|along with|as well as|additionally)\b/,
    )
    .filter((p) => p.trim().length > 10);
  if (conjunctionParts.length >= 3) return true;

  // Pattern 2: Multiple distinct question marks or semicolons
  const questionMarks = (question.match(/\?/g) || []).length;
  if (questionMarks >= 2) return true;

  // Pattern 3: Explicit multi-step phrasing
  if (
    /\b(first|then|next|after that|subsequently|finally)\b.*\b(first|then|next|after that|subsequently|finally)\b/i.test(
      question,
    )
  )
    return true;

  // Pattern 4: Cross-domain aggregation combining 3+ different metrics
  const metricKeywords = [
    "revenue",
    "order",
    "delivery",
    "billing",
    "payment",
    "cancel",
    "fulfillment",
    "aging",
    "dso",
    "cycle time",
    "exposure",
  ];
  const foundMetrics = metricKeywords.filter((k) => lower.includes(k));
  if (foundMetrics.length >= 4) return true;

  // Pattern 5: Questions with "compare" + multiple entities + multiple metrics
  if (/compare|versus|vs/i.test(lower) && foundMetrics.length >= 3) return true;

  return false;
}

// ── DECOMPOSE A COMPLEX QUESTION ────────────────────────────────────────────
// Uses LLM to break the question into 2-4 sub-queries, each answerable by
// a single Cypher query. Then generates Cypher for each sub-query.

export async function decomposeAndExecute(
  dbId: string,
  question: string,
  entities: Record<string, string>,
): Promise<DecompositionResult> {
  const errors: string[] = [];

  // Step 1: Ask LLM to decompose the question
  const decompositionPrompt = `You are a query planner for a Neo4j graph database.

Break this complex question into 2-4 simpler sub-questions. Each sub-question should be answerable by a single Cypher query.

DOMAIN CONTEXT:
- The active database is identified by dbId = ${dbId}
- Work only with the graph schema for this active database
- Do not invent entities, labels, or relationships that are not present in the graph

RULES:
- Each sub-question must be self-contained and answerable independently
- Order sub-questions from simplest to most complex
- Keep entity IDs from the original question in each relevant sub-question
- Maximum 4 sub-questions

Respond with ONLY valid JSON:
{
  "subQuestions": [
    { "subQuestion": "What are the total orders?", "purpose": "Get order count baseline" },
    { "subQuestion": "How many were delivered?", "purpose": "Get delivery fulfillment" }
  ]
}`;

  let subQuestions: Array<{ subQuestion: string; purpose: string }> = [];

  try {
    const response = await callLLM({
      systemPrompt: decompositionPrompt,
      userPrompt: `Complex question: "${question}"\nEntities: ${JSON.stringify(entities)}`,
      tier: 2,
      maxTokens: 400,
      callerTag: "query-decomposer",
    });

    const parsed = JSON.parse(response.text) as {
      subQuestions: Array<{ subQuestion: string; purpose: string }>;
    };
    subQuestions = parsed.subQuestions?.slice(0, 4) ?? [];
  } catch (err) {
    errors.push(`Decomposition failed: ${(err as Error).message}`);
    return { wasDecomposed: false, subQueries: [], mergedResults: [], errors };
  }

  if (subQuestions.length < 2) {
    return {
      wasDecomposed: false,
      subQueries: [],
      mergedResults: [],
      errors: ["Not enough sub-questions generated"],
    };
  }

  console.log(`  [Decompose] Split into ${subQuestions.length} sub-queries:`);
  subQuestions.forEach((sq, i) =>
    console.log(`    ${i + 1}. ${sq.subQuestion} (${sq.purpose})`),
  );

  // Step 2: Generate and execute Cypher for each sub-query
  const subResults: DecomposedQuery[] = [];
  const allResults: QueryResult[] = [];

  for (let i = 0; i < subQuestions.length; i++) {
    const sq = subQuestions[i];
    try {
      // Get GraphRAG context for this specific sub-question
      const ragContext = await retrieveContext(dbId, sq.subQuestion, 3);

      const cypherPrompt = `You are a Neo4j Cypher query composer for the active graph database.
Write a Cypher query for this specific sub-question.

CYPHER RULES:
- ALLOWED: MATCH, WHERE, WITH, OPTIONAL MATCH, RETURN, ORDER BY, LIMIT, UNWIND, CASE WHEN, aggregations
- FORBIDDEN: CREATE, DELETE, SET, MERGE, DROP, DETACH, window functions (OVER)
- Always add LIMIT (max 50)
- Amount fields (totalNetAmount, netAmount) are STRINGS — use toFloat() before arithmetic
- billingDocumentIsCancelled is BOOLEAN
- Date fields are strings "YYYY-MM-DD" — use date() to convert

SCHEMA:
${ragContext.schemaSubset}

EXAMPLE QUERIES:
${ragContext.fewShotExamples}

Respond with ONLY valid JSON:
{ "cypher": "MATCH ... RETURN ..." }`;

      const cypherResponse = await callLLM({
        systemPrompt: cypherPrompt,
        userPrompt: `Sub-question: "${sq.subQuestion}"\nEntities: ${JSON.stringify(entities)}`,
        tier: 2,
        maxTokens: 400,
        callerTag: `decompose-cypher-${i + 1}`,
      });

      let cypher = "";
      try {
        const parsed = JSON.parse(cypherResponse.text) as { cypher: string };
        cypher = parsed.cypher;
      } catch {
        // Try extracting raw Cypher
        const match = cypherResponse.text.match(
          /MATCH[\s\S]+?(?:RETURN|LIMIT)[\s\S]*/im,
        );
        if (match) cypher = match[0];
      }

      if (!cypher) {
        errors.push(`Sub-query ${i + 1}: No Cypher generated`);
        continue;
      }

      // Validate
      const validation = validateCypher(cypher);
      if (!validation.valid) {
        errors.push(`Sub-query ${i + 1}: ${validation.reason}`);
        continue;
      }

      cypher = enforceSizeLimit(cypher);

      // Execute
      const records = await runQuery(cypher, {});
      console.log(
        `  [Decompose] Sub-query ${i + 1}: ${records.length} results`,
      );

      subResults.push({
        subQuestion: sq.subQuestion,
        purpose: sq.purpose,
        cypher,
      });

      // Tag results with their sub-question context
      for (const record of records) {
        const taggedRecord = {
          ...record,
          _subQueryIndex: i + 1,
          _subQuestion: sq.subQuestion,
        } as QueryResult;
        allResults.push(taggedRecord);
      }
    } catch (err) {
      errors.push(
        `Sub-query ${i + 1} failed: ${(err as Error).message?.substring(0, 100)}`,
      );
      console.log(
        `  [Decompose] Sub-query ${i + 1} FAILED: ${(err as Error).message?.substring(0, 80)}`,
      );
    }
  }

  return {
    wasDecomposed: subResults.length >= 2,
    subQueries: subResults,
    mergedResults: allResults,
    errors,
  };
}
