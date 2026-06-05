// ── Multi-DB Connection Registry ──────────────────────────────────────────────
// Manages a pool of named Neo4j drivers so the app can serve multiple databases
// at the same time. Each DB is identified by a stable string id.
//
// Lifecycle:
//   1. initRegistry()          – called once on server start; restores persisted configs
//   2. registerConnection()    – validates + stores a new DB (user-triggered)
//   3. runRegisteredQuery()    – executes Cypher against a specific dbId
//   4. removeConnection()      – tears down driver + deletes config
//   5. closeAllDrivers()       – graceful shutdown

import neo4j, { Driver, Session } from 'neo4j-driver';
import { v4 as uuidv4 } from 'uuid';
import { loadStoredConnections, saveConnections } from './store.js';
import type { DBConnectionConfig, DBConnectionStatus, RegisterDBInput } from './types.js';
import type { QueryResult } from '../types/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Well-known id used for the DB configured via environment variables. */
export const DEFAULT_DB_ID = 'default';

// ── In-memory state ───────────────────────────────────────────────────────────

/** Lazy-created Neo4j drivers, keyed by dbId. */
const _drivers = new Map<string, Driver>();

/** Connection configs loaded from Redis + registered at runtime. */
const _configs = new Map<string, DBConnectionConfig>();

let _initialized = false;

// ── INIT ──────────────────────────────────────────────────────────────────────

/**
 * Load persisted connection configs from Redis.
 * Must be called once before any other registry function.
 * Idempotent — safe to call multiple times.
 */
export async function initRegistry(): Promise<void> {
  if (_initialized) return;

  const stored = await loadStoredConnections();
  for (const config of stored) {
    _configs.set(config.id, config);
    // Drivers are created lazily on first use — not here.
  }

  _initialized = true;
  console.log(`  [DBRegistry] Initialized — ${stored.length} persisted DB connection(s) loaded`);
}

// ── REGISTER ──────────────────────────────────────────────────────────────────

/**
 * Validate credentials by opening a test session, then persist the config.
 *
 * @param input   User-supplied connection details
 * @param fixedId Optional id override (used internally to pin the default DB to "default")
 */
export async function registerConnection(
  input: RegisterDBInput,
  fixedId?: string
): Promise<DBConnectionConfig> {
  const id = fixedId ?? uuidv4();

  const config: DBConnectionConfig = {
    id,
    name: input.name,
    description: input.description,
    uri: input.uri,
    user: input.user,
    password: input.password,
    database: input.database ?? 'neo4j',
    createdAt: new Date().toISOString(),
    isDefault: input.isDefault ?? false,
  };

  // ── Validate credentials with a throw-away driver ──
  const testDriver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.user, config.password),
    { maxConnectionPoolSize: 2, connectionAcquisitionTimeout: 8000 }
  );
  try {
    const session = testDriver.session({ database: config.database });
    await session.run('RETURN 1 AS ping');
    await session.close();
  } catch (err) {
    await testDriver.close();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot connect to "${config.name}": ${msg}`);
  } finally {
    await testDriver.close();
  }

  // ── If this DB is being set as default, un-default all others ──
  if (config.isDefault) {
    for (const existing of _configs.values()) {
      if (existing.isDefault && existing.id !== id) {
        existing.isDefault = false;
      }
    }
  }

  // ── Store config in memory and persist to Redis ──
  _configs.set(id, config);
  await saveConnections(Array.from(_configs.values()));

  console.log(`  [DBRegistry] Registered: "${config.name}" (id=${id}, default=${config.isDefault})`);
  return config;
}

// ── DRIVER (lazy) ──────────────────────────────────────────────────────────────

/**
 * Return (or lazily create) the Neo4j driver for a given dbId.
 * Throws if the dbId is not registered.
 */
export function getRegisteredDriver(dbId: string): Driver {
  const existing = _drivers.get(dbId);
  if (existing) return existing;

  const config = _configs.get(dbId);
  if (!config) throw new Error(`DB not registered: "${dbId}". Register it first via POST /api/databases.`);

  const driver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.user, config.password),
    { maxConnectionPoolSize: 50, connectionAcquisitionTimeout: 5000 }
  );
  _drivers.set(dbId, driver);
  return driver;
}

// ── QUERY ─────────────────────────────────────────────────────────────────────

/**
 * Execute a read-only Cypher query against a specific registered database.
 * Error messages are user-friendly and never expose raw Neo4j internals.
 */
export async function runRegisteredQuery(
  dbId: string,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult[]> {
  const config = _configs.get(dbId);
  if (!config) throw new Error(`DB not registered: "${dbId}"`);

  const driver = getRegisteredDriver(dbId);
  let session: Session | null = null;

  try {
    session = driver.session({ database: config.database });
    const result = await session.executeRead(
      async (tx) => tx.run(cypher, params),
      { timeout: 30000 }
    );
    return result.records.map((record) => {
      const obj: QueryResult = {};
      for (const key of record.keys) {
        obj[key as string] = neo4jValueToJs(record.get(key as string));
      }
      return obj;
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      throw new Error('Query timeout — try asking for fewer records or a simpler aggregation.');
    }
    if (msg.includes('SyntaxError') || msg.includes('Invalid input')) {
      console.error(`  [DBRegistry/${dbId}] Cypher syntax error: ${msg.substring(0, 200)}`);
      throw new Error('Generated query had a syntax error — please rephrase your question.');
    }
    if (msg.includes('MemoryPool') || msg.includes('memory')) {
      throw new Error('Query used too much memory — try asking about fewer entities or add a LIMIT.');
    }
    if (msg.includes('connection') || msg.includes('ECONNREFUSED')) {
      throw new Error('Database connection issue — please try again in a moment.');
    }
    if (msg.includes('Unknown function') || msg.includes('Type mismatch')) {
      console.error(`  [DBRegistry/${dbId}] Query error: ${msg.substring(0, 200)}`);
      throw new Error('Query structure error — please rephrase your question differently.');
    }
    throw new Error(`Database query failed: ${msg.substring(0, 200)}`);
  } finally {
    if (session) await session.close();
  }
}

// ── LIST / GET / REMOVE ───────────────────────────────────────────────────────

export function listConnections(): DBConnectionConfig[] {
  return Array.from(_configs.values());
}

export function getConnection(dbId: string): DBConnectionConfig | null {
  return _configs.get(dbId) ?? null;
}

export function hasConnection(dbId: string): boolean {
  return _configs.has(dbId);
}

/**
 * Returns the id of the default DB.
 * Priority: config.isDefault=true → first registered → DEFAULT_DB_ID constant.
 */
export function getDefaultDbId(): string {
  for (const config of _configs.values()) {
    if (config.isDefault) return config.id;
  }
  const first = _configs.keys().next().value as string | undefined;
  return first ?? DEFAULT_DB_ID;
}

/**
 * Build the safe public status object for a connection (no credentials).
 * Pass an optional liveSchema to include schema stats.
 */
export function buildConnectionStatus(
  config: DBConnectionConfig,
  schemaInfo?: { discovered: boolean; discoveredAt?: string; nodeLabels?: number; relTypes?: number; properties?: number }
): DBConnectionStatus {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    database: config.database,
    isDefault: config.isDefault,
    createdAt: config.createdAt,
    schemaDiscovered: schemaInfo?.discovered ?? false,
    schemaDiscoveredAt: schemaInfo?.discoveredAt,
    totalNodeLabels: schemaInfo?.nodeLabels,
    totalRelTypes: schemaInfo?.relTypes,
    totalProperties: schemaInfo?.properties,
  };
}

export async function removeConnection(dbId: string): Promise<void> {
  if (!_configs.has(dbId)) throw new Error(`DB not registered: "${dbId}"`);

  // Tear down driver if open
  const driver = _drivers.get(dbId);
  if (driver) {
    await driver.close().catch(() => { /* ignore close errors */ });
    _drivers.delete(dbId);
  }

  _configs.delete(dbId);
  await saveConnections(Array.from(_configs.values()));
  console.log(`  [DBRegistry] Removed: ${dbId}`);
}

/** Close all open drivers — call during graceful shutdown. */
export async function closeAllDrivers(): Promise<void> {
  const promises = Array.from(_drivers.entries()).map(async ([id, driver]) => {
    try {
      await driver.close();
      console.log(`  [DBRegistry] Driver closed: ${id}`);
    } catch { /* ignore */ }
  });
  await Promise.all(promises);
  _drivers.clear();
}

// ── INTERNAL: Neo4j value serializer ─────────────────────────────────────────

function neo4jValueToJs(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object') return val;

  // Neo4j Integer { low, high }
  if ('low' in (val as object) && 'high' in (val as object) &&
      typeof (val as Record<string, unknown>).toNumber === 'function') {
    return (val as { toNumber(): number }).toNumber();
  }
  // Neo4j Node
  if ('labels' in (val as object) && 'properties' in (val as object)) {
    const node = val as { labels: string[]; properties: Record<string, unknown> };
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.properties)) {
      props[k] = neo4jValueToJs(v);
    }
    return { labels: node.labels, ...props };
  }
  // Neo4j Relationship
  if ('type' in (val as object) && 'start' in (val as object) && 'end' in (val as object)) {
    return { type: (val as { type: string }).type };
  }
  // Array
  if (Array.isArray(val)) return val.map(neo4jValueToJs);
  // Plain object
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    result[k] = neo4jValueToJs(v);
  }
  return result;
}
