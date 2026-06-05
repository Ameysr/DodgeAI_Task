// ── DB Connection Types ────────────────────────────────────────────────────────
// Shared interfaces for the multi-DB connection registry.

/** Full config including credentials — never send this to the client. */
export interface DBConnectionConfig {
  id: string;           // uuid, e.g. "default" | "a1b2c3..."
  name: string;         // human-readable, e.g. "SAP O2C Production"
  description?: string; // optional context
  uri: string;          // bolt://host:7687 or neo4j+s://...
  user: string;
  password: string;
  database: string;     // Neo4j database name, e.g. "neo4j"
  createdAt: string;    // ISO-8601
  isDefault: boolean;   // true = used when no dbId is specified
}

/** Safe public view — no credentials exposed. */
export interface DBConnectionStatus {
  id: string;
  name: string;
  description?: string;
  database: string;
  isDefault: boolean;
  createdAt: string;
  schemaDiscovered: boolean;
  schemaDiscoveredAt?: string;
  totalNodeLabels?: number;
  totalRelTypes?: number;
  totalProperties?: number;
}

/** Input shape for registering a new DB. */
export interface RegisterDBInput {
  name: string;
  description?: string;
  uri: string;
  user: string;
  password: string;
  database?: string;   // defaults to "neo4j"
  isDefault?: boolean; // defaults to false
}
