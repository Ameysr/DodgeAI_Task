import { Router } from "express";
import type { Request, Response } from "express";
import {
  getHistory,
  getEntities,
  getSessionDb,
  saveSessionDb,
} from "../services/memory.js";
import { checkCache } from "../services/semanticCache.js";
import { log } from "../services/logger.js";
import { runPipeline } from "../graph/index.js";
import { recordQuery, estimateCost } from "../services/metrics.js";
import { getRedis } from "../redis.js";
import type { ObservabilityLog } from "../types/index.js";
import crypto from "crypto";
import { getDefaultDbId, hasConnection } from "../db/connectionRegistry.js";
import { runWithDbContext } from "../db/context.js";

const router = Router();

// ── REDIS QUERY RESULT CACHE (5min TTL) ───────────────────────────────────────
const CACHE_TTL = 300; // 5 minutes

async function getCachedResult(key: string): Promise<string | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(`qcache:${key}`);
    if (raw) console.log("  [Cache] HIT");
    return raw;
  } catch {
    return null;
  }
}

async function setCachedResult(key: string, value: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(`qcache:${key}`, value, "EX", CACHE_TTL);
  } catch {
    /* silent */
  }
}

function cacheKey(msg: string, dbId: string): string {
  // Collision-safe key for the Redis "exact cache".
  // Scope by dbId so the same question on different databases never collides.
  return crypto
    .createHash("sha256")
    .update(`${dbId}|${msg.toLowerCase().trim()}`)
    .digest("hex");
}

// Rate limiting is applied in server.ts (20/min per IP) — no duplicate limiter here.

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.headers["x-session-id"] as string | undefined;
  const requestedDbId = req.headers["x-db-id"] as string | undefined;

  if (!sessionId) {
    res.status(400).json({ error: "Missing x-session-id header" });
    return;
  }

  const { message } = req.body as { message?: string };
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Missing or invalid message" });
    return;
  }

  const startTime = Date.now();

  try {
    // ── Resolve active DB for this session/request ──
    const boundDbId = await getSessionDb(sessionId);
    const resolvedDbId =
      (requestedDbId && requestedDbId.trim()) || boundDbId || getDefaultDbId();

    if (!hasConnection(resolvedDbId)) {
      res.status(400).json({ error: `Unknown database id: ${resolvedDbId}` });
      return;
    }

    await saveSessionDb(sessionId, resolvedDbId);

    // ── Redis query cache check ──
    const cachedJson = await getCachedResult(cacheKey(message, resolvedDbId));
    if (cachedJson) {
      const cached = JSON.parse(cachedJson);
      recordQuery({
        intent: cached.metadata?.intent ?? "",
        latencyMs: Date.now() - startTime,
        cacheHit: true,
        tierUsed: 0,
        provider: "cache",
        path: "cache",
        functionName: "",
        recordCount: 0,
        error: false,
        blocked: false,
        estimatedCost: 0,
      });
      res.json({
        ...cached,
        metadata: {
          ...cached.metadata,
          cacheHit: true,
          latencyMs: Date.now() - startTime,
        },
      });
      return;
    }

    // Load memory in parallel (scoped by session + dbId)
    const [history, entities] = await Promise.all([
      getHistory(sessionId, resolvedDbId),
      getEntities(sessionId, resolvedDbId),
    ]);

    // Check semantic cache
    const semCached = await checkCache(message, resolvedDbId);
    if (semCached) {
      const cacheLog: ObservabilityLog = {
        timestamp: new Date().toISOString(),
        sessionId,
        cacheHit: true,
        tierUsed: 1,
        intentType: "",
        functionCalled: "",
        pathTaken: "",
        retryCount: 0,
        latencyMs: Date.now() - startTime,
        recordsReturned: 0,
        confidence: "high",
        usedFallback: false,
      };
      await log(cacheLog);

      res.json({
        answer: semCached,
        nodesReferenced: [],
        confidence: "high",
        metadata: {
          tier: 1,
          cacheHit: true,
          latencyMs: Date.now() - startTime,
          usedFallback: false,
          pathTaken: "",
          contractVerified: null,
          activePlanId: null,
          contractReason: "semantic cache hit (contract metadata not stored)",
          activePlanCritical: null,
          dbId: resolvedDbId,
        },
      });
      return;
    }

    // Run pipeline
    const state = await runWithDbContext(resolvedDbId, () =>
      runPipeline(
        message,
        sessionId,
        resolvedDbId,
        history,
        entities,
        startTime,
      ),
    );
    const latencyMs = Date.now() - startTime;

    // ── EXPLAINABLE OUTPUT ──
    const response = {
      answer: state.answer,
      nodesReferenced: state.nodesReferenced,
      confidence: state.confidence,
      metadata: {
        tier: state.tierToUse,
        cacheHit: false,
        latencyMs,
        usedFallback: state.usedFallback,
        pathTaken: state.pathTaken,
        intent: state.intentType,
        functionCalled: state.selectedFunction?.name ?? null,
        contractVerified: state.routingTrace?.contractVerified ?? null,
        activePlanId: state.routingTrace?.activePlanId ?? null,
        contractReason: state.routingTrace?.contractReason ?? null,
        activePlanCritical: state.routingTrace?.activePlanCritical ?? null,
        recordCount: state.queryResults?.length ?? 0,
        executedCypher: state.executedCypher ?? null,
        dbId: resolvedDbId,
      },
    };

    // Record metrics
    recordQuery({
      intent: state.intentType,
      latencyMs,
      cacheHit: false,
      tierUsed: state.tierToUse,
      provider: state.usedFallback
        ? "fallback"
        : state.tierToUse === 1
          ? "groq"
          : "deepseek",
      path: state.pathTaken,
      functionName: state.selectedFunction?.name ?? "",
      recordCount: state.queryResults?.length ?? 0,
      error: !!state.queryError,
      blocked: state.isRelevant === false,
      estimatedCost: estimateCost(
        state.tierToUse === 1 ? "groq" : "deepseek",
        state.tierToUse,
      ),
    });

    // Cache result for 5min
    const shouldCacheExact =
      state.answer &&
      (state.queryResults?.length ?? 0) > 0 &&
      state.confidence !== "low" &&
      (state.routingTrace?.contractVerified === true ||
        state.routingTrace?.activePlanCritical === true);

    if (shouldCacheExact) {
      await setCachedResult(
        cacheKey(message, resolvedDbId),
        JSON.stringify(response),
      );
    }

    res.json(response);
  } catch (err: unknown) {
    // Log full error details server-side only
    console.error("[Chat] Pipeline error:", err);

    // Sanitize: never expose internal stack traces / DB errors to frontend
    const safeMessage =
      "Something went wrong processing your question. Please try again.";

    recordQuery({
      intent: "",
      latencyMs: Date.now() - startTime,
      cacheHit: false,
      tierUsed: 0,
      provider: "",
      path: "error",
      functionName: "",
      recordCount: 0,
      error: true,
      blocked: false,
      estimatedCost: 0,
    });

    res.status(500).json({
      answer: safeMessage,
      nodesReferenced: [],
      confidence: "low",
      metadata: {
        tier: 0,
        cacheHit: false,
        latencyMs: Date.now() - startTime,
        usedFallback: false,
        pathTaken: "error",
        error: true,
      },
    });
  }
});

export default router;
