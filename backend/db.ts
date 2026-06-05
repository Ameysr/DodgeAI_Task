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
import type { QueryResult } from "./types/index.js";

/** Returns the Neo4j driver for the current default DB. */
export function getDriver(): Driver {
  return getRegisteredDriver(getDefaultDbId());
}

/**
 * Execute a Cypher query against the default DB.
 * Identical error contract to the original implementation.
 */
export async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult[]> {
  return runRegisteredQuery(getDefaultDbId(), cypher, params);
}

/** Close all registered drivers — used during graceful shutdown. */
export async function closeDriver(): Promise<void> {
  await closeAllDrivers();
}
