import type {
  IntentType,
  ComplexityLevel,
  PathTaken,
  TierNumber,
  HistoryMessage,
  EntityMap,
  SelectedFunction,
  QueryResult,
  Confidence,
} from "../types/index.js";

export interface RoutingTracePlanCandidate {
  id: string;
  functionName: string;
  critical?: boolean;
  similarity: number;
}

export interface RoutingTrace {
  planCandidates: RoutingTracePlanCandidate[];
  lockedPlanId: string | null;
  plansTried: string[];
  activePlanId: string | null;
  activePlanCritical: boolean | null;
  contractVerified: boolean | null;
  contractReason: string | null;
  executorPath: string | null;
}

export interface O2CGraphState {
  // Input
  userMessage: string;
  sessionId: string;
  dbId: string;
  startTime: number;

  // Memory loaded from Redis
  history: HistoryMessage[];
  entities: EntityMap;

  // Context resolution
  resolvedMessage: string;

  // Guardrail
  isRelevant: boolean | null;

  // Entity extraction
  extractedEntities: EntityMap;

  // Intent + complexity
  intentType: IntentType | "";
  complexity: ComplexityLevel | "";
  tierToUse: TierNumber;

  // Function selection
  selectedFunction: SelectedFunction | null;
  pathTaken: PathTaken | "";

  // Execution
  queryResults: QueryResult[];
  queryError: string | null;
  retryCount: number;
  executedCypher: string | null;

  // Output
  answer: string;
  nodesReferenced: string[];
  confidence: Confidence;
  latencyMs: number;
  usedFallback: boolean;

  // Debug/grounding: what decisions were made before answering
  routingTrace: RoutingTrace;
}

export const initialState: O2CGraphState = {
  userMessage: "",
  sessionId: "",
  dbId: "",
  startTime: 0,
  history: [],
  entities: {},
  resolvedMessage: "",
  isRelevant: null,
  extractedEntities: {},
  intentType: "",
  complexity: "",
  tierToUse: 1,
  selectedFunction: null,
  pathTaken: "",
  queryResults: [],
  queryError: null,
  retryCount: 0,
  executedCypher: null,
  answer: "",
  nodesReferenced: [],
  confidence: "",
  latencyMs: 0,
  usedFallback: false,
  routingTrace: {
    planCandidates: [],
    lockedPlanId: null,
    plansTried: [],
    activePlanId: null,
    activePlanCritical: null,
    contractVerified: null,
    contractReason: null,
    executorPath: null,
  },
};
