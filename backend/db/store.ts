// ── DB Store: Persist connection configs in Redis ──────────────────────────────
// Configs survive server restarts. Passwords are stored as-is —
// in a production hardening pass, swap this for AES-256-GCM encryption.

import { getRedis } from '../redis.js';
import type { DBConnectionConfig } from './types.js';

const STORE_KEY = 'db:registry:connections';

/**
 * Load all persisted DB configs from Redis.
 * Returns [] if Redis is unavailable (graceful degradation).
 */
export async function loadStoredConnections(): Promise<DBConnectionConfig[]> {
  try {
    const redis = getRedis();
    const raw = await redis.get(STORE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DBConnectionConfig[];
  } catch (err) {
    console.error('[DBStore] Failed to load connections (Redis unavailable?):', (err as Error).message);
    return [];
  }
}

/**
 * Persist all current DB configs to Redis (no TTL — connections should survive indefinitely).
 * Silently swallows errors so a Redis outage never crashes the app.
 */
export async function saveConnections(configs: DBConnectionConfig[]): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(STORE_KEY, JSON.stringify(configs));
  } catch (err) {
    console.error('[DBStore] Failed to save connections:', (err as Error).message);
  }
}

/**
 * Remove a single connection from the persisted list by id.
 */
export async function deleteStoredConnection(id: string): Promise<void> {
  const all = await loadStoredConnections();
  const filtered = all.filter((c) => c.id !== id);
  await saveConnections(filtered);
}
