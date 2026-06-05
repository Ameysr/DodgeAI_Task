import type { O2CGraphState } from "../state.js";
import { callLLM } from "../../services/llm.js";
import { saveHistory, saveEntities } from "../../services/memory.js";
import { saveToCache } from "../../services/semanticCache.js";
import { log } from "../../services/logger.js";
import type { Confidence, ObservabilityLog } from "../../types/index.js";

// ── DETERMINISTIC ANSWER TEMPLATES ─────────────────────────────────────────────
// For known functions, produce answers WITHOUT LLM involvement.
// This eliminates hallucinated numbers, wrong field interpretations, and formatting errors.
const DETERMINISTIC_TEMPLATES: Record<
  string,
  (results: Record<string, unknown>[], question: string) => string
> = {
  getActiveBillingTotals: (results) => {
    const r = results[0] ?? {};
    return `**${r.activeDocs ?? 0}** out of **${r.totalDocs ?? 0}** billing documents are active (non-cancelled), representing **${r.activePercentage ?? 0}%** of all billing docs.\n\nThe combined total net amount from active billing documents is **${r.currency ?? "INR"} ${r.activeTotalNetAmount != null ? Number(r.activeTotalNetAmount).toLocaleString() : "N/A"}**.`;
  },
  getShippingPointBreakdown: (results) => {
    if (!results.length) return "No shipping point data found.";
    const total = results.reduce((s, r) => s + Number(r.deliveryCount ?? 0), 0);
    const lines = results.map(
      (r, i) =>
        `${i + 1}. **${r.shippingPoint}**: ${r.deliveryCount} deliveries`,
    );
    return `**Shipping Points Breakdown** (${results.length} unique shipping point${results.length > 1 ? "s" : ""}, ${total} total deliveries)\n\n${lines.join("\n")}`;
  },
  getMaterialsNeverDelivered: (results) => {
    const r = results[0] ?? {};
    const sample = Array.isArray(r.sampleNeverDelivered)
      ? (r.sampleNeverDelivered as string[]).join(", ")
      : "N/A";
    return `**Materials Ordered vs Delivered**\n\n- **Unique materials ordered**: ${r.totalMaterialsOrdered ?? 0}\n- **Unique materials delivered**: ${r.totalMaterialsDelivered ?? 0}\n- **Materials never delivered**: ${r.neverDeliveredCount ?? 0}\n- **Sample never-delivered material IDs**: ${sample}`;
  },
  getSalesOrderValueByChannel: (results) => {
    if (!results.length) return "No distribution channel data found.";
    const lines = results.map(
      (r) =>
        `- **Channel ${r.channel}** (${r.orderCount} orders): Avg INR ${Number(r.avgValue).toLocaleString()} | Min INR ${Number(r.minValue).toLocaleString()} | Max INR ${Number(r.maxValue).toLocaleString()} | Total INR ${Number(r.totalValue).toLocaleString()}`,
    );
    return `**Sales Order Value by Distribution Channel**\n\n${lines.join("\n")}`;
  },
  getBillingDocsByCreationDate: (results) => {
    if (!results.length) return "No billing document creation date data found.";
    const lines = results.map(
      (r) =>
        `- **${r.creationDate}**: ${r.totalDocs} total (${r.cancelledDocs} cancelled, ${r.activeDocs} active) | Active net: ${r.currency ?? "INR"} ${Number(r.activeNetAmount ?? 0).toLocaleString()}`,
    );
    const grandTotal = results.reduce(
      (s, r) => s + Number(r.totalDocs ?? 0),
      0,
    );
    return `**Billing Documents by Creation Date** (${grandTotal} total across ${results.length} date${results.length > 1 ? "s" : ""})\n\n${lines.join("\n")}`;
  },
  getTopActiveBillingMonthRevenue: (results) => {
    const r = results[0] ?? {};
    return `The month with the highest active (non-cancelled) billing revenue is **${r.month ?? "N/A"}** with **${r.currency ?? "INR"} ${r.activeRevenueAmount != null ? Number(r.activeRevenueAmount).toLocaleString() : "N/A"}**.\n\nThis represents **${r.activeRevenuePercentage ?? 0}%** of the total active billing revenue of **${r.currency ?? "INR"} ${r.activeRevenueTotal != null ? Number(r.activeRevenueTotal).toLocaleString() : "N/A"}**.`;
  },
  getO2CHealthSummary: (results) => {
    const r = results[0] ?? {};
    return `**O2C Pipeline Health Summary**\n\n- **Sales Orders**: ${r.totalOrders ?? 0}\n- **Deliveries**: ${r.totalDeliveries ?? 0}\n- **Active Invoices**: ${r.totalInvoices ?? 0}\n- **Total Billed**: INR ${r.totalBilled != null ? Number(r.totalBilled).toLocaleString() : "N/A"}\n- **Payments**: ${r.totalPayments ?? 0}\n- **Total Collected**: INR ${r.totalCollected != null ? Number(r.totalCollected).toLocaleString() : "N/A"}`;
  },
  getDeliveryFulfillmentRate: (results) => {
    const lines = results.slice(0, 20).map((r, i) => {
      return `${i + 1}. **${r.customerName || r.customer}** (${r.customerId}): ${r.deliveredItems}/${r.totalItems} items delivered — **${r.fulfillmentRate}%** fulfillment rate`;
    });
    return `**Delivery Fulfillment Rate by Customer** (${results.length} customers)\n\n${lines.join("\n")}`;
  },
  getRevenueConcentration: (results) => {
    const lines = results.slice(0, 15).map((r, i) => {
      const name = r.customerName || r.customer || r.customerId;
      const rev = Number(r.customerRevenue || r.revenue);
      const pct = r.percentageShare || r.percentage;
      return `${i + 1}. **${name}**: ${r.currency || "INR"} ${rev.toLocaleString()} (**${pct}%**)`;
    });
    return `**Revenue Concentration by Customer**\n\n${lines.join("\n")}`;
  },
  getPlantRevenueRanking: (results) => {
    const lines = results.map((r, i) => {
      return `${i + 1}. **${r.plantName}** (${r.plantId}): ${r.currency} ${Number(r.totalBilledRevenue).toLocaleString()} — ${r.billingDocCount} billing docs, ${r.deliveryItemCount} delivery items`;
    });
    return `**Plant Revenue Ranking**\n\n${lines.join("\n")}`;
  },
  getARAgingBuckets: (results) => {
    const lines = results.slice(0, 15).map((r, i) => {
      return `${i + 1}. **${r.customer}** (${r.customerId}): 0-30d: INR ${Number(r.aging_0_30).toLocaleString()} | 31-60d: INR ${Number(r.aging_31_60).toLocaleString()} | 61-90d: INR ${Number(r.aging_61_90).toLocaleString()} | 90+d: INR ${Number(r.aging_90plus).toLocaleString()}`;
    });
    return `**AR Aging Buckets** (${results.length} customers with unpaid invoices)\n\n${lines.join("\n")}`;
  },
  getDSOPerCustomer: (results) => {
    const lines = results.slice(0, 15).map((r, i) => {
      return `${i + 1}. **${r.customer}** (${r.customerId}): **${r.avgDSO_days} days** avg DSO (${r.paidInvoices} paid invoices)`;
    });
    return `**Days Sales Outstanding (DSO) by Customer**\n\n${lines.join("\n")}`;
  },
  getCreditExposure: (results) => {
    const lines = results.slice(0, 15).map((r, i) => {
      return `${i + 1}. **${r.customer}** (${r.customerId}): INR ${Number(r.totalExposure).toLocaleString()} outstanding (${r.unpaidDocs} unpaid invoices)`;
    });
    return `**Open Credit Exposure by Customer**\n\n${lines.join("\n")}`;
  },
  getUnpaidActiveBillingDocs: (results) => {
    if (results.length === 1 && results[0].unpaidCount !== undefined) {
      const r = results[0];
      return `**${r.unpaidCount}** active (non-cancelled) billing documents have NOT been paid.\n\n**Total outstanding amount**: ${r.currency} ${Number(r.totalOutstandingAmount).toLocaleString()}`;
    }
    const lines = results.slice(0, 15).map((r, i) => {
      return `${i + 1}. **${r.customerName}** (${r.customerId}): ${r.unpaidDocCount} docs — ${r.currency} ${Number(r.outstandingAmount).toLocaleString()} outstanding`;
    });
    return `**Unpaid Active Billing Documents** (${results.length} customers)\n\n${lines.join("\n")}`;
  },
  getBillingDocTypeBreakdown: (results) => {
    const lines = results.map((r) => {
      return `- **${r.docType || r.billingDocumentType}**: ${r.totalCount || r.totalDocs} total, ${r.cancelledCount} cancelled, Net Amount: ${r.currency || "INR"} ${Number(r.totalNetAmount).toLocaleString()}`;
    });
    return `**Billing Document Type Breakdown**\n\n${lines.join("\n")}`;
  },
  getCancellationRateByCustomer: (results) => {
    const lines = results.slice(0, 15).map((r, i) => {
      return `${i + 1}. **${r.customer}** (${r.customerId}): ${r.cancelledDocs}/${r.totalDocs} cancelled — **${r.cancellationRate}%** rate`;
    });
    return `**Cancellation Rate by Customer**\n\n${lines.join("\n")}`;
  },
  getBlockedCustomersWithOrders: (results) => {
    if (results.length === 0)
      return "No blocked customers with active orders found.";
    const lines = results.map((r, i) => {
      return `${i + 1}. **${r.customer}** (${r.customerId}): ${r.orderCount} orders, total value: INR ${Number(r.totalValue).toLocaleString()}`;
    });
    return `**Blocked Customers with Active Orders** (${results.length} found)\n\n${lines.join("\n")}`;
  },
  getArchivingVsBlockedAnalysis: (results) => {
    const r = results[0] ?? {};
    const neither = Array.isArray(r.customersWithNeither)
      ? (r.customersWithNeither as string[]).join(", ")
      : "N/A";
    return `**Business Partner Status Analysis** (${r.totalCustomers ?? 0} total customers)\n\n- **Marked for archiving**: ${r.archivedCount ?? 0} of ${r.totalCustomers ?? 0}\n- **Blocked**: ${r.blockedCount ?? 0} of ${r.totalCustomers ?? 0}\n- **Both archived AND blocked**: ${r.bothCount ?? 0}\n- **Neither archived nor blocked**: ${r.neitherCount ?? 0}${neither !== "N/A" && neither ? ` (${neither})` : ""}`;
  },
  getDebitCreditTotals: (results) => {
    const r = results[0] ?? {};
    return `**Journal Entry Summary**\n\n- **Total Debits**: INR ${Number(r.totalDebits).toLocaleString()}\n- **Total Credits**: INR ${Number(r.totalCredits).toLocaleString()}\n- **Net Balance**: INR ${Number(r.netBalance).toLocaleString()}\n- **Total Entries**: ${r.totalEntries}`;
  },
  getOrderValueDistribution: (results) => {
    const r = results[0] ?? {};
    return `**Sales Order Value Distribution**\n\n- **Total Orders**: ${r.orderCount}\n- **Min Value**: INR ${Number(r.minValue).toLocaleString()}\n- **Max Value**: INR ${Number(r.maxValue).toLocaleString()}\n- **Average Value**: INR ${Number(r.avgValue).toLocaleString()}\n- **Total Value**: INR ${Number(r.totalValue).toLocaleString()}`;
  },
  getDeliveryStatusBreakdown: (results) => {
    const lines = results.map((r) => {
      return `- **${r.status || "(empty)"}**: ${r.orderCount} orders`;
    });
    return `**Delivery Status Breakdown**\n\n${lines.join("\n")}`;
  },
  getSoLineItemStats: (results) => {
    const r = results[0] ?? {};
    return `**Sales Order Line Item Statistics**\n\n- **Total line items**: ${r.totalLineItems}\n- **Total orders**: ${r.totalOrders}\n- **Average items per order**: ${r.avgItemsPerOrder}\n- **Minimum items per order**: ${r.minItemsPerOrder}\n- **Maximum items per order**: ${r.maxItemsPerOrder}`;
  },
  getAllCustomersWithOrderCounts: (results) => {
    const lines = results.map((r, i) => {
      return `${i + 1}. **${r.customerName}** (${r.customerId}): **${r.orderCount}** orders`;
    });
    return `**Customer Order Volume Ranking** (${results.length} customers)\n\n${lines.join("\n")}`;
  },
  getMaterialGroupsAnalysis: (results) => {
    const lines = results.map((r) => {
      return `- **${r.materialGroup}**: ${r.lineItemCount} line items, ${r.totalQuantity} total quantity, INR ${Number(r.totalNetAmount).toLocaleString()} net amount`;
    });
    return `**Material Group Breakdown** (${results.length} groups)\n\n${lines.join("\n")}`;
  },
  getUniqueMaterialsOrderedVsBilled: (results) => {
    const r = results[0] ?? {};
    const neverBilled = Array.isArray(r.neverBilledSample)
      ? r.neverBilledSample.slice(0, 10).join(", ")
      : "";
    return `**Materials Ordered vs Billed**\n\n- **Unique materials ordered**: ${r.uniqueMaterialsOrdered}\n- **Unique materials billed**: ${r.uniqueMaterialsBilled}\n- **Materials never billed**: ${r.materialsNeverBilled}\n\n${neverBilled ? `Sample never-billed material IDs: ${neverBilled}` : ""}`;
  },
  getDeliveryCompletionPerCustomer: (results) => {
    const zeroDelivery = results.filter(
      (r) => Number(r.deliveryCompletionPct) === 0,
    );
    const lines = results.map((r) => {
      const valueStr =
        Number(r.undeliveredOrderValue) > 0
          ? ` | Undelivered value: ${r.currency} ${Number(r.undeliveredOrderValue).toLocaleString()}`
          : "";
      return `- **${r.customerName}** (${r.customerId}): ${r.fullyDelivered}/${r.totalOrders} orders delivered — **${r.deliveryCompletionPct}%**${valueStr}`;
    });
    let answer = `**Delivery Completion Rate Per Customer** (${results.length} customers)\n\n${lines.join("\n")}`;
    if (zeroDelivery.length > 0) {
      const names = zeroDelivery
        .map(
          (r) =>
            `**${r.customerName}** (${r.currency} ${Number(r.undeliveredOrderValue).toLocaleString()})`,
        )
        .join(", ");
      const totalUndelivered = zeroDelivery.reduce(
        (sum, r) => sum + Number(r.undeliveredOrderValue),
        0,
      );
      const currency = zeroDelivery[0]?.currency ?? "INR";
      answer += `\n\n⚠️ **Customers with 0% delivery completion**: ${names}\n- **Total undelivered order value**: ${currency} ${totalUndelivered.toLocaleString()}`;
    }
    return answer;
  },
  getTopMaterialsByBilledQuantity: (results) => {
    const lines = results.map((r, i) => {
      return `${i + 1}. **${r.productName}** (${r.materialId}): qty **${r.totalBilledQuantity}**, ${r.currency} ${Number(r.totalBilledNetAmount).toLocaleString()} net`;
    });
    return `**Top Materials by Billed Quantity** (${results.length} shown)\n\n${lines.join("\n")}`;
  },
  getSalesOrderWithMostLineItems: (results) => {
    const r = results[0] ?? {};
    return `**Sales Order with Most Line Items**\n\n- **Order ID**: ${r.salesOrder}\n- **Item count**: ${r.itemCount}\n- **Total value**: ${r.currency} ${Number(r.totalValue).toLocaleString()}\n- **Delivery status**: ${r.deliveryStatus === "C" ? "Fully Delivered (C)" : r.deliveryStatus === "A" ? "Not Delivered (A)" : r.deliveryStatus}\n- **Customer**: ${r.customerName} (${r.customerId})`;
  },
  getPaymentCollectionRate: (results) => {
    const r = results[0] ?? {};
    return `**Payment Collection Rate**\n\n- **Total active billing value**: ${r.currency} ${Number(r.totalActiveBilled).toLocaleString()}\n- **Total collected (paid invoices)**: ${r.currency} ${Number(r.totalCollected).toLocaleString()}\n- **Outstanding**: ${r.currency} ${Number(r.outstanding).toLocaleString()}\n- **Collection rate**: **${r.collectionPct}%**`;
  },
  getO2CGraphSchemaDesign: (results) => {
    const r = results[0] ?? {};
    const nodes = Array.isArray(r.nodes)
      ? (r.nodes as Record<string, unknown>[])
      : [];
    const rels = Array.isArray(r.relationships)
      ? (r.relationships as Record<string, unknown>[])
      : [];

    const nodeLines = nodes.map((n, i) => {
      // Filter out 'id' — every node has it as the primary key, listing it is redundant
      const allProps = Array.isArray(n.keyProps)
        ? (n.keyProps as string[])
        : [];
      const businessProps = allProps.filter((p) => p !== "id");
      const propsStr =
        businessProps.length > 0
          ? businessProps.map((p) => `\`${p}\``).join(", ")
          : "_(none)_";
      return `${i + 1}. **${n.label}** — ${propsStr}`;
    });

    const relLines = rels.map((rel) => {
      return `- (**${rel.from}**) -[:${rel.type}]→ (**${rel.to}**) — ${rel.cardinality}`;
    });

    let answer = `The SAP Order-to-Cash dataset contains **${nodes.length} distinct entity types (node types)**.  \nAll nodes share a common primary key: \`id\`.\n\n`;
    answer += `**Node Types & Business Properties:**\n${nodeLines.join("\n")}\n\n`;
    answer += `**Relationships (${rels.length} edge types):**\n${relLines.join("\n")}`;

    if (r.edgePropertyNote) {
      answer += `\n\n**Note:** ${r.edgePropertyNote}`;
    }

    return answer;
  },
  getEntityTypesSummary: (results) => {
    const r = results[0] ?? {};
    const types = Array.isArray(r.entityTypes)
      ? (r.entityTypes as string[])
      : [];
    const lines = types.map((t, i) => `${i + 1}. **${t}**`);
    return `The SAP O2C graph contains **${r.entityTypeCount ?? types.length} distinct entity types**.\n\n${lines.join("\n")}`;
  },
};

// ── RESULT SANITIZATION ────────────────────────────────────────────────────────
// Dedup, remove all-null rows, and validate data quality before answering.
function sanitizeResults(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped = records.filter((r) => {
    const key = JSON.stringify(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Remove all-null/undefined rows
  const meaningful = deduped.filter((r) =>
    Object.values(r).some((v) => v !== null && v !== undefined && v !== ""),
  );

  return meaningful;
}

// ── POST-LLM ANSWER VALIDATION ────────────────────────────────────────────────
// Cross-check the LLM's answer against the actual data to catch hallucinations.
function validateLLMAnswer(
  answer: string,
  results: Record<string, unknown>[],
  functionName: string,
): { answer: string; issues: string[] } {
  const issues: string[] = [];
  const totalRecords = results.length;

  // Check 1: Record count mentioned in answer matches actual
  const countMatches = answer.match(
    /\b(\d+)\s+(record|result|row|customer|order|invoice|document|item|billing|delivery|payment|plant|product)/gi,
  );
  if (countMatches) {
    for (const match of countMatches) {
      const num = parseInt(match.match(/\d+/)?.[0] ?? "0", 10);
      // If the LLM says a count that's way off from actual results
      if (
        num > 0 &&
        totalRecords > 0 &&
        Math.abs(num - totalRecords) > totalRecords * 0.2 &&
        num !== totalRecords
      ) {
        // Only flag if it looks like the LLM is counting records (not data values)
        if (/record|result|row/.test(match.toLowerCase())) {
          issues.push(
            `Answer mentions ${num} records but actual count is ${totalRecords}`,
          );
        }
      }
    }
  }

  // Check 2: Key numeric values from first row appear in answer
  if (results.length > 0) {
    const firstRow = results[0];
    for (const [key, value] of Object.entries(firstRow)) {
      if (typeof value === "number" && value > 1000) {
        // Check that large numbers aren't wildly misrepresented
        const valStr = String(Math.round(value));
        const formattedVal = value.toLocaleString();
        // If neither the raw number nor formatted version appears, flag it
        if (
          !answer.includes(valStr) &&
          !answer.includes(formattedVal) &&
          !answer.includes(String(value))
        ) {
          // Only flag for important-looking fields
          if (/(amount|revenue|total|balance|exposure|value)/i.test(key)) {
            issues.push(`Key value ${key}=${value} not found in answer`);
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    console.log(`  [AnswerValidator] Issues detected: ${issues.join("; ")}`);
  }

  return { answer, issues };
}

export async function answerFormatter(
  state: O2CGraphState,
): Promise<Partial<O2CGraphState>> {
  // If answer is already set (guardrail rejection or retry exhaustion), skip
  if (state.answer) {
    const latencyMs = Date.now() - state.startTime;
    await logObservability(state, latencyMs);
    return { latencyMs };
  }

  // If no query results, return context-aware fallback
  if (!state.queryResults || state.queryResults.length === 0) {
    const msg = state.resolvedMessage.toLowerCase();
    let answer: string;

    if (
      /today|yesterday|this week|this month|last month|last week/i.test(msg)
    ) {
      const today = new Date().toISOString().slice(0, 10);
      answer = `No matching records found for the requested time period (searched as of ${today}). The dataset may not contain data for this date range — the SAP O2C data primarily covers April 2025. Try asking about a specific date range, e.g., "deliveries in April 2025."`;
    } else if (Object.keys(state.extractedEntities).length > 0) {
      const entityStr = Object.entries(state.extractedEntities)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      answer = `No matching records found for ${entityStr}. Please verify the ID exists in the system, or try a different identifier.`;
    } else {
      answer = `No matching records found for this query. The question may require data that isn't in the current dataset, or the search criteria may be too specific. Try broadening your question or using a known entity ID.`;
    }

    const latencyMs = Date.now() - state.startTime;
    await logObservability(state, latencyMs);
    return { answer, confidence: "low", latencyMs, nodesReferenced: [] };
  }

  // ── SANITIZE RESULTS ──────────────────────────────────────────────────────
  const sanitized = sanitizeResults(
    state.queryResults as Record<string, unknown>[],
  );
  const totalRecordCount = sanitized.length;

  const selectedFunctionName = state.selectedFunction?.name ?? "";
  const routingTrace = state.routingTrace;

  // ── DETERMINISTIC TEMPLATE PATH ─────────────────────────────────────────────
  // If we have a template for this function, use it DIRECTLY — zero LLM involvement.
  // This eliminates hallucination, wrong number formatting, and field misinterpretation.
  const templateFn = DETERMINISTIC_TEMPLATES[selectedFunctionName];
  if (templateFn && state.pathTaken === "function") {
    try {
      const answer = templateFn(sanitized, state.resolvedMessage);
      const nodesReferenced = extractNodeReferences(sanitized);
      const latencyMs = Date.now() - state.startTime;

      console.log(
        `  [AnswerFormatter] DETERMINISTIC template used for ${selectedFunctionName} — 0 LLM calls`,
      );

      await logObservability(state, latencyMs);

      // Save to memory and cache
      try {
        await Promise.all([
          saveHistory(state.sessionId, state.userMessage, answer, state.dbId),
          state.extractedEntities &&
          Object.keys(state.extractedEntities).length > 0
            ? saveEntities(state.sessionId, state.extractedEntities, state.dbId)
            : Promise.resolve(),
          saveToCache(state.userMessage, answer, state.dbId),
        ]);
      } catch {
        /* Non-critical */
      }

      return {
        answer,
        nodesReferenced,
        confidence: "high",
        latencyMs,
        usedFallback: false,
      };
    } catch (err) {
      console.log(
        `  [AnswerFormatter] Template failed for ${selectedFunctionName}, falling back to LLM: ${(err as Error).message}`,
      );
      // Fall through to LLM path
    }
  }

  // ── CONTRACT ANSWER TEMPLATE PATH ───────────────────────────────────────────
  // If the plan has an answerTemplate in its contract, it was already applied
  // in index.ts. This is a safety net.

  // ── LLM ANSWER GENERATION PATH ──────────────────────────────────────────────
  const contractVerified = routingTrace?.contractVerified ?? null;
  const contractReason = routingTrace?.contractReason ?? null;
  const plansTried = routingTrace?.plansTried ?? [];
  const activePlanId = routingTrace?.activePlanId ?? null;

  // Function-specific schema hints
  const FUNCTION_CONTEXT_HINTS: Record<string, string> = {
    getPlantRevenueRanking:
      "Plant revenue ranked by BillingHeader totals. Fields: plantId, plantName, totalBilledRevenue (INR currency), billingDocCount (count, NOT currency), deliveryItemCount (count, NOT currency), currency.",
    getActiveBillingTotals:
      "Active (non-cancelled) billing document summary. Fields: activeDocs, totalDocs, activePercentage (0-100), activeTotalNetAmount (INR currency), currency.",
    getTopActiveBillingMonthRevenue:
      "Top month by active billing revenue. Fields: month, activeRevenueAmount (INR currency), activeRevenuePercentage (0-100), activeRevenueTotal (INR currency), currency.",
    getRevenueConcentration:
      "Revenue concentration by customer. Fields: customer, customerId, revenue (INR currency), percentage (0-100), currency.",
    getDeliveryFulfillmentRate:
      "Delivery fulfillment rate per customer. Fields: customer, customerId, totalItems, deliveredItems, fulfillmentRate (0-100), orderIds.",
    getFullAnomalyReport:
      "Complete O2C anomaly report. Multiple anomaly categories with counts and details.",
    getEntityTypesSummary:
      "Graph entity type summary. Fields: entityTypeCount, entityTypes (list), excludedTypes.",
    getPaymentClearingTime:
      "Invoice-to-payment clearing duration. Fields: billingDocument, billingDate, clearingDate, daysToClear.",
    getJournalEntryDistribution:
      "Journal entries per customer. Fields: customer, totalEntries, positiveEntries, negativeEntries, netAmount.",
    getCustomerBillingSummary:
      "Customer billing profile. Fields: totalDocs, activeDocs, cancelledDocs, totalActiveAmount, paidDocs, unpaidDocs, unpaidAmount.",
    traceOrderJourney:
      "Full O2C journey for a sales order. Fields: salesOrderItem, product, deliveryDocument, billingDocument, paymentStatus.",
    getUnpaidActiveBillingDocs:
      "Unpaid active billing documents. Fields: unpaidCount, totalOutstandingAmount, currency, customerBreakdown.",
    getBillingDocTypeBreakdown:
      "Billing document type breakdown. Fields: billingDocumentType, totalCount, cancelledCount, totalNetAmount.",
    getARAgingBuckets:
      "AR aging buckets by customer. Fields: customer, customerId, aging_0_30, aging_31_60, aging_61_90, aging_90plus (all INR amounts).",
    getDSOPerCustomer:
      "Days Sales Outstanding per customer. Fields: customer, customerId, avgDSO_days (number of days, NOT currency), paidInvoices (count).",
    getCreditExposure:
      "Open credit exposure per customer. Fields: customer, customerId, totalExposure (INR currency), unpaidDocs (count).",
    getCancellationRateByCustomer:
      "Cancellation rate by customer. Fields: customer, customerId, totalDocs (count), cancelledDocs (count), cancellationRate (0-100 percentage).",
    getO2CHealthSummary:
      "O2C pipeline summary. Fields: totalOrders, totalDeliveries, totalInvoices (all counts), totalBilled, totalCollected (both INR currency), totalPayments (count).",
  };

  const functionHint = selectedFunctionName
    ? (FUNCTION_CONTEXT_HINTS[selectedFunctionName] ?? "")
    : "";

  const firstRow = sanitized[0] ?? {};
  const rowKeys = Object.keys(firstRow);
  const amountFields: string[] = (() => {
    if (selectedFunctionName === "getPlantRevenueRanking")
      return ["totalBilledRevenue"];
    if (selectedFunctionName === "getActiveBillingTotals")
      return ["activeTotalNetAmount"];
    if (selectedFunctionName === "getTopActiveBillingMonthRevenue")
      return ["activeRevenueAmount", "activeRevenueTotal"];
    if (selectedFunctionName === "getCreditExposure") return ["totalExposure"];
    if (selectedFunctionName === "getARAgingBuckets")
      return ["aging_0_30", "aging_31_60", "aging_61_90", "aging_90plus"];
    return rowKeys.filter((k) =>
      /(amount|revenue|netamount|totalnetamount|totalbilledrevenue|exposure|billedtotal|collected|billed)/i.test(
        k,
      ),
    );
  })();

  const amountFieldsStr =
    amountFields.length > 0 ? amountFields.join(", ") : "NONE_DETECTED";

  // Compact results for LLM
  const trimmedResults = sanitized.slice(0, 50);
  const compactResults = trimmedResults.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === null || v === undefined) continue;
      out[k] = v;
    }
    return out;
  });

  let resultsStr = JSON.stringify(compactResults);
  if (resultsStr.length > 4000) {
    resultsStr = resultsStr.substring(0, 4000) + "\n... (truncated)";
  }

  // ── RESULT VALIDATION ──
  const resultKeys = totalRecordCount > 0 ? Object.keys(sanitized[0]) : [];
  const question = state.resolvedMessage.toLowerCase();
  let validationWarning = "";

  if (question.includes("plant") && !resultKeys.some((k) => /plant/i.test(k))) {
    validationWarning =
      "\n⚠️ WARNING: The query results do NOT contain plant data. The query may have been incorrect.";
  }
  if (
    question.includes("product") &&
    !resultKeys.some((k) => /product|material/i.test(k))
  ) {
    validationWarning =
      "\n⚠️ WARNING: The query results do NOT contain product data. The query may have been incorrect.";
  }
  if (
    (question.includes("billing type") || question.includes("document type")) &&
    !resultKeys.some((k) => /type/i.test(k))
  ) {
    validationWarning =
      "\n⚠️ WARNING: The query results do NOT contain type data. The query may have been incorrect.";
  }
  if (totalRecordCount > 0) {
    const firstResult = sanitized[0];
    const allNullKeys = Object.entries(firstResult).filter(
      ([, v]) => v === null || v === undefined,
    );
    if (allNullKeys.length > Object.keys(firstResult).length / 2) {
      validationWarning =
        "\n⚠️ WARNING: Most fields in the results are NULL — the query may be using wrong property names.";
    }
  }

  const systemPrompt = `You are a business data analyst. Given raw Neo4j query results from a SAP Order-to-Cash graph,
write a clear, comprehensive natural language answer.

CONTEXT:
- Data source: ${state.pathTaken === "function" ? `Pre-built function "${selectedFunctionName}"` : "Dynamic Cypher query"}
- Result confidence: ${contractVerified === true ? "HIGH (contract verified)" : contractVerified === false ? "MEDIUM (unverified)" : "STANDARD"}
${functionHint ? `- Field guide: ${functionHint}` : ""}

CRITICAL RULES:
- The TOTAL record count is ${totalRecordCount}. ALWAYS use this number, do NOT count the sample records yourself.
- ALWAYS list entity names and IDs when available (customer names, order IDs, product names, etc.)
- Extract any node IDs (order numbers, billing docs, delivery IDs, customer IDs) and list them in nodesReferenced
- Use the productDescription field when available instead of raw material codes
- Format amounts with their currency (e.g. "INR 1,234.56")
- IMPORTANT: Do NOT invent, estimate, or recompute numbers. Use the EXACT numeric values from the query results as-is.
- If aggregating amounts, compute from ALL records shown, not just a subset
- Give a COMPLETE answer — include all relevant details from the data, don't just summarize counts
- If a validation warning is present, mention it transparently in your answer
- FORMATTING: Use clean Markdown for readability. Use **bold** for key labels and important values, numbered lists (1. 2. 3.) or bullet points (- item) for multiple data points, and separate sections with line breaks. Keep it concise but well-structured. Do NOT use headers (#). Do NOT use code blocks.
- Currency formatting scope:
  - Format amounts with currency ONLY for these fields: ${amountFieldsStr}
  - Do NOT format count fields (e.g. billingDocCount, deliveryItemCount, totalDocs, activeDocs, paidInvoices, orderCount) as currency. These are COUNTS, not money.
- Field-type guards:
  - Fields ending in "Count", "Docs", "Items", "Entries", "Orders" are COUNTS (plain integer, no currency symbol)
  - Fields ending in "Amount", "Revenue", "Total", "Value", "Exposure", "Balance" are CURRENCY amounts (format with INR)
  - Fields ending in "Rate", "Percentage", "Pct", "Share" are PERCENTAGES (format with % symbol)
  - Fields ending in "Days", "DSO" are DURATIONS (format as "X days")
YOU MUST RESPOND WITH ONLY VALID JSON. No markdown code fences, no explanation, no preamble.
EXACT FORMAT: { "answer": "your formatted answer using Markdown", "nodesReferenced": ["id1", "id2"] }
DO NOT wrap the JSON in a code block. DO NOT add any text before or after the JSON object.${validationWarning}`;

  const userPrompt = `User question: "${state.resolvedMessage}"
TOTAL records found: ${totalRecordCount}
Query results (showing ${trimmedResults.length} of ${totalRecordCount} records):
${resultsStr}
`;

  let answer = "";
  let nodesReferenced: string[] = [];
  let confidence: Confidence = state.confidence || "medium";
  let usedFallback = state.usedFallback;

  try {
    const response = await callLLM({
      systemPrompt,
      userPrompt,
      tier: 2,
      maxTokens: 1000,
      callerTag: "answer-formatter",
    });

    usedFallback = usedFallback || response.usedFallback;

    try {
      const parsed = JSON.parse(response.text) as {
        answer: string;
        nodesReferenced: string[];
      };
      answer = parsed.answer;
      nodesReferenced = parsed.nodesReferenced ?? [];
    } catch {
      // Retry once
      try {
        const retry = await callLLM({
          systemPrompt: systemPrompt + "\nRESPOND WITH ONLY VALID JSON.",
          userPrompt,
          tier: 2,
          maxTokens: 1000,
          callerTag: "answer-formatter-retry",
        });
        const parsed = JSON.parse(retry.text) as {
          answer: string;
          nodesReferenced: string[];
        };
        answer = parsed.answer;
        nodesReferenced = parsed.nodesReferenced ?? [];
        usedFallback = usedFallback || retry.usedFallback;
      } catch {
        // Fallback: use raw data summary
        answer = `Found ${trimmedResults.length} record(s). Here's the raw data: ${resultsStr.substring(0, 500)}`;
        nodesReferenced = [];
      }
    }
  } catch {
    answer = `Found ${trimmedResults.length} record(s) but couldn't format the answer. Try asking a simpler question.`;
    nodesReferenced = [];
  }

  // ── POST-LLM VALIDATION ──────────────────────────────────────────────────
  const validation = validateLLMAnswer(answer, sanitized, selectedFunctionName);
  answer = validation.answer;

  // Clean up: only strip headers (h1-h6) to keep markdown concise
  answer = answer
    .replace(/^#{1,6}\s+/gm, "") // strip headers — use bold instead
    .trim();

  // Append disclaimer for low confidence
  if (confidence === "low") {
    answer +=
      " (Note: this answer was dynamically generated — please verify against source data)";
  }

  // Bug #18 fix: Validation warning is already injected into the LLM prompt,
  // so the LLM will incorporate it in its answer. No need to append it again
  // (was causing duplicate warnings in the response).

  const latencyMs = Date.now() - state.startTime;

  // Save to memory and cache
  try {
    const shouldSemanticCache =
      state.answer &&
      state.queryResults?.length > 0 &&
      (routingTrace?.contractVerified === true ||
        routingTrace?.activePlanCritical === true);

    await Promise.all([
      saveHistory(state.sessionId, state.userMessage, answer, state.dbId),
      state.extractedEntities && Object.keys(state.extractedEntities).length > 0
        ? saveEntities(state.sessionId, state.extractedEntities, state.dbId)
        : Promise.resolve(),
      shouldSemanticCache
        ? saveToCache(state.userMessage, answer, state.dbId)
        : Promise.resolve(),
    ]);
  } catch {
    // Non-critical — continue
  }

  await logObservability(state, latencyMs);

  return {
    answer,
    nodesReferenced,
    confidence,
    latencyMs,
    usedFallback,
  };
}

// ── EXTRACT NODE REFERENCES FROM RESULTS ──────────────────────────────────────
function extractNodeReferences(results: Record<string, unknown>[]): string[] {
  const refs = new Set<string>();
  for (const row of results.slice(0, 20)) {
    for (const [key, value] of Object.entries(row)) {
      if (
        typeof value === "string" &&
        /id|document|order/i.test(key) &&
        /^\d{5,10}$/.test(value)
      ) {
        refs.add(value);
      }
    }
  }
  return Array.from(refs).slice(0, 20);
}

async function logObservability(
  state: O2CGraphState,
  latencyMs: number,
): Promise<void> {
  try {
    const logData: ObservabilityLog = {
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      cacheHit: false,
      tierUsed: state.tierToUse,
      intentType: state.intentType,
      functionCalled: state.selectedFunction?.name ?? "",
      pathTaken: state.pathTaken,
      retryCount: state.retryCount,
      latencyMs,
      recordsReturned: state.queryResults?.length ?? 0,
      confidence: state.confidence || "",
      usedFallback: state.usedFallback,
    };
    await log(logData);
  } catch {
    // Non-critical
  }
}
