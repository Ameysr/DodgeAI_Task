import { getRedis } from "../redis.js";
import { getLocalEmbedding } from "./embedding.js";
import { cosineSimilarity } from "../utils/math.js";
import crypto from "crypto";

const CACHE_TTL = 86400; // 24 hours
const SIMILARITY_THRESHOLD = 0.85; // Lowered slightly for domain-vocab vectors
const SEMCACHE_SCAN_KEYS = parseInt(
  process.env.SEMCACHE_SCAN_KEYS ?? "200",
  10,
);
const SEMCACHE_VERSION = process.env.SEMCACHE_VERSION ?? "v3";

function buildIndexKey(dbId: string): string {
  return `semcache:index:${SEMCACHE_VERSION}:${dbId}`;
}

function hashKey(text: string, dbId: string): string {
  const payload = `${SEMCACHE_VERSION}|${dbId}|` + text.toLowerCase().trim();
  return (
    "semcache:" +
    crypto.createHash("sha256").update(payload).digest("hex").substring(0, 16)
  );
}

export async function saveToCache(
  question: string,
  answer: string,
  dbId: string,
): Promise<void> {
  try {
    const embedding = getLocalEmbedding(question);
    const hasSignal = embedding.some((v) => v > 0);
    if (!hasSignal) {
      console.log("  [SemanticCache] Skip save — no embedding");
      return;
    }

    const redis = getRedis();
    const key = hashKey(question, dbId);

    await redis.set(
      key,
      JSON.stringify({ question, answer, embedding, dbId }),
      "EX",
      CACHE_TTL,
    );

    await redis.sadd(buildIndexKey(dbId), key);
    console.log(
      `  [SemanticCache/${dbId}] Saved: "${question.substring(0, 50)}..."`,
    );
  } catch (err: unknown) {
    console.error("[SemanticCache] Save failed:", err);
  }
}

export async function checkCache(
  question: string,
  dbId: string,
): Promise<string | null> {
  try {
    const queryEmbedding = getLocalEmbedding(question);
    const hasSignal = queryEmbedding.some((v) => v > 0);
    if (!hasSignal) {
      console.log("  [SemanticCache] MISS — no embedding");
      return null;
    }

    const redis = getRedis();

    const exactKey = hashKey(question, dbId);
    const exact = await redis.get(exactKey);
    if (exact) {
      const parsed = JSON.parse(exact) as { answer: string };
      console.log(`  [SemanticCache/${dbId}] HIT (exact match)`);
      return parsed.answer;
    }

    const keysRaw = await redis.srandmember(
      buildIndexKey(dbId),
      SEMCACHE_SCAN_KEYS,
    );
    const keys = Array.isArray(keysRaw) ? keysRaw : keysRaw ? [keysRaw] : [];
    let bestSim = 0;
    let bestAnswer: string | null = null;
    let bestQuestion = "";

    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) {
        await redis.srem(buildIndexKey(dbId), key);
        continue;
      }

      const parsed = JSON.parse(raw) as {
        question: string;
        answer: string;
        embedding: number[];
        dbId?: string;
      };
      const sim = cosineSimilarity(queryEmbedding, parsed.embedding);

      if (sim > bestSim) {
        bestSim = sim;
        bestAnswer = parsed.answer;
        bestQuestion = parsed.question;
      }
    }

    if (bestSim >= SIMILARITY_THRESHOLD && bestAnswer) {
      console.log(
        `  [SemanticCache/${dbId}] HIT (similarity: ${bestSim.toFixed(3)}, matched: "${bestQuestion.substring(0, 40)}...")`,
      );
      return bestAnswer;
    }

    console.log(
      `  [SemanticCache/${dbId}] MISS (best similarity: ${bestSim.toFixed(3)}, threshold: ${SIMILARITY_THRESHOLD})`,
    );
    return null;
  } catch (err: unknown) {
    console.error("[SemanticCache] Check failed:", err);
    return null;
  }
}
