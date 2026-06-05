// ── db.ts — Backward-Compatible Wrapper ───────────────────────────────────────
// All existing code that imports { runQuery, getDriver, closeDriver } from './db.js'
// continues to work unchanged. These functions now delegate to the registry
// using whichever DB is currently set as the default.
//
// To target a specific DB, import directly from './db/connectionRegistry.js'.

import type { Driver } from "neo4j-driver";
import {
  getRegisteredDriver,
  runRegisteredQuery,
  closeAllDrivers,
  getDefaultDbId,
} from "./db/connectionRegistry.js";
import { getActiveDbId } from "./db/context.js";
import type { QueryResult } from "./types/index.js";

function resolveActiveOrDefaultDbId(): string {
  return getActiveDbId() ?? getDefaultDbId();
}

/** Returns the Neo4j driver for the current request DB, or the default DB. */
export function getDriver(): Driver {
  return getRegisteredDriver(resolveActiveOrDefaultDbId());
}

/**
 * Execute a Cypher query against the default DB.
 * Identical error contract to the original implementation.
 */
export async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult[]> {
  return runRegisteredQuery(resolveActiveOrDefaultDbId(), cypher, params);
}

/** Close all registered drivers — used during graceful shutdown. */
export async function closeDriver(): Promise<void> {
  await closeAllDrivers();
}
