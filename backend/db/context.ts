// ── Request-scoped DB context ────────────────────────────────────────────────
// Lets the existing function library keep calling runQuery() while still routing
// each request to the correct registered database. This avoids passing dbId
// through 80+ function signatures.

import { AsyncLocalStorage } from 'node:async_hooks';

interface DbExecutionContext {
  dbId: string;
}

const dbContext = new AsyncLocalStorage<DbExecutionContext>();

/** Execute async work inside a request-scoped dbId context. */
export async function runWithDbContext<T>(dbId: string, work: () => Promise<T>): Promise<T> {
  return dbContext.run({ dbId }, work);
}

/** Returns the active dbId for the current async call chain, if any. */
export function getActiveDbId(): string | null {
  return dbContext.getStore()?.dbId ?? null;
}
