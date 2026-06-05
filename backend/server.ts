import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import chatRouter from "./routes/chat.js";
import graphRouter from "./routes/graph.js";
import adminRouter from "./routes/admin.js";
import { getMetrics } from "./services/metrics.js";
import { getRedis, closeRedis } from "./redis.js";
import { closeDriver, runQuery } from "./db.js";
import { getLLMStats } from "./services/llm.js";
import { initQuestionPlans } from "./services/questionPlans.js";
import { discoverSchema, getLiveSchema } from "./services/schemaAgent.js";
import {
  initRegistry,
  registerConnection,
  hasConnection,
  DEFAULT_DB_ID,
} from "./db/connectionRegistry.js";

// Load .env from project root in dev; in production (Render) env vars are injected natively
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: "../.env" });
} else {
  dotenv.config(); // no-op if no file exists — Render injects vars directly
}

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = [
        FRONTEND_URL,
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
      ];
      // Allow all Vercel preview/production deployments
      if (
        !origin ||
        allowed.includes(origin) ||
        /\.vercel\.app$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-session-id", "x-db-id"],
  }),
);
app.use(express.json({ limit: "10kb" })); // Limit body size to prevent abuse

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 20, // 20 requests per minute per IP
  message: {
    error: "Too many requests — please wait 60 seconds before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Admin rate limit exceeded." },
});

// ── INPUT SIZE LIMIT MIDDLEWARE ────────────────────────────────────────────────
// Only enforce message length limit. Cypher injection prevention is handled by
// the guardrail node's 5-layer keyword blocklist + whitelist (guardrail.ts),
// which is more sophisticated and avoids blocking legitimate questions.
function limitInputSize(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  if (req.body && typeof req.body.message === "string") {
    if (req.body.message.length > 1000) {
      req.body.message = req.body.message.substring(0, 1000);
    }
  }
  next();
}

// ── HEALTH CHECK (checks all dependencies) ────────────────────────────────────
app.get("/health", async (_req, res) => {
  const checks: Record<
    string,
    { status: string; latencyMs: number; error?: string }
  > = {};

  // Neo4j
  const neo4jStart = Date.now();
  try {
    await runQuery("RETURN 1 AS ping", {});
    checks.neo4j = { status: "healthy", latencyMs: Date.now() - neo4jStart };
  } catch (e) {
    checks.neo4j = {
      status: "unhealthy",
      latencyMs: Date.now() - neo4jStart,
      error: (e as Error).message,
    };
  }

  // Redis
  const redisStart = Date.now();
  try {
    const redis = getRedis();
    await redis.ping();
    checks.redis = { status: "healthy", latencyMs: Date.now() - redisStart };
  } catch (e) {
    checks.redis = {
      status: "degraded",
      latencyMs: Date.now() - redisStart,
      error: (e as Error).message,
    };
  }

  // LLM (just check keys exist)
  checks.groq = {
    status: process.env.GROQ_API_KEY ? "configured" : "missing",
    latencyMs: 0,
  };
  checks.deepseek = {
    status: process.env.DEEPSEEK_API_KEY ? "configured" : "missing",
    latencyMs: 0,
  };

  const overallStatus = checks.neo4j.status === "healthy" ? "ok" : "degraded";

  res.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    dependencies: checks,
  });
});

// ── METRICS DASHBOARD ─────────────────────────────────────────────────────────
app.get("/api/metrics", (_req, res) => {
  res.json({
    pipeline: getMetrics(),
    llm: getLLMStats(),
  });
});

// ── QUERY SUGGESTIONS ─────────────────────────────────────────────────────────
app.get("/api/suggestions", (_req, res) => {
  res.json({
    capabilities: [
      "Sales order analysis",
      "Customer analytics",
      "Delivery tracking",
      "Billing & invoicing",
      "Payment analysis",
      "Anomaly detection",
      "AR aging & DSO",
      "O2C cycle time",
      "Revenue insights",
    ],
    suggestions: [
      // Analytics
      {
        question: "Show me the top 5 customers by revenue",
        category: "Analytics",
        intent: "AGGREGATE",
      },
      {
        question: "What is the AR aging breakdown?",
        category: "Analytics",
        intent: "AGGREGATE",
      },
      {
        question: "What is the DSO (Days Sales Outstanding) per customer?",
        category: "Analytics",
        intent: "AGGREGATE",
      },
      {
        question: "Show the order value distribution",
        category: "Analytics",
        intent: "AGGREGATE",
      },
      {
        question: "What is the overall O2C health summary?",
        category: "Analytics",
        intent: "AGGREGATE",
      },
      // Anomaly Detection
      {
        question: "Find all orders that were never delivered",
        category: "Anomaly Detection",
        intent: "DETECT",
      },
      {
        question: "Show invoices cancelled after payment",
        category: "Anomaly Detection",
        intent: "DETECT",
      },
      {
        question: "Give me a complete anomaly report",
        category: "Anomaly Detection",
        intent: "DETECT",
      },
      {
        question: "Which deliveries are overdue?",
        category: "Anomaly Detection",
        intent: "DETECT",
      },
      {
        question: "Find payments without journal entries",
        category: "Anomaly Detection",
        intent: "DETECT",
      },
      // Traversal
      {
        question: "Trace the complete journey of sales order 740544",
        category: "Tracing",
        intent: "TRAVERSE",
      },
      {
        question: "Show the end-to-end flow for customer 320000082",
        category: "Tracing",
        intent: "TRAVERSE",
      },
      // Comparison
      {
        question: "Compare customer 320000082 vs 320000083 revenue",
        category: "Comparison",
        intent: "COMPARE",
      },
      // Lookup
      {
        question: "Show me details for customer 320000082",
        category: "Lookup",
        intent: "LOOKUP",
      },
      {
        question: "What products are stored in plant 1710?",
        category: "Lookup",
        intent: "LOOKUP",
      },
      // Financial
      {
        question: "What is the credit exposure by customer?",
        category: "Financial",
        intent: "AGGREGATE",
      },
      {
        question: "Show the cancellation rate by customer",
        category: "Financial",
        intent: "AGGREGATE",
      },
      {
        question: "What are the debit vs credit totals?",
        category: "Financial",
        intent: "AGGREGATE",
      },
      // Schema
      {
        question: "What is the graph schema design?",
        category: "Schema",
        intent: "TRAVERSE",
      },
      {
        question: "How does your NL system translate to graph queries?",
        category: "Schema",
        intent: "TRAVERSE",
      },
    ],
  });
});

// Routes
app.use("/api/chat", chatLimiter, limitInputSize, chatRouter);
app.use("/api/graph", graphRouter);
app.use("/api/admin", adminLimiter, adminRouter);

// ── CACHE FLUSH ───────────────────────────────────────────────────────────────
app.post("/api/cache/flush", async (_req, res) => {
  try {
    const redis = getRedis();

    const scanAndDel = async (match: string, count = 500): Promise<number> => {
      let cursor = "0";
      let total = 0;

      // SCAN is safe vs KEYS for production-like Redis.
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          match,
          "COUNT",
          count,
        );
        cursor = nextCursor;
        if (Array.isArray(keys) && keys.length > 0) {
          await redis.del(...keys);
          total += keys.length;
        }
      } while (cursor !== "0");

      return total;
    };

    const deletedSemcacheKeys = await scanAndDel("semcache:*");
    const deletedIndexSets = await scanAndDel("semcache:index:*");
    const deletedExact = await scanAndDel("qcache:*");

    await redis.del("graph_data");

    const flushed = deletedSemcacheKeys + deletedIndexSets + deletedExact;
    console.log(`  [Cache] Flushed ${flushed} cached answers + graph cache`);
    res.json({ flushed });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
let server: ReturnType<typeof app.listen>;

function gracefulShutdown(signal: string) {
  console.log(`\n⏻ ${signal} received — starting graceful shutdown...`);

  server.close(async () => {
    console.log("  ✓ HTTP server closed (no new connections)");

    try {
      await closeRedis();
      console.log("  ✓ Redis connection closed");
    } catch {
      console.log("  ⚠ Redis close failed");
    }

    try {
      await closeDriver();
      console.log("  ✓ Neo4j driver closed");
    } catch {
      console.log("  ⚠ Neo4j close failed");
    }

    console.log("  ✓ Shutdown complete\n");
    process.exit(0);
  });

  // Force kill after 10s
  setTimeout(() => {
    console.error("  ✗ Forced shutdown (timeout)");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── SCHEMA VALIDATION ON STARTUP ──────────────────────────────────────────────
async function validateSchema() {
  try {
    // Check node counts instead of indexes (compatible with all Neo4j versions)
    const result = await runQuery(
      `
      MATCH (n) WITH labels(n)[0] AS label, count(n) AS cnt
      RETURN label, cnt ORDER BY cnt DESC LIMIT 10
    `,
      {},
    );
    console.log(`   Node types: ${result.length} found`);

    const relCount = await runQuery(
      `
      MATCH ()-[r:FULFILLED_BY]->() RETURN count(r) AS cnt
    `,
      {},
    );
    const cnt = (relCount[0] as Record<string, unknown>)?.cnt ?? 0;
    if (cnt === 0) {
      console.log(
        "   ⚠ WARNING: 0 FULFILLED_BY relationships — run fix_relationships.mjs",
      );
    } else {
      console.log(`   FULFILLED_BY: ${cnt} relationships ✓`);
    }
  } catch (e) {
    console.log(
      `   ⚠ Schema validation failed: ${(e as Error).message?.substring(0, 80)}`,
    );
  }
}

// Start
server = app.listen(PORT, async () => {
  console.log(`\n🚀 SAP O2C Backend running on port ${PORT}`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   Graph:       http://localhost:${PORT}/api/graph`);
  console.log(`   Chat:        POST http://localhost:${PORT}/api/chat`);
  console.log(`   Metrics:     http://localhost:${PORT}/api/metrics`);
  console.log(`   Suggestions: http://localhost:${PORT}/api/suggestions`);
  console.log(`   Databases:   http://localhost:${PORT}/api/databases`);

  // ── 1. Init connection registry (loads persisted DBs from Redis) ──────────
  await initRegistry();

  // ── 2. Register the env-var DB as the default if not already registered ───
  const NEO4J_URI = process.env.NEO4J_URI ?? "";
  if (NEO4J_URI && !hasConnection(DEFAULT_DB_ID)) {
    try {
      await registerConnection(
        {
          name: process.env.NEO4J_DB_NAME ?? "Default Database",
          description:
            process.env.NEO4J_DB_DESCRIPTION ??
            "Configured via environment variables",
          uri: NEO4J_URI,
          user: process.env.NEO4J_USER ?? "neo4j",
          password: process.env.NEO4J_PASSWORD ?? "",
          database: process.env.NEO4J_DATABASE ?? "neo4j",
          isDefault: true,
        },
        DEFAULT_DB_ID, // pin to well-known id so it survives restarts
      );
      console.log("   ✓ Default DB registered from environment variables");
    } catch (e) {
      console.log(
        `   ⚠ Default DB registration failed: ${(e as Error).message?.substring(0, 100)}`,
      );
    }
  } else if (hasConnection(DEFAULT_DB_ID)) {
    console.log("   ✓ Default DB restored from Redis");
  }

  // ── 3. Schema validation (basic node count check) ──────────────────────────
  await validateSchema();

  // ── 4. Full schema discovery (auto-introspection) ─────────────────────────
  try {
    await discoverSchema(); // uses default DB
    console.log("   ✓ Schema Agent: live schema discovered");
  } catch (e) {
    console.log(
      `   ⚠ Schema Agent failed (will use hardcoded fallback): ${(e as Error).message?.substring(0, 80)}`,
    );
  }

  // ── 5. Load question plans with TF-IDF embeddings ─────────────────────────
  await initQuestionPlans();
  console.log("");
});

// ── ADMIN: Manual schema refresh endpoint ─────────────────────────────────────
app.post("/api/admin/refresh-schema", async (_req, res) => {
  try {
    const schema = await discoverSchema();
    res.json({
      status: "ok",
      nodeLabels: schema.totalNodeLabels,
      relTypes: schema.totalRelTypes,
      properties: schema.totalProperties,
      discoveredAt: schema.discoveredAt,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default app;
