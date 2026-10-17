/** Shared wire contracts. Internal truth MUST NOT be serialized into model prompts. */
export const SNAPSHOT_VERSION = 1 as const;
export const ENGINE_VERSION = '1.0.0' as const;
export const ACTION_TYPES = ['develop', 'explore', 'hide', 'defend', 'contact', 'broadcast', 'cooperate', 'strike', 'salvage', 'wait'] as const;
export type ActionType = typeof ACTION_TYPES[number];
export type RunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';
export type ExecutionMode = 'llm' | 'offline' | 'mixed';
export type OutputSource = 'llm' | 'rules' | 'template' | 'human';
export interface PRNGState { algorithm: 'mulberry32'; state: number; draws: number }
export type Point = { x: number; y: number };
export type Personality = { name: string; values: string[]; tendencies: string[]; source: OutputSource };
export interface RunConfig {
  seed: string;
  civilizationCount: number;
  segmentTicks: number;
  maxTicks: number;
  mode: ExecutionMode;
  concurrency: number;
  timeoutMs: number;
  maxOutputTokens: number;
  requestLimit: number;
  failurePolicy: 'pause' | 'auto-fallback';
}
export interface CreateRunRequest { humanCivilizationId?: string | null; seed?: string; civilizationCount?: number; segmentTicks?: number; maxTicks?: number; mode?: ExecutionMode; requestLimit?: number; failurePolicy?: RunConfig['failurePolicy'] }
export interface ConfigResponse { configured: boolean; provider: string; model: string; defaults: RunConfig; limits: { minCivilizations: number; maxCivilizations: number; minSegmentTicks: number; maxSegmentTicks: number }; missing?: string[]; verified?: boolean; protocol?: string }

/** An observer's memory contains local handles only. Mapping to truth lives outside this object. */
export interface KnownContact { contactId: string; label: string; estimatedPosition: Point | null; uncertainty: number; observedAt: number; receivedAt: number; sourceEventId: string; estimatedPower: number | null; lastMessage?: string; status: 'unknown' | 'active' | 'silent' | 'destroyed' }
export interface KnownSite { siteId: string; position: Point; uncertainty: number; observedAt: number; receivedAt: number; sourceEventId: string; estimatedResources: number; kind: 'resource' | 'debris' }
export interface VisibleProposal { proposalId: string; contactId: string; direction: 'incoming' | 'outgoing'; expiresAt: number; contribution: number; reward: number; status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'settled' }
export interface VisibleEvent { sourceEventId: string; occurredTick: number; observedTick: number; kind: string; summary: string }
export interface VisibleView {
  tick: number;
  self: { name: string; health: number; resources: number; technology: number; economy: number; defense: number; stealth: number; recon: number; signature: number; personality: Personality };
  beliefs: Belief[];
  contacts: KnownContact[];
  sites: KnownSite[];
  proposals: VisibleProposal[];
  observations: VisibleEvent[];
}
export interface DecisionMessage { kind: string; replyTo: string | null; text: string }
export interface Belief { subject: string; claim: string; confidence: number; updatedTick: number; sourceEventIds: string[] }
export interface Decision {
  action: ActionType;
  /** Local contactId/siteId, never an engine ID. null for untargeted actions. */
  target: string | null;
  intensity: number;
  budget: number;
  message: DecisionMessage | null;
  reason: string;
  beliefUpdates?: Belief[];
}

/** Server-only world. True IDs and positions below are NEVER model-visible DTOs. */
export interface Civilization { id: string; name: string; color: string; position: Point; health: number; resources: number; technology: number; economy: number; defense: number; stealth: number; recon: number; signature: number; intel: VisibleEvent[]; beliefs: Belief[]; history: string[]; pendingActions: string[]; alive: boolean; personality: Personality; contacts: KnownContact[]; sites: KnownSite[]; proposals: VisibleProposal[]; observations: VisibleEvent[]; contactMap: Record<string, string>; siteMap: Record<string, string>; lastDecision?: Decision }
export interface ResourceSite { id: string; position: Point; resources: number; kind: 'resource' | 'debris' }
export interface Transit { id: string; kind: 'message' | 'broadcast' | 'attack' | 'proposal' | 'accept' | 'reject' | 'salvage' | 'environment' | 'warning' | 'cooperation-result'; fromId: string; toId: string; launchedAt: number; arrivesAt: number; payload: { message?: string; damage?: number; proposalId?: string; origin?: Point; aimPoint?: Point; hit?: boolean; cost?: number; intensity?: number; launchEventId?: string; finalEventId?: string; sourceEventId?: string; siteId?: string; expiresAt?: number; contribution?: number; research?: number; status?: VisibleProposal['status'] } }
export interface Cooperation { id: string; fromId: string; toId: string; createdAt: number; expiresAt: number; contribution: number; reward: number; status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'settled'; acceptedAt?: number; settlesAt?: number; escrow?: Record<string, number> }
export interface EventObservation { observerId: string; observedTick: number; sourceEventId: string; summary: string }
export interface WorldEvent { eventId: string; occurredTick: number; source: 'engine' | OutputSource; participants: string[]; kind: string; summary: string; facts: Record<string, string | number | boolean | null>; causalEventIds: string[]; observations: EventObservation[] }
export interface World { tick: number; rngState: PRNGState; civilizations: Civilization[]; sites: ResourceSite[]; transits: Transit[]; cooperations: Cooperation[]; events: WorldEvent[]; nextId: number }
export interface RequestRecord { id: string; kind: 'personality' | 'decision' | 'narrative'; civilizationId?: string; tick: number; attempts: number; status: 'pending' | 'success' | 'failed' | 'fallback'; source: OutputSource; error?: string; durationMs?: number; result?: unknown }
export interface DecisionRecord { civilizationId: string; view: VisibleView; decision: Decision; source: OutputSource; reservedCost: number; requestId: string }
export interface PendingTick { tick: number; stage: 'personalities' | 'decisions' | 'commit'; physicalWorld: World; rngState: PRNGState; decisions: Record<string, DecisionRecord>; requests: Record<string, RequestRecord>; failure?: { civilizationId?: string; message: string }; generation: number; baselineCommitId?: string; engineVersion?: string; schemaVersion?: number; phaseCursor?: string }
export interface HistoryFrame { tick: number; world: World; decisions: DecisionRecord[]; rngState: PRNGState }

export interface FactCard { id: string; eventIds: string[]; layer: 'universe' | 'civilization' | 'relation' | 'reflection'; text: string; fromTick?: number; toTick?: number }
export interface NarrativeSection { layer: FactCard['layer']; text: string; factIds: string[]; eventIds: string[] }
export interface Narrative { runId: string; title: string; mode: ExecutionMode; sourceEventIds: string[]; facts: FactCard[]; inferences: string[]; generatedBy: string; fallbackReason: string | null; id: string; fromTick: number; toTick: number; source: OutputSource; cards: FactCard[]; sections: NarrativeSection[]; createdAt: string; factVersion?: 1 | 2 }
export interface RunState { humanCivilizationId?: string | null; usedRequests: number; phase: string; llmParameters: {provider:string;model:string;protocol:string;temperature:number;timeout:number;concurrency:number}; committedIds: string[]; narrativeError?: string; id: string; createdAt: string; status: RunStatus; config: RunConfig; world: World; rngState: PRNGState; pendingTick: PendingTick | null; history: HistoryFrame[]; narratives: Narrative[]; requestLog: RequestRecord[]; generation: number; segmentEnd: number; terminalReason?: string; error?: string; imported?: boolean }
/** Operator can inspect omniscient world; this is never passed to an LLM. */
export type PublicRun = RunState;
export interface Snapshot { schemaVersion: typeof SNAPSHOT_VERSION; engineVersion: typeof ENGINE_VERSION; runId: string; seed: string; config: RunConfig; engineState: RunState; eventLog: WorldEvent[]; decisions: DecisionRecord[]; narrative: Narrative[]; exportCreatedAt: string; checksum: string }
export interface ApiError { error: string; code?: string; run?: PublicRun }
export interface ExtendRequest { ticks: number }
export interface NarrativeRequest { fromTick?: number; toTick?: number; template?: boolean }
export interface FallbackRequest { enabled: boolean }

/** Human input uses the same frozen, local-handle-only view as model decisions. */
export interface HumanTurn {
 busy: boolean;
 civilizationId: string | null;
 tick: number;
 turnId: string | null;
 waiting: boolean;
 submitted: boolean;
 decisionSource: OutputSource | null;
 view: VisibleView | null;
 guidance: Record<string, unknown> | null;
}
export interface HumanDecisionRequest { turnId: string; decision: Decision }
export interface HumanControlRequest { civilizationId: string | null }
