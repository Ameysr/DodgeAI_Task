import type { O2CGraphState } from "../state.js";
import type { FunctionResult } from "../../types/index.js";
import { callLLM } from "../../services/llm.js";
import { runQuery } from "../../db.js";
import { validateCypher, enforceSizeLimit } from "./guardrail.js";
import { retrieveContext } from "../../services/graphRAG.js";
import * as lookup from "../../functions/lookup.js";
import * as traverse from "../../functions/traverse.js";
import * as aggregate from "../../functions/aggregate.js";
import * as detect from "../../functions/detect.js";
import * as compare from "../../functions/compare.js";
import * as meta from "../../functions/meta.js";
import * as analytics from "../../functions/analytics.js";
import {
  getValidNodeLabels,
  getValidRelationships,
} from "../../services/schemaAgent.js";

// Map function names to actual implementations
const FUNCTION_MAP: Record<
  string,
  (...args: unknown[]) => Promise<FunctionResult>
> = {
  getCustomer: (p: unknown) =>
    lookup.getCustomer((p as Record<string, string>).customerId),
  getOrder: (p: unknown) =>
    lookup.getOrder((p as Record<string, string>).orderId),
  getProduct: (p: unknown) =>
    lookup.getProduct((p as Record<string, string>).productId),
  getBillingDoc: (p: unknown) =>
    lookup.getBillingDoc((p as Record<string, string>).billingDocId),
  getDelivery: (p: unknown) =>
    lookup.getDelivery((p as Record<string, string>).deliveryId),
  traceDocument: (p: unknown) =>
    traverse.traceDocument((p as Record<string, string>).billingDocId),
  getOrderDeliveries: (p: unknown) =>
    traverse.getOrderDeliveries((p as Record<string, string>).orderId),
  getDeliveryBilling: (p: unknown) =>
    traverse.getDeliveryBilling((p as Record<string, string>).deliveryId),
  traceOrderJourney: (p: unknown) =>
    traverse.traceOrderJourney((p as Record<string, string>).orderId),
  compareCustomerRevenue: (p: unknown) =>
    compare.compareCustomerRevenue(
      (p as Record<string, string>).customerId1,
      (p as Record<string, string>).customerId2,
    ),
  compareCustomerOrders: (p: unknown) =>
    compare.compareCustomerOrders(
      (p as Record<string, string>).customerId1,
      (p as Record<string, string>).customerId2,
    ),
  getEntityTypesSummary: () => meta.getEntityTypesSummary(),
  getSalesOrderItemToDeliveryItemJoinInfo: () =>
    meta.getSalesOrderItemToDeliveryItemJoinInfo(),
  getBusinessPartnerToBillingDocumentPath: () =>
    meta.getBusinessPartnerToBillingDocumentPath(),
  getDeliveryGoodsMovementStatusCounts: () =>
    meta.getDeliveryGoodsMovementStatusCounts(),
  traceSalesOrderToDeliveryAndBilling: (p: unknown) =>
    meta.traceSalesOrderToDeliveryAndBilling(
      (p as Record<string, string>).orderId,
    ),
  getBillingItemsReferencingDelivery: (p: unknown) =>
    meta.getBillingItemsReferencingDelivery(
      (p as Record<string, string>).deliveryId,
    ),
  getProductsWithMaxPlantCoverage: () => meta.getProductsWithMaxPlantCoverage(),
  getCustomerBilledVsPaidBalance: (p: unknown) =>
    meta.getCustomerBilledVsPaidBalance(
      (p as Record<string, string>).customerId,
    ),
  getPaymentsCollectedThisMonth: () => meta.getPaymentsCollectedThisMonth(),
  getDeliveriesNotBilled: () => meta.getDeliveriesNotBilled(),
  getOrderToPaymentCycleTime: () => meta.getOrderToPaymentCycleTime(),
  getPaymentsWithoutJournalEntries: () =>
    meta.getPaymentsWithoutJournalEntries(),
  getPaymentsCollectedLastMonth: () => meta.getPaymentsCollectedLastMonth(),
  getSalesRevenueLastMonth: () => meta.getSalesRevenueLastMonth(),
  getOrdersPlacedByCustomer: (p: unknown) =>
    meta.getOrdersPlacedByCustomer((p as Record<string, string>).customerId),
  getProductsStoredInPlant: (p: unknown) =>
    meta.getProductsStoredInPlant((p as Record<string, string>).plantId),
  getCancelledInvoicesSummary: () => meta.getCancelledInvoicesSummary(),
  getO2CGraphSchemaDesign: () => meta.getO2CGraphSchemaDesign(),
  analyzeBillingCancellationAnomaly: () =>
    meta.analyzeBillingCancellationAnomaly(),
  getProfitCenterToProductsTrace: () => meta.getProfitCenterToProductsTrace(),
  getTopProducts: (p: unknown) => {
    const params = p as Record<string, string>;
    return aggregate.getTopProducts(
      params.metric ?? "billing",
      Number(params.limit) || 10,
    );
  },
  getTopCustomers: (p: unknown) => {
    const params = p as Record<string, string>;
    return aggregate.getTopCustomers(
      params.metric ?? "orders",
      Number(params.limit) || 10,
    );
  },
  getOrdersByOrg: (p: unknown) => {
    const params = p as Record<string, string>;
    return aggregate.getOrdersByOrg(params.orgId || null);
  },
  getRevenueConcentration: () => aggregate.getRevenueConcentration(),
  getActiveBillingTotals: () => aggregate.getActiveBillingTotals(),
  getShippingPointBreakdown: () => aggregate.getShippingPointBreakdown(),
  getSalesOrderValueByChannel: () => aggregate.getSalesOrderValueByChannel(),
  getBillingDocsByCreationDate: () => aggregate.getBillingDocsByCreationDate(),
  getTopActiveBillingMonthRevenue: () =>
    aggregate.getTopActiveBillingMonthRevenue(),
  getTopDeliveriesByProductCount: (p: unknown) =>
    aggregate.getTopDeliveriesByProductCount(
      Number((p as Record<string, string>).limit) || 10,
    ),
  getSoLineItemStats: () => aggregate.getSoLineItemStats(),
  getAllCustomersWithOrderCounts: (p: unknown) =>
    aggregate.getAllCustomersWithOrderCounts(
      Number((p as Record<string, string>).limit) || 50,
    ),
  getMaterialGroupsAnalysis: () => aggregate.getMaterialGroupsAnalysis(),
  getUniqueMaterialsOrderedVsBilled: () =>
    aggregate.getUniqueMaterialsOrderedVsBilled(),
  getDeliveryCompletionPerCustomer: () =>
    aggregate.getDeliveryCompletionPerCustomer(),
  getTopMaterialsByBilledQuantity: (p: unknown) =>
    aggregate.getTopMaterialsByBilledQuantity(
      Number((p as Record<string, string>).limit) || 10,
    ),
  getSalesOrderWithMostLineItems: () =>
    aggregate.getSalesOrderWithMostLineItems(),
  getPaymentCollectionRate: () => aggregate.getPaymentCollectionRate(),
  findBrokenFlows: (p: unknown) =>
    detect.findBrokenFlows((p as Record<string, string>).type ?? "undelivered"),
  getUnpaidInvoices: (p: unknown) =>
    detect.getUnpaidInvoices(Number((p as Record<string, string>).limit) || 10),
  getCancelledDocs: (p: unknown) =>
    detect.getCancelledDocs(Number((p as Record<string, string>).limit) || 10),
  getCustomerBillingSummary: (p: unknown) =>
    detect.getCustomerBillingSummary((p as Record<string, string>).customerId),
  getCancelledAfterPayment: () => detect.getCancelledAfterPayment(),
  getCustomersWithoutBilling: () => detect.getCustomersWithoutBilling(),
  getProductsNeverDelivered: () => detect.getProductsNeverDelivered(),
  getFullAnomalyReport: () => detect.getFullAnomalyReport(),
  getDeliveryFulfillmentRate: () => detect.getDeliveryFulfillmentRate(),
  getMostExpensiveBillingItem: () => detect.getMostExpensiveBillingItem(),
  getJournalEntryDistribution: () => detect.getJournalEntryDistribution(),
  getPaymentClearingTime: () => detect.getPaymentClearingTime(),
  getPaymentTermsSplit: () => detect.getPaymentTermsSplit(),
  getBillingDocTypeBreakdown: () => detect.getBillingDocTypeBreakdown(),
  getPlantRevenueRanking: () => detect.getPlantRevenueRanking(),
  getUnpaidActiveBillingDocs: () => detect.getUnpaidActiveBillingDocs(),
  getMaterialsNeverDelivered: () => detect.getMaterialsNeverDelivered(),
  getSystemPipelineDescription: (p: unknown) => {
    const params = p as Record<string, string>;
    return meta.getSystemPipelineDescription(
      params.mentionedQuery,
      params.entities ? JSON.parse(params.entities) : undefined,
    );
  },
  // ── ANALYTICS (formerly null-function plans) ──
  getO2CHealthSummary: () => analytics.getO2CHealthSummary(),
  getARAgingBuckets: () => analytics.getARAgingBuckets(),
  getDSOPerCustomer: () => analytics.getDSOPerCustomer(),
  getCreditExposure: () => analytics.getCreditExposure(),
  getCancellationRateByCustomer: () =>
    analytics.getCancellationRateByCustomer(),
  getCurrencyAnalysis: () => analytics.getCurrencyAnalysis(),
  getBlockedCustomersWithOrders: () =>
    analytics.getBlockedCustomersWithOrders(),
  getCustomerOrderRecency: () => analytics.getCustomerOrderRecency(),
  getDeliveryLeadTime: () => analytics.getDeliveryLeadTime(),
  getOverdueDeliveries: () => analytics.getOverdueDeliveries(),
  getHighValueOrders: () => analytics.getHighValueOrders(),
  getDebitCreditTotals: () => analytics.getDebitCreditTotals(),
  getFIPostingGaps: () => analytics.getFIPostingGaps(),
  getSingleCustomerProducts: () => analytics.getSingleCustomerProducts(),
  getCrossDomainSummary: () => analytics.getCrossDomainSummary(),
  getOrderValueDistribution: () => analytics.getOrderValueDistribution(),
  getDeliveryStatusBreakdown: () => analytics.getDeliveryStatusBreakdown(),
  getIncotermsAnalysis: () => analytics.getIncotermsAnalysis(),
  getArchivingVsBlockedAnalysis: () =>
    analytics.getArchivingVsBlockedAnalysis(),
};

// ── SCHEMA-AWARE CYPHER VALIDATION ────────────────────────────────────────────
// Validates generated Cypher against the known graph schema to catch errors
// BEFORE execution, saving Neo4j round-trips and retry cycles.
// Uses LIVE schema from SchemaAgent when available, falls back to hardcoded sets.

const HARDCODED_NODE_LABELS = new Set([
  "Customer",
  "SalesOrder",
  "SalesOrderItem",
  "ScheduleLine",
  "Product",
  "DeliveryHeader",
  "DeliveryItem",
  "BillingHeader",
  "BillingItem",
  "BillingCancellation",
  "JournalEntry",
  "Payment",
  "Plant",
  "Address",
  "CustomerCompany",
  "CustomerSalesArea",
  "ProductPlant",
  "ProductDescription",
  "ProductStorageLocation",
]);

const HARDCODED_RELATIONSHIPS = new Set([
  "PLACED",
  "HAS_ITEM",
  "HAS_SCHEDULE_LINE",
  "REFERENCES",
  "FULFILLED_BY",
  "PART_OF",
  "AT_PLANT",
  "BILLED_IN",
  "POSTED_AS",
  "PAID_BY",
  "CANCELS",
  "HAS_ADDRESS",
  "ASSIGNED_TO_COMPANY",
  "SELLS_THROUGH",
  "STOCKED_AT",
  "IN_PLANT",
  "HAS_DESCRIPTION",
  "FOR_PRODUCT",
]);

function getEffectiveNodeLabels(dbId: string): Set<string> {
  const live = getValidNodeLabels(dbId);
  return live.size > 0 ? live : HARDCODED_NODE_LABELS;
}

function getEffectiveRelationships(dbId: string): Set<string> {
  const live = getValidRelationships(dbId);
  return live.size > 0 ? live : HARDCODED_RELATIONSHIPS;
}

// ── FULL RELATIONSHIP REFERENCE (injected into every Cypher generation prompt) ─
const RELATIONSHIP_REFERENCE = `
VALID RELATIONSHIPS — use ONLY these (DO NOT invent new ones):
(Customer)-[:PLACED]->(SalesOrder)
(SalesOrder)-[:HAS_ITEM]->(SalesOrderItem)
(SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(ScheduleLine)
(SalesOrderItem)-[:REFERENCES]->(Product)
(SalesOrderItem)-[:FULFILLED_BY]->(DeliveryItem)
(DeliveryItem)-[:PART_OF]->(DeliveryHeader)
(DeliveryItem)-[:AT_PLANT]->(Plant)
(DeliveryHeader)-[:BILLED_IN]->(BillingItem)
(BillingItem)-[:PART_OF]->(BillingHeader)
(BillingHeader)-[:POSTED_AS]->(JournalEntry)
(BillingHeader)-[:PAID_BY]->(Payment)
(BillingCancellation)-[:CANCELS]->(BillingHeader)
(Product)-[:STOCKED_AT]->(ProductPlant)
(ProductPlant)-[:IN_PLANT]->(Plant)
(Customer)-[:HAS_ADDRESS]->(Address)
(Customer)-[:ASSIGNED_TO_COMPANY]->(CustomerCompany)
(Customer)-[:SELLS_THROUGH]->(CustomerSalesArea)
(Product)-[:HAS_DESCRIPTION]->(ProductDescription)

COMMON MISTAKES TO AVOID:
- There is NO [:HAS] relationship — use [:HAS_ITEM] for SalesOrder→SalesOrderItem
- There is NO [:DELIVERS] or [:DELIVERED_BY] — use [:FULFILLED_BY] for SalesOrderItem→DeliveryItem
- There is NO [:BELONGS_TO] — use [:PART_OF] for Item→Header
- There is NO [:BILLED] or [:INVOICED] — use [:BILLED_IN] for DeliveryHeader→BillingItem
- There is NO [:PAYS] — use [:PAID_BY] for BillingHeader→Payment
- There is NO [:ORDERED_BY] — use [:PLACED] for Customer→SalesOrder
- BillingItem has NO relationship to Product — use bi.material string property directly
`.trim();

// ── CYPHER AUTO-REPAIR ────────────────────────────────────────────────────────
// Fixes common LLM mistakes before schema validation, avoiding wasted retries.
const RELATIONSHIP_REPAIRS: Record<string, string> = {
  HAS: "HAS_ITEM",
  CONTAINS: "HAS_ITEM",
  HAS_ITEMS: "HAS_ITEM",
  DELIVERS: "FULFILLED_BY",
  DELIVERED_BY: "FULFILLED_BY",
  FULFILLS: "FULFILLED_BY",
  BELONGS_TO: "PART_OF",
  MEMBER_OF: "PART_OF",
  IN: "PART_OF",
  BILLED: "BILLED_IN",
  INVOICED: "BILLED_IN",
  INVOICED_IN: "BILLED_IN",
  PAYS: "PAID_BY",
  PAYMENT: "PAID_BY",
  ORDERED_BY: "PLACED",
  ORDERS: "PLACED",
  POSTED: "POSTED_AS",
  JOURNAL: "POSTED_AS",
  STOCKED: "STOCKED_AT",
  AT: "AT_PLANT",
  CANCELLED: "CANCELS",
  CANCELLED_BY: "CANCELS",
  REFERS_TO: "REFERENCES",
  FOR: "REFERENCES",
};

function autoRepairCypher(cypher: string): {
  repaired: string;
  fixes: string[];
} {
  const fixes: string[] = [];
  let repaired = cypher;

  // Fix relationship types
  const relPattern = /\[(\w*):([A-Z_]+)\]/g;
  repaired = repaired.replace(relPattern, (match, alias, relType) => {
    const fix = RELATIONSHIP_REPAIRS[relType];
    if (fix) {
      fixes.push(`[:${relType}] → [:${fix}]`);
      return `[${alias}:${fix}]`;
    }
    return match;
  });

  return { repaired, fixes };
}

function validateCypherSchema(cypher: string, dbId: string): string[] {
  const warnings: string[] = [];

  // Check node labels — extract (:LabelName) patterns (inside parentheses only)
  // This avoids false-matching relationship types like [:PLACED] or [:PART_OF]
  const labelMatches = cypher.match(/\(\s*\w*\s*:\s*([A-Z][a-zA-Z]+)/g) || [];
  for (const match of labelMatches) {
    const labelMatch = match.match(/:\s*([A-Z][a-zA-Z]+)/);
    const label = labelMatch?.[1];
    if (!label) continue;
    // Skip Neo4j built-in labels and type casts
    if (
      [
        "DISTINCT",
        "NOT",
        "NULL",
        "WHERE",
        "CASE",
        "WHEN",
        "THEN",
        "ELSE",
        "END",
        "AND",
        "OR",
        "DESC",
        "ASC",
        "WITH",
        "MATCH",
        "RETURN",
        "ORDER",
      ].includes(label)
    )
      continue;
    if (!getEffectiveNodeLabels(dbId).has(label)) {
      warnings.push(
        `Unknown node label "${label}" — valid labels: ${[...getEffectiveNodeLabels(dbId)].slice(0, 5).join(", ")}...`,
      );
    }
  }

  // Check relationship types — extract [:REL_TYPE] patterns
  const relMatches = cypher.match(/\[(?:\w+)?:\s*([A-Z_]+)\]/g) || [];
  for (const match of relMatches) {
    const rel = match.match(/:\s*([A-Z_]+)/)?.[1];
    if (rel && !getEffectiveRelationships(dbId).has(rel)) {
      warnings.push(
        `Unknown relationship type "${rel}" — valid types: ${[...getEffectiveRelationships(dbId)].slice(0, 5).join(", ")}...`,
      );
    }
  }

  // Check for sum/avg on string amount fields without toFloat()
  const unsafeAggPattern =
    /(?:sum|avg)\s*\(\s*(?!toFloat)\s*\w+\.\s*(?:totalNetAmount|netAmount|amountInTransactionCurrency|totalAmount)\s*\)/gi;
  if (unsafeAggPattern.test(cypher)) {
    warnings.push(
      "Amount field used in SUM/AVG without toFloat() — will produce string concatenation instead of arithmetic",
    );
  }

  return warnings;
}

// ── CYPHER REASONING EXTRACTOR ────────────────────────────────────────────────
// Parses LLM response that may contain both reasoning and cypher in JSON format.
interface CypherGenResult {
  cypher: string;
  reasoning: string | null;
}

function extractCypherFromResponse(responseText: string): CypherGenResult {
  // Attempt 1: Parse as structured JSON { reasoning, cypher }
  try {
    const parsed = JSON.parse(responseText) as {
      cypher?: string;
      reasoning?: string;
    };
    if (parsed.cypher) {
      return {
        cypher: parsed.cypher,
        reasoning: parsed.reasoning ?? null,
      };
    }
  } catch {
    // Not valid JSON — try fallback extraction
  }

  // Attempt 2: Extract JSON block from mixed response
  const jsonMatch = responseText.match(
    /\{[\s\S]*?"cypher"\s*:\s*"[\s\S]*?"\s*\}/,
  );
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        cypher?: string;
        reasoning?: string;
      };
      if (parsed.cypher) {
        return { cypher: parsed.cypher, reasoning: parsed.reasoning ?? null };
      }
    } catch {
      // JSON extraction failed
    }
  }

  // Attempt 3: Extract raw MATCH...RETURN from response text
  const cypherMatch = responseText.match(
    /MATCH[\s\S]+?(?:RETURN|LIMIT)[\s\S]*$/im,
  );
  if (cypherMatch) {
    return { cypher: cypherMatch[0], reasoning: null };
  }

  throw new Error("Could not extract Cypher from LLM response");
}

export async function hybridExecutor(
  state: O2CGraphState,
): Promise<Partial<O2CGraphState>> {
  // PATH A: Function execution
  if (state.pathTaken === "function" && state.selectedFunction) {
    const fn = FUNCTION_MAP[state.selectedFunction.name];
    if (fn) {
      try {
        const result = await fn(state.selectedFunction.params);
        if (result.records.length === 0 && state.retryCount < 3) {
          return {
            retryCount: state.retryCount + 1,
            queryError: "No results found",
          };
        }
        return {
          queryResults: result.records,
          confidence: "high",
          queryError: null,
        };
      } catch (err: unknown) {
        if (state.retryCount < 3) {
          return {
            retryCount: state.retryCount + 1,
            queryError:
              err instanceof Error ? err.message : "Function execution failed",
          };
        }
        return {
          answer:
            "I wasn't able to find reliable data for this. Try rephrasing with a specific ID or entity name.",
          confidence: "low",
        };
      }
    } else {
      // Function not found in FUNCTION_MAP (likely functionName is null).
      // Fall through to dynamic Cypher generation — mark path accordingly
      // so the contract verifier knows NOT to check field names.
      console.log(
        `  [Executor] Function "${state.selectedFunction.name}" not in FUNCTION_MAP — falling through to Cypher generation`,
      );
      state = { ...state, pathTaken: "template" };
    }
  }

  // PATH B & C: Template / Constrained Cypher generation with GraphRAG
  const isConstrained = state.pathTaken === "constrained";
  const isRetry = state.retryCount > 0;
  const retryNum = state.retryCount;

  // ── ESCALATING RETRY STRATEGY ──────────────────────────────────────────────
  // Each retry tries a FUNDAMENTALLY different approach:
  //   Attempt 0: Standard Cypher generation (Tier 2)
  //   Retry 1:   Force CoT reasoning + more examples + explicit error analysis
  //   Retry 2:   Escalate to Tier 3 (deepseek-reasoner) + simplified prompt
  //   Retry 3:   Query decomposition — break into sub-queries

  // Retry 3: Try query decomposition as last resort
  if (retryNum >= 3) {
    console.log(`  [Executor] Retry #3 — attempting query decomposition`);
    const { needsDecomposition: shouldDecompose, decomposeAndExecute } =
      await import("./queryDecomposer.js");

    try {
      const decomposition = await decomposeAndExecute(
        state.dbId,
        state.resolvedMessage,
        state.extractedEntities as Record<string, string>,
      );

      if (
        decomposition.wasDecomposed &&
        decomposition.mergedResults.length > 0
      ) {
        console.log(
          `  [Executor] Decomposition successful: ${decomposition.mergedResults.length} total results from ${decomposition.subQueries.length} sub-queries`,
        );
        return {
          queryResults: decomposition.mergedResults,
          confidence: "medium",
          queryError: null,
          executedCypher: decomposition.subQueries
            .map((sq) => sq.cypher)
            .join("\n---\n"),
        };
      }

      if (decomposition.errors.length > 0) {
        console.log(
          `  [Executor] Decomposition errors: ${decomposition.errors.join("; ")}`,
        );
      }
    } catch (err) {
      console.log(
        `  [Executor] Decomposition failed: ${(err as Error).message}`,
      );
    }

    return {
      answer:
        "I wasn't able to find reliable data for this question after trying multiple approaches. Try breaking your question into simpler parts, e.g., ask about orders and payments separately.",
      confidence: "low",
    };
  }

  // ── Determine tier and example count based on retry level ──
  // Retry 0: Tier 2, 5 examples
  // Retry 1: Tier 2 + CoT, 7 examples
  // Retry 2: Tier 3 (deepseek-reasoner), 7 examples + simplified approach
  const tier = retryNum >= 2 || isConstrained ? 3 : 2;
  const exampleCount = retryNum >= 1 ? 7 : 5;

  // ── GraphRAG: Retrieve similar examples + targeted schema ──
  const ragContext = await retrieveContext(
    state.dbId,
    state.resolvedMessage,
    exampleCount,
  );
  console.log(
    `  [GraphRAG] Using schema subset (${ragContext.matchedExamples.length} examples) instead of full 135-line schema`,
  );

  // ── BUILD SYSTEM PROMPT ──
  // Base instructions (always included)
  let systemPrompt = `You are a Neo4j Cypher query composer for a SAP Order-to-Cash (O2C) graph database.
Given a user question, write a precise Cypher query that answers it correctly.

CYPHER RULES:
- ALLOWED operations: MATCH, WHERE, WITH, OPTIONAL MATCH, RETURN, ORDER BY, LIMIT, UNWIND, CASE WHEN, count(), sum(), avg(), min(), max(), collect(), size(), DISTINCT
- FORBIDDEN operations: CREATE, DELETE, SET, MERGE, DROP, DETACH, CALL, LOAD CSV, FOREACH, window functions (OVER clause)
- Always add LIMIT (max 50) to prevent huge result sets
- For aggregation queries (COUNT, SUM, etc.) — put LIMIT AFTER the aggregation, NOT before
- Never use window functions like ROW_NUMBER() OVER or any OVER() clause — Neo4j does not support them
- ALWAYS alias returned columns with human-readable names: RETURN count(*) AS totalCount, NOT RETURN count(*)
- ALWAYS alias computed values: RETURN sum(toFloat(bh.totalNetAmount)) AS totalRevenue
- Use ORDER BY + LIMIT instead of window functions for ranking queries

FIELD TYPE HINTS (critical for correct Cypher):
- totalNetAmount, netAmount, amountInTransactionCurrency: These are STRING fields in Neo4j. You MUST use toFloat() before any arithmetic: sum(toFloat(x.totalNetAmount))
- businessPartnerIsBlocked, billingDocumentIsCancelled: These are BOOLEAN fields. Use = true or = false, NOT string comparison
- Date fields (creationDate, billingDocumentDate, clearingDate etc.): See detailed date handling rules in the RELEVANT SCHEMA section below.
- Customer ID links: Customer.id = SalesOrder.soldToParty = BillingHeader.soldToParty = Payment.customer
- There is NO direct relationship between Customer and BillingHeader — use property match: WHERE bh.soldToParty = c.id
- To join BillingHeader to Payment for clearing time: use Payment.accountingDocument = BillingHeader.accountingDocument
- DeliveryItem has NO material field. To get products: (SalesOrderItem)-[:FULFILLED_BY]->(DeliveryItem) then (SalesOrderItem)-[:REFERENCES]->(Product)
- REVENUE = active (non-cancelled) BillingHeader.totalNetAmount. NEVER use SalesOrder amounts for revenue
- For active (non-cancelled) billing: WHERE bh.billingDocumentIsCancelled = false OR bh.billingDocumentIsCancelled IS NULL

SIMILAR EXAMPLE QUERIES (adapt these patterns to the user's question):
${ragContext.fewShotExamples}

RELEVANT SCHEMA (ONLY use these node types and relationships):
${ragContext.schemaSubset}

${RELATIONSHIP_REFERENCE}`;

  // ── CHAIN-OF-THOUGHT — always on for retries, constrained queries ──
  if (isConstrained || isRetry) {
    systemPrompt += `

MANDATORY REASONING (you MUST answer these questions before writing Cypher):
Before writing your Cypher query, think step-by-step:
1. WHAT does the user want? (What entity types, what metric, what filter?)
2. WHICH nodes and relationships are needed? (List the traversal path)
3. WHERE are the gotchas? (String amounts needing toFloat? Missing direct relationships? Boolean filters?)
4. HOW should results be aggregated? (COUNT vs SUM vs collect? GROUP BY pattern?)
5. WHAT should be returned? (Column names that make sense for the user's question)

Include your reasoning in the JSON response.`;
  }

  // ── ESCALATING SELF-CORRECTION (different strategy per retry) ──
  if (retryNum === 1 && state.queryError) {
    // Retry 1: Detailed error analysis + forced different approach
    systemPrompt += `

⚠️ RETRY #1 — YOUR FIRST QUERY ATTEMPT FAILED:
Failed Cypher: ${state.executedCypher ?? "unknown"}
Error: ${state.queryError}

DIAGNOSE THE ROOT CAUSE:
- If "No results": You likely used wrong property names, wrong relationship direction, or a too-restrictive WHERE clause. Try OPTIONAL MATCH or looser filtering.
- If "Type mismatch": You forgot toFloat() on a string amount field.
- If "Unknown function": You used a window function (OVER). Replace with ORDER BY + LIMIT.
- If "Schema validation": You used a node label or relationship that doesn't exist. Check the RELEVANT SCHEMA above.

MANDATORY: You MUST write a FUNDAMENTALLY DIFFERENT query. Do NOT make minor tweaks to the same pattern. Change your entire approach:
- If you used a complex multi-hop join, try a simpler direct lookup
- If you used property filtering, try relationship-based traversal
- If you used an aggregation, try returning raw data first
- Consider using OPTIONAL MATCH instead of MATCH for potentially missing relationships`;
  } else if (retryNum === 2 && state.queryError) {
    // Retry 2: Simplified approach (escalated to Tier 3 deepseek-reasoner)
    systemPrompt += `

🔴 RETRY #2 (FINAL ATTEMPT) — BOTH PREVIOUS QUERIES FAILED:
Last failed Cypher: ${state.executedCypher ?? "unknown"}
Last error: ${state.queryError}

YOU ARE NOW USING THE MOST POWERFUL MODEL. Write the simplest possible Cypher that captures the core of the user's question:
1. Start with just 1-2 MATCH clauses (avoid deep joins)
2. Use OPTIONAL MATCH for anything that might not exist
3. Return only the most essential columns
4. Add explicit toFloat() on ALL numeric-looking properties
5. Use loose WHERE conditions

SIMPLIFY AGGRESSIVELY:
- If the question asks for "orders that were never delivered", just do:
  MATCH (so:SalesOrder) WHERE NOT EXISTS { MATCH (so)-[:HAS_ITEM]->(:SalesOrderItem)-[:FULFILLED_BY]->(:DeliveryItem) }
- If the question asks for "revenue by customer", just do:
  MATCH (bh:BillingHeader) WHERE bh.billingDocumentIsCancelled = false RETURN bh.soldToParty AS customer, sum(toFloat(bh.totalNetAmount)) AS revenue ORDER BY revenue DESC`;
  }

  // ── RESPONSE FORMAT ──
  systemPrompt += `

RESPONSE FORMAT — respond with ONLY valid JSON:
{
  "reasoning": "Step-by-step explanation of your query logic",
  "cypher": "MATCH (n:NodeType) WHERE ... RETURN ..."
}`;

  // ── CONVERSATION CONTEXT ──────────────────────────────────────────────────
  // Inject last 2 Q&A pairs so the LLM understands multi-turn context.
  // E.g., "What about their deliveries?" after asking about a customer.
  let conversationContext = "";
  if (state.history && state.history.length > 0) {
    const recentPairs = state.history.slice(-4); // last 2 Q&A pairs (4 messages)
    conversationContext = recentPairs
      .map(
        (m) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content.substring(0, 150)}`,
      )
      .join("\n");
  }

  const userPrompt = `${conversationContext ? `Recent conversation context:\n${conversationContext}\n\n` : ""}Question: "${state.resolvedMessage}"
Extracted entities: ${JSON.stringify(state.extractedEntities)}`;

  try {
    const response = await callLLM({
      systemPrompt,
      userPrompt,
      tier: tier as 1 | 2 | 3,
      maxTokens: isConstrained || isRetry ? 800 : 500,
      callerTag: `cypher-gen-t${tier}${isRetry ? "-retry" + retryNum : ""}`,
    });

    // ── EXTRACT CYPHER + REASONING ──
    const result = extractCypherFromResponse(response.text);

    // Log reasoning for audit trail
    if (result.reasoning) {
      console.log(
        `  [CypherGen] Reasoning: ${result.reasoning.substring(0, 200)}${result.reasoning.length > 200 ? "..." : ""}`,
      );
    }

    const validation = validateCypher(result.cypher);
    if (!validation.valid) {
      console.log(`  [Executor] Cypher BLOCKED: ${validation.reason}`);
      if (state.retryCount < 3) {
        return {
          retryCount: state.retryCount + 1,
          queryError: `Generated Cypher blocked: ${validation.reason}`,
          executedCypher: result.cypher,
        };
      }
      return {
        answer:
          "I wasn't able to generate a safe query for this question. Please try rephrasing.",
        confidence: "low",
      };
    }

    // ── AUTO-REPAIR common LLM mistakes ──
    const { repaired, fixes } = autoRepairCypher(result.cypher);
    if (fixes.length > 0) {
      console.log(
        `  [AutoRepair] Fixed ${fixes.length} relationship(s): ${fixes.join(", ")}`,
      );
      result.cypher = repaired;
    }

    // ── SCHEMA-AWARE VALIDATION ──
    const schemaIssues = validateCypherSchema(result.cypher, state.dbId);
    if (schemaIssues.length > 0 && state.retryCount < 3) {
      console.log(`  [Executor] Schema issues: ${schemaIssues.join("; ")}`);
      return {
        retryCount: state.retryCount + 1,
        queryError: `Schema validation issues: ${schemaIssues.join("; ")}. Fix these before running the query.`,
        executedCypher: result.cypher,
      };
    }

    // Layer 5: Enforce size limit
    result.cypher = enforceSizeLimit(result.cypher);

    console.log(
      `  [Executor] Generated Cypher (attempt ${retryNum}): ${result.cypher}`,
    );
    const records = await runQuery(result.cypher, {});

    if (records.length === 0 && state.retryCount < 3) {
      return {
        retryCount: state.retryCount + 1,
        queryError: `Query returned 0 results. The query was: ${result.cypher}`,
        executedCypher: result.cypher,
      };
    }

    return {
      queryResults: records,
      confidence: isConstrained ? "low" : "medium",
      queryError: null,
      usedFallback: response.usedFallback,
      executedCypher: result.cypher,
    };
  } catch (err: unknown) {
    if (state.retryCount < 3) {
      return {
        retryCount: state.retryCount + 1,
        queryError:
          err instanceof Error ? err.message : "Query generation failed",
      };
    }
    return {
      answer:
        "I wasn't able to find reliable data for this. Try rephrasing with a specific ID or entity name.",
      confidence: "low",
    };
  }
}
