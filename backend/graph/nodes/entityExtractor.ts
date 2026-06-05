import type { O2CGraphState } from "../state.js";
import type { EntityMap } from "../../types/index.js";
import { saveEntities } from "../../services/memory.js";

export async function entityExtractor(
  state: O2CGraphState,
): Promise<Partial<O2CGraphState>> {
  const msg = state.resolvedMessage;
  const extracted: EntityMap = {};

  // Extract entity IDs using regex patterns
  const patterns: Array<{
    regex: RegExp;
    type: string;
    processor?: (match: string) => string;
  }> = [
    // 8-digit starting with 80 → DeliveryHeader
    { regex: /\b(80\d{6})\b/g, type: "DeliveryHeader" },
    // 8-10 digit starting with 90 or 91 → BillingHeader
    { regex: /\b(9[01]\d{6,8})\b/g, type: "BillingHeader" },
    // Numbers near "order" keyword → SalesOrder
    { regex: /\b(7\d{5,7})\b/g, type: "SalesOrder" },
    // Numbers starting with 31 or 32 → Customer
    { regex: /\b(3[12]\d{4,7})\b/g, type: "Customer" },
    // S8 or B8 followed by digits → Product
    { regex: /\b([SB]8\d{10,12})\b/g, type: "Product" },
    // 4-character plant codes (all caps or with digits)
    { regex: /\b([A-Z]{2}\d{2})\b/g, type: "Plant" },
    { regex: /\b(\d{4})\b/g, type: "Plant" }, // will be filtered by context
  ];

  for (const { regex, type } of patterns) {
    const matches = msg.match(regex);
    if (matches && matches.length > 0) {
      // For Plant type with 4-digit pure numbers, only match if near "plant" keyword
      if (type === "Plant" && /^\d{4}$/.test(matches[0])) {
        if (!/plant/i.test(msg)) continue;
      }
      extracted[type] = matches[0];
    }
  }

  // Keyword-context disambiguation
  const lowerMsg = msg.toLowerCase();
  const numbers = msg.match(/\b(\d{6,10})\b/g);
  if (numbers) {
    for (const num of numbers) {
      if (lowerMsg.includes("customer") && !extracted.Customer) {
        if (/^3[12]\d{4,7}$/.test(num)) extracted.Customer = num;
      } else if (lowerMsg.includes("order") && !extracted.SalesOrder) {
        if (/^7\d{5,7}$/.test(num)) extracted.SalesOrder = num;
      } else if (lowerMsg.includes("delivery") && !extracted.DeliveryHeader) {
        if (/^80\d{6}$/.test(num)) extracted.DeliveryHeader = num;
      } else if (
        (lowerMsg.includes("billing") || lowerMsg.includes("invoice")) &&
        !extracted.BillingHeader
      ) {
        if (/^9[01]\d{6,8}$/.test(num)) extracted.BillingHeader = num;
      }
    }
  }

  // Save entities to Redis (last-wins per type)
  if (Object.keys(extracted).length > 0) {
    await saveEntities(state.sessionId, extracted, state.dbId);
  }

  return { extractedEntities: extracted };
}
