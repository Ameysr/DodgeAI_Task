import type { O2CGraphState } from "./state.js";
import { initialState } from "./state.js";
import { contextResolution } from "./nodes/contextResolution.js";
import { guardrail } from "./nodes/guardrail.js";
import { entityExtractor } from "./nodes/entityExtractor.js";
import { functionSelector } from "./nodes/functionSelector.js";
import { hybridExecutor } from "./nodes/hybridExecutor.js";
import { answerFormatter } from "./nodes/answerFormatter.js";
import { saveToCache } from "../services/semanticCache.js";
import { saveHistory, saveEntities } from "../services/memory.js";
import { getLLMStats } from "../services/llm.js";
import {
  getPlanCandidates,
  renderAnswerTemplate,
} from "../services/questionPlans.js";
import { verifyContract } from "../services/contractVerifier.js";
import type { EntityMap } from "../types/index.js";

// ── ENTITY → PARAM MAPPER ─────────────────────────────────────────────────────
// Maps extracted entity types to function parameter names.
// When a plan is locked, the static plan params are EMPTY — the extracted entities
// must be injected so functions like getOrdersPlacedByCustomer(customerId) receive the ID.
const ENTITY_TO_PARAM: Record<string, string> = {
  Customer: "customerId",
  SalesOrder: "orderId",
  Product: "productId",
  BillingHeader: "billingDocId",
  DeliveryHeader: "deliveryId",
  Plant: "plantId",
};

function mergeEntityParams(
  planParams: Record<string, unknown>,
  entities: EntityMap,
): Record<string, unknown> {
  const merged = { ...planParams };
  for (const [entityType, entityValue] of Object.entries(entities)) {
    if (entityValue && ENTITY_TO_PARAM[entityType]) {
      const paramName = ENTITY_TO_PARAM[entityType];
      // Only inject if not already set by the plan
      if (!merged[paramName]) {
        merged[paramName] = entityValue;
      }
    }
  }
  return merged;
}

// ── OPTIMIZED 6-NODE PIPELINE ─────────────────────────────────────────────────
// Replaces the old 8-node pipeline by merging:
//   - guardrail + intentClassifier + complexityClassifier -> single guardrail node
//   - plan routing now uses soft recommendation (similarity >= 0.55) before functionSelector
//
// Node [1] Context Resolution       (0 LLM)
// Node [2] Guard+Intent+Complexity  (0 or 1 LLM — one merged call)
// Node [3] Entity Extraction        (0 LLM)
// Node [4] Plan Router + Func Sel   (0 or 1 LLM — plan -> entity lookup -> LLM last)
// Node [5] Hybrid Executor          (0 or 1 LLM — function=0, GraphRAG cypher=1)
// Node [6] Answer Formatter         (0 or 1 LLM — template=0, LLM wording=1)

export async function runPipeline(
  userMessage: string,
  sessionId: string,
  dbId: string,
  history: import("../types/index.js").HistoryMessage[],
  entities: import("../types/index.js").EntityMap,
  startTime: number,
): Promise<O2CGraphState> {
  let state: O2CGraphState = {
    ...initialState,
    userMessage,
    sessionId,
    dbId,
    history,
    entities,
    startTime,
  };

  const routingTrace = {
    planCandidates: [] as Array<{
      id: string;
      functionName: string;
      critical?: boolean;
      similarity: number;
    }>,
    lockedPlanId: null as string | null,
    plansTried: [] as string[],
    activePlanId: null as string | null,
    activePlanCritical: null as boolean | null,
    contractVerified: null as boolean | null,
    contractReason: null as string | null,
    executorPath: null as string | null,
  };
  state = { ...state, routingTrace };

  const llmBefore = getLLMStats();
  console.log(`\n━━━ PIPELINE START (6-node optimized) ━━━`);
  console.log(`  Question: "${userMessage}"`);

  // ── Node 1: Context Resolution (0 LLM) ──
  state = { ...state, ...(await contextResolution(state)) };
  console.log(`  [1] Context -> Resolved: "${state.resolvedMessage}"`);

  // ── Node 2: MERGED Guardrail + Intent + Complexity (0 or 1 LLM) ──
  // This single node replaces old nodes 2, 4, and 5.
  state = { ...state, ...(await guardrail(state)) };
  console.log(
    `  [2] Guard+Intent+Complex -> Relevant: ${state.isRelevant} | Intent: ${state.intentType} | Complexity: ${state.complexity} | Tier: ${state.tierToUse}`,
  );
  if (state.isRelevant === false) {
    state = { ...state, ...(await answerFormatter(state)) };
    console.log(`  x Rejected — pipeline ended early`);
    return state;
  }

  // ── Node 3: Entity Extraction (0 LLM — pure regex) ──
  state = { ...state, ...(await entityExtractor(state)) };
  console.log(`  [3] Entities -> ${JSON.stringify(state.extractedEntities)}`);

  // ── Node 4: Plan Routing + Function Selection ──
  // Declare these at the outer scope so contract verification can reference them.
  let planCandidates: import("../services/questionPlans.js").PlanCandidate[] =
    [];
  let planIndex = 0;

  // ── SCHEMA PATH: Skip plan routing entirely for conceptual/schema questions ──
  // Schema questions ("What edge connects X to Y?", "How to model X in graph?")
  // must NOT go through plan routing — they get false positive matches because
  // words like "SalesOrder", "customer", "relationship" appear in data query plans too.
  if (state.pathTaken === "schema") {
    // Distinguish: is this about schema structure or about how the NL system works?
    const isMetaSystem =
      /how does (your|the|this) (system|nl|natural language|pipeline)/i.test(
        state.resolvedMessage,
      ) ||
      (/translate/i.test(state.resolvedMessage) &&
        /graph query|cypher/i.test(state.resolvedMessage));

    if (isMetaSystem) {
      // Extract the mentioned sub-query from quoted text (if any)
      const quotedMatch = state.resolvedMessage.match(/['"]([^'"]+)['"]/);
      const mentionedQuery = quotedMatch ? quotedMatch[1] : undefined;
      const entitiesJson =
        Object.keys(state.extractedEntities).length > 0
          ? JSON.stringify(state.extractedEntities)
          : undefined;
      console.log(
        `  [4] META-SYSTEM path — using getSystemPipelineDescription`,
      );
      state = {
        ...state,
        selectedFunction: {
          name: "getSystemPipelineDescription",
          params: {
            mentionedQuery: mentionedQuery ?? "",
            entities: entitiesJson ?? "",
          },
        },
        pathTaken: "function",
      };
    } else {
      console.log(
        `  [4] SCHEMA path — bypassing plan routing, using getO2CGraphSchemaDesign`,
      );
      state = {
        ...state,
        selectedFunction: { name: "getO2CGraphSchemaDesign", params: {} },
        pathTaken: "function",
      };
    }
  } else {
    // Step 4a: Plan similarity check (question_plans.json)
    const planResult = await getPlanCandidates(
      state.resolvedMessage,
      undefined,
    );
    planCandidates = planResult.candidates;
    const minSimilarity = planResult.minSimilarity;
    planIndex = 0;
    const topCandidate = planCandidates[0];

    routingTrace.planCandidates = planCandidates.map((c) => ({
      id: c.plan.id,
      functionName: c.plan.functionName,
      critical: c.plan.critical,
      similarity: c.similarity,
    }));

    const shouldLockCriticalPlan =
      !!topCandidate?.plan.critical &&
      topCandidate.similarity >= (minSimilarity ?? 0.85);

    // Soft recommendation threshold: raised to 0.88 to prevent false positive
    // plan matches. Scores of 0.81-0.83 were hitting completely wrong functions
    // (e.g. "shipping points" → getBillingDocTypeBreakdown at 0.832).
    // Below 0.88, fall through to functionSelector + LLM/dynamic Cypher.
    const SOFT_RECOMMENDATION_THRESHOLD = 0.88;
    const shouldSoftRecommend =
      !shouldLockCriticalPlan &&
      topCandidate &&
      topCandidate.plan.functionName &&
      topCandidate.similarity >= SOFT_RECOMMENDATION_THRESHOLD;

    if (shouldLockCriticalPlan) {
      // Hard lock: critical plan above threshold — bypass function selector entirely
      const plan = topCandidate.plan;
      // CRITICAL: Merge extracted entities into function params.
      // Plan params from question_plans.json are static (often empty).
      // Entity IDs extracted in Node 3 must be injected here.
      const mergedParams = mergeEntityParams(
        plan.params ?? {},
        state.extractedEntities,
      );
      state = {
        ...state,
        selectedFunction: { name: plan.functionName, params: mergedParams },
        pathTaken: "function",
      };
      routingTrace.lockedPlanId = plan.id;
      routingTrace.activePlanId = plan.id;
      routingTrace.activePlanCritical = true;
      routingTrace.plansTried.push(plan.id);
      console.log(
        `  [4] Plan LOCKED -> ${plan.id} -> Function: ${plan.functionName} (similarity: ${topCandidate.similarity.toFixed(3)})`,
      );
    } else if (shouldSoftRecommend) {
      // Soft recommendation: plan is relevant but not critical — use its function
      const plan = topCandidate.plan;
      const mergedParams = mergeEntityParams(
        plan.params ?? {},
        state.extractedEntities,
      );
      state = {
        ...state,
        selectedFunction: { name: plan.functionName, params: mergedParams },
        pathTaken: "function",
      };
      routingTrace.activePlanId = plan.id;
      routingTrace.activePlanCritical = !!plan.critical;
      routingTrace.plansTried.push(plan.id);
      console.log(
        `  [4] Plan SOFT -> ${plan.id} -> Function: ${plan.functionName} (similarity: ${topCandidate.similarity.toFixed(3)})`,
      );
    } else {
      // Step 4b: Entity lookups + LLM fallback (functionSelector)
      state = { ...state, ...(await functionSelector(state)) };
      console.log(
        `  [4] FuncSelector -> ${state.selectedFunction?.name ?? "none"} (path: ${state.pathTaken})`,
      );
    }
  }

  // ── Node 5: Hybrid Executor (with SMART retry loop) ──
  const MAX_RETRIES = 3;
  let lastFailedCypher: string | null = null;
  let lastError: string | null = null;

  // Save the best results across all attempts — if contract rerouting destroys good results,
  // we can fall back to these instead of returning nothing.
  let bestResults: Record<string, unknown>[] | null = null;
  let bestResultsPath: string | null = null;

  // ── PRE-EMPTIVE DECOMPOSITION FOR COMPLEX QUESTIONS ──
  // If the question is multi-part and NO plan was matched, try decomposition
  // BEFORE wasting retries on single-query generation.
  if (
    state.pathTaken !== "function" &&
    state.pathTaken !== "schema" &&
    (state.complexity === "COMPLEX" || state.tierToUse === 3)
  ) {
    const { needsDecomposition, decomposeAndExecute } =
      await import("./nodes/queryDecomposer.js");
    if (needsDecomposition(state.resolvedMessage)) {
      console.log(`  [5] Complex query detected — trying decomposition first`);
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
            `  [5] Decomposition successful: ${decomposition.mergedResults.length} results from ${decomposition.subQueries.length} sub-queries`,
          );
          state = {
            ...state,
            queryResults: decomposition.mergedResults,
            confidence: "medium",
            queryError: null,
            executedCypher: decomposition.subQueries
              .map((sq) => sq.cypher)
              .join("\n---\n"),
            pathTaken: "template",
          };
          // Skip the retry loop — go straight to answer formatting
        }
      } catch (err) {
        console.log(
          `  [5] Decomposition failed, falling back to standard execution: ${(err as Error).message?.substring(0, 80)}`,
        );
      }
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Skip retry loop if decomposition already produced results
    if (state.queryResults && state.queryResults.length > 0 && attempt === 0) {
      break;
    }

    // ── SMART RETRY: inject previous failure context ──
    if (attempt > 0 && lastFailedCypher) {
      state = {
        ...state,
        queryError: `Previous Cypher returned 0 results:\n${lastFailedCypher}\nError: ${lastError ?? "no results"}\nTry a DIFFERENT query approach — do NOT repeat the same pattern.`,
      };
      console.log(
        `  [5] Smart retry #${attempt}: injecting failed Cypher context`,
      );
    }

    const execResult = await hybridExecutor(state);
    state = { ...state, ...execResult };

    console.log(
      `  [5] Executor (attempt ${attempt}) -> path: ${state.pathTaken}, results: ${state.queryResults?.length ?? 0}`,
    );
    routingTrace.executorPath = state.pathTaken || null;

    // ── Save best results so far ──
    // If this attempt returned results, save them. Even if contract verification
    // rejects them and reroutes, we keep them as a fallback.
    if (state.queryResults && state.queryResults.length > 0) {
      if (!bestResults || state.queryResults.length > bestResults.length) {
        bestResults = [...state.queryResults];
        bestResultsPath = state.pathTaken || null;
      }
    }

    // ── Contract Verification ──
    // IMPORTANT: Only verify contracts for PRE-BUILT function results.
    // Dynamic Cypher produces ad-hoc field names that will NEVER match a plan's
    // strict contract schema. Verifying them destroys perfectly good results.
    // Detection: if executedCypher exists, Cypher was dynamically generated
    // (even if pathTaken is still 'function' from a null-function fallthrough).
    const planRoutingEngaged =
      state.routingTrace.plansTried.length > 0 &&
      state.routingTrace.lockedPlanId !== null;
    const wasDynamicCypher =
      state.pathTaken === "template" ||
      state.pathTaken === "constrained" ||
      !!state.executedCypher;
    const activePlan = planRoutingEngaged
      ? planCandidates[planIndex]?.plan
      : null;
    const activeContract = activePlan?.contract;
    const contractExists = !!activeContract;

    if (
      planRoutingEngaged &&
      contractExists &&
      activeContract &&
      activePlan &&
      !wasDynamicCypher
    ) {
      const hasResults = !!state.queryResults && state.queryResults.length > 0;

      routingTrace.activePlanId = activePlan.id;
      routingTrace.activePlanCritical = !!activePlan.critical;

      if (!hasResults) {
        // Empty results usually mean "no data for this query/time range".
        // Rerouting to another plan can produce a misleading *different metric*.
        routingTrace.contractVerified = false;
        routingTrace.contractReason = "No results for the active contract.";
        // Force loop termination; answerFormatter will return the "couldn't find matching data" fallback.
        state.retryCount = MAX_RETRIES;
      } else {
        const verification = verifyContract(state.queryResults, activeContract);
        if (!verification.valid) {
          routingTrace.contractVerified = false;
          routingTrace.contractReason =
            verification.reason ?? "Contract verification failed";
          if (planIndex + 1 < planCandidates.length) {
            planIndex += 1;
            const nextPlan = planCandidates[planIndex].plan;
            const nextMergedParams = mergeEntityParams(
              nextPlan.params ?? {},
              state.extractedEntities,
            );
            state = {
              ...state,
              queryResults: [],
              answer: "",
              queryError: verification.reason ?? "Contract verification failed",
              retryCount: 0,
              selectedFunction: {
                name: nextPlan.functionName,
                params: nextMergedParams,
              },
              pathTaken: "function",
            };
            routingTrace.plansTried.push(nextPlan.id);
            console.log(
              `  [5][Contract] Failed (${verification.reason}) -> rerouting to plan: ${nextPlan.id}`,
            );
            continue;
          }
        } else if (activePlan.critical && activeContract.answerTemplate) {
          routingTrace.contractVerified = true;
          routingTrace.contractReason = null;
          // Deterministic answer for critical KPI-style questions (avoid LLM math errors).
          const row0 = state.queryResults[0] ?? {};
          state = {
            ...state,
            answer: renderAnswerTemplate(activeContract.answerTemplate, row0),
            nodesReferenced: [],
            confidence: "high",
            usedFallback: false,
          };
        } else {
          routingTrace.contractVerified = true;
          routingTrace.contractReason = null;
        }
      }
    } else if (planRoutingEngaged && wasDynamicCypher) {
      // Dynamic Cypher bypasses contract verification — field names are ad-hoc.
      // Just log that we accepted the results without contract check.
      if (state.queryResults && state.queryResults.length > 0) {
        console.log(
          `  [5] Dynamic Cypher results accepted (${state.queryResults.length} records) — contract verification skipped`,
        );
        routingTrace.contractVerified = true;
        routingTrace.contractReason =
          "Dynamic Cypher — contract not applicable";
      }
    }

    if (
      (state.queryResults && state.queryResults.length > 0) ||
      state.answer ||
      state.retryCount >= MAX_RETRIES
    ) {
      break;
    }

    // Save the failed Cypher for smart retry injection
    if (state.executedCypher) {
      lastFailedCypher = state.executedCypher;
      lastError = state.queryError ?? "returned 0 results";
    }

    if (state.retryCount > 0 && !state.answer) {
      state = { ...state, pathTaken: "template", selectedFunction: null };
    }
  }

  // ── FALLBACK: Restore best results if current state has none ──
  // If contract rerouting destroyed good results and retries also failed,
  // restore the best results we saved earlier.
  if (
    (!state.queryResults || state.queryResults.length === 0) &&
    !state.answer &&
    bestResults &&
    bestResults.length > 0
  ) {
    console.log(
      `  [5] Restoring best results from earlier attempt (${bestResults.length} records)`,
    );
    state = {
      ...state,
      queryResults: bestResults,
      pathTaken:
        (bestResultsPath as import("../types/index.js").PathTaken) ||
        state.pathTaken,
      queryError: null,
    };
  }

  // ── SMART FALLBACK: Execute nearest working function when all else fails ──
  // Instead of returning "no data found", find the closest plan with a real
  // pre-built function (not null), execute it, and prefix the answer with
  // "I couldn't answer your exact question, but here's related data:"
  if (
    (!state.queryResults || state.queryResults.length === 0) &&
    !state.answer
  ) {
    // Look through ALL plan candidates for one with a real function
    const fallbackCandidate = planCandidates.find(
      (c) =>
        c.plan.functionName &&
        c.plan.functionName !== "null" &&
        c.similarity >= 0.35,
    );

    if (fallbackCandidate) {
      const fbPlan = fallbackCandidate.plan;
      const fbMergedParams = mergeEntityParams(
        fbPlan.params ?? {},
        state.extractedEntities,
      );
      console.log(
        `  [5] SMART FALLBACK: Trying nearest working function: ${fbPlan.functionName} (plan: ${fbPlan.id}, similarity: ${fallbackCandidate.similarity.toFixed(3)})`,
      );

      try {
        state = {
          ...state,
          selectedFunction: {
            name: fbPlan.functionName,
            params: fbMergedParams,
          },
          pathTaken: "function",
          queryError: null,
          retryCount: 0,
        };
        const fbResult = await hybridExecutor(state);
        state = { ...state, ...fbResult };

        if (state.queryResults && state.queryResults.length > 0) {
          console.log(
            `  [5] Smart fallback returned ${state.queryResults.length} records`,
          );
          state.usedFallback = true;
          // Inject a note so the answer formatter knows this is approximate
          state.resolvedMessage = `[SYSTEM NOTE: The user's exact question could not be answered directly. The closest available analysis (${fbPlan.functionName}) was used instead. Mention this to the user and explain what data IS being shown.]\n\nOriginal question: "${state.resolvedMessage}"`;
        }
      } catch (err) {
        console.log(
          `  [5] Smart fallback failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
    }
  }

  // ── Node 6: Answer Formatter ──
  state = { ...state, ...(await answerFormatter(state)) };
  state.latencyMs = Date.now() - startTime;

  const llmAfter = getLLMStats();
  const llmCallsThisQuery = llmAfter.totalLLMCalls - llmBefore.totalLLMCalls;
  const tokensThisQuery =
    llmAfter.totalTokensIn -
    llmBefore.totalTokensIn +
    (llmAfter.totalTokensOut - llmBefore.totalTokensOut);

  console.log(`  [6] Answer -> ${state.answer.substring(0, 100)}...`);
  console.log(
    `  Done in ${state.latencyMs}ms (Tier ${state.tierToUse}, fallback: ${state.usedFallback})`,
  );
  console.log(
    `  LLM calls this query: ${llmCallsThisQuery} | tokens used: ${tokensThisQuery} | total LLM calls: ${llmAfter.totalLLMCalls}`,
  );
  console.log(`━━━ PIPELINE END ━━━\n`);

  // Save to semantic cache (async, non-blocking)
  const shouldCacheSemantic =
    state.answer &&
    state.queryResults?.length > 0 &&
    (state.routingTrace.contractVerified === true ||
      state.routingTrace.activePlanCritical === true) &&
    state.confidence !== "low";
  if (shouldCacheSemantic) {
    saveToCache(userMessage, state.answer, dbId).catch(() => {});
  }

  // Save conversation memory (async, non-blocking)
  saveHistory(sessionId, userMessage, state.answer, dbId).catch(() => {});
  if (Object.keys(state.extractedEntities).length > 0) {
    saveEntities(sessionId, state.extractedEntities, dbId).catch(() => {});
  }

  return state;
}
