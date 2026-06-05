import { getRedis } from "../redis.js";
import type { HistoryMessage, EntityMap } from "../types/index.js";

const MAX_MESSAGES = 20; // Allow 10 Q&A pairs (each pair = 2 messages: user + assistant)
const HISTORY_TTL = 3600; // 1 hour
const ENTITY_TTL = 3600;
const SESSION_DB_TTL = 3600;
const MAX_ENTITY_TYPES = 6;

function historyKey(sessionId: string, dbId: string): string {
  return `memory:history:${sessionId}:${dbId}`;
}

function entityKey(sessionId: string, dbId: string): string {
  return `memory:entities:${sessionId}:${dbId}`;
}

function sessionDbKey(sessionId: string): string {
  return `memory:session-db:${sessionId}`;
}

export async function saveSessionDb(
  sessionId: string,
  dbId: string,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(sessionDbKey(sessionId), dbId, "EX", SESSION_DB_TTL);
  } catch (err: unknown) {
    console.error("[Memory] Save session DB failed:", err);
  }
}

export async function getSessionDb(sessionId: string): Promise<string | null> {
  try {
    const redis = getRedis();
    return await redis.get(sessionDbKey(sessionId));
  } catch (err: unknown) {
    console.error("[Memory] Get session DB failed:", err);
    return null;
  }
}

export async function saveHistory(
  sessionId: string,
  userMsg: string,
  aiMsg: string,
  dbId: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const key = historyKey(sessionId, dbId);

    const messages: HistoryMessage[] = [
      { role: "user", content: userMsg },
      { role: "assistant", content: aiMsg },
    ];

    for (const msg of messages) {
      await redis.rpush(key, JSON.stringify(msg));
    }

    const len = await redis.llen(key);
    if (len > MAX_MESSAGES) {
      await redis.ltrim(key, len - MAX_MESSAGES, -1);
    }

    await redis.expire(key, HISTORY_TTL);
  } catch (err: unknown) {
    console.error("[Memory] Save history failed:", err);
  }
}

export async function getHistory(
  sessionId: string,
  dbId: string,
): Promise<HistoryMessage[]> {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(historyKey(sessionId, dbId), 0, -1);
    return raw.map((s: string) => JSON.parse(s) as HistoryMessage);
  } catch (err) {
    console.error("[Memory] Get history failed:", err);
    return [];
  }
}

export async function saveEntities(
  sessionId: string,
  newEntities: EntityMap,
  dbId: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const key = entityKey(sessionId, dbId);

    const existing = await getEntities(sessionId, dbId);
    const merged: EntityMap = { ...existing, ...newEntities };

    const entries = Object.entries(merged).filter(([, v]) => v !== undefined);
    const trimmed: EntityMap = {};
    const recentEntries = entries.slice(-MAX_ENTITY_TYPES);
    for (const [k, v] of recentEntries) {
      trimmed[k] = v;
    }

    await redis.set(key, JSON.stringify(trimmed), "EX", ENTITY_TTL);
  } catch (err: unknown) {
    console.error("[Memory] Save entities failed:", err);
  }
}

export async function getEntities(
  sessionId: string,
  dbId: string,
): Promise<EntityMap> {
  try {
    const redis = getRedis();
    const raw = await redis.get(entityKey(sessionId, dbId));
    if (!raw) return {};
    return JSON.parse(raw) as EntityMap;
  } catch {
    return {};
  }
}
