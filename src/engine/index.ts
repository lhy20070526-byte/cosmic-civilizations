import {
  ACTION_TYPES,
  type ActionType,
  type Belief,
  type Civilization,
  type Decision,
  type DecisionMessage,
  type DecisionRecord,
  type EventObservation,
  type KnownContact,
  type KnownSite,
  type Personality,
  type Point,
  type PRNGState,
  type ResourceSite,
  type RunConfig,
  type VisibleEvent,
  type VisibleProposal,
  type VisibleView,
  type World,
  type WorldEvent,
  type Cooperation,
  type Transit,
  type PendingTick,
} from '../shared/types';

/** Public deterministic engine primitives. No function in this module serializes server-only IDs into a view. */

export type EngineConfig = Partial<RunConfig> & {
  seed: string;
  civilizationCount: number;
  maxTicks?: number;
};

export interface PreparedTick {
  tick: number;
  physicalWorld: World;
  rngState: PRNGState;
  generation: number;
  decisions: Record<string, DecisionRecord>;
  requests: Record<string, never>;
}

export interface EndEvaluation {
  ended: boolean;
  reason: 'all-dead' | 'last-civilization' | 'limit' | null;
}

export const ACTION_COSTS: Record<ActionType, number> = {
  develop: 8,
  explore: 5,
  hide: 2,
  defend: 5,
  contact: 3,
  broadcast: 4,
  cooperate: 8,
  strike: 12,
  salvage: 3,
  wait: 0,
};

const MAX_STAT = 100;
const MAX_RESOURCES = 1000;
const MAX_MESSAGE = 600;
const MAX_REASON = 1200;
const MAX_BELIEF = 400;
const ACTION_SET = new Set<string>(ACTION_TYPES);

/** Single source of truth for rule values used by offline and LLM decision paths. */
export const RULES = {
  maxStat: MAX_STAT,
  maxResources: MAX_RESOURCES,
  communicationDelay: 1,
  proposalLifetime: 5,
  environmentInterval: 5,
  budgetSemantics: 'decisionCost <= budget <= current resources; wait budget=0; cooperate proposal/accept cost includes 6 escrow principal',
  costVariable: { strike: 20, cooperate: 8, develop: 10, explore: 5, other: 0 },
  actionCosts: ACTION_COSTS,
  actionTargets: {
    develop: 'none', explore: 'none', hide: 'none', defend: 'none', broadcast: 'none', wait: 'none',
    contact: 'contact', cooperate: 'contact', strike: 'contact', salvage: 'site',
  },
  effects: {
    develop: 'resources -> technology/economy', explore: 'resources -> recon', hide: 'resources -> stealth and lower signature',
    defend: 'resources -> defense', contact: 'delayed information', broadcast: 'delayed information to living contacts',
    cooperate: 'delayed proposal/accept/reject; 6 resource escrow included in cost; settlement returns principal and grants each side at most 2 technology, capped at 100', strike: 'delayed estimated-aim attack', salvage: 'delayed finite site recovery', wait: 'no strategic effect',
  },
} as const;

export const ACTION_SCHEMA = {
  action: ACTION_TYPES,
  target: 'null | local contactId | local siteId',
  intensity: '[0,1]',
  budget: '[0,1000]',
  message: 'null | {kind: proposal|accept|reject|information, replyTo: string|null, text: string}',
  reason: `max ${MAX_REASON} characters`,
} as const;

export function promptRules(): string {
  return JSON.stringify({ rules: RULES, schema: ACTION_SCHEMA });
}

function clamp(value: number, low = 0, high = MAX_STAT): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h || 0x9e3779b9) >>> 0;
}

export function seedPRNG(seed: string): PRNGState {
  return { algorithm: 'mulberry32', state: hashSeed(seed), draws: 0 };
}

export function nextRandom(state: PRNGState): [number, PRNGState] {
  let t = (state.state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, { algorithm: 'mulberry32', state: (state.state + 0x6d2b79f5) >>> 0, draws: state.draws + 1 }];
}

function randomInt(state: PRNGState, low: number, high: number): [number, PRNGState] {
  const [v, next] = nextRandom(state);
  return [Math.floor(low + v * (high - low + 1)), next];
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function makePersonality(seed: string, index: number, source: Personality['source'] = 'rules'): Personality {
  const options: Array<[string, string]> = [
    ['Aster', 'curious'], ['Mira', 'careful'], ['Orion', 'constructive'], ['Vela', 'diplomatic'],
    ['Nyx', 'patient'], ['Solace', 'adaptive'], ['Kite', 'independent'], ['Lumen', 'cooperative'],
  ];
  const offset = hashSeed(`${seed}:persona:${index}`) % options.length;
  const [name, tendency] = options[offset];
  return { name: `${name}-${index + 1}`, values: ['survival', offset % 2 ? 'knowledge' : 'stability'], tendencies: [tendency], source };
}

function localContactId(civ: Civilization, id: string): string {
  const found = Object.entries(civ.contactMap).find(([, trueId]) => trueId === id);
  if (found) return found[0];
  const next = Object.keys(civ.contactMap).filter((k) => k.startsWith('contact-')).length + 1;
  return `contact-${next}`;
}

function localSiteId(civ: Civilization, id: string): string {
  const found = Object.entries(civ.siteMap).find(([, trueId]) => trueId === id);
  if (found) return found[0];
  const next = Object.keys(civ.siteMap).filter((k) => k.startsWith('site-')).length + 1;
  return `site-${next}`;
}

function eventId(world: World): string {
  const id = `event-${world.nextId}`;
  world.nextId += 1;
  return id;
}

function transitId(world: World): string {
  const id = `transit-${world.nextId}`;
  world.nextId += 1;
  return id;
}

function cooperationId(world: World): string {
  const id = `proposal-${world.nextId}`;
  world.nextId += 1;
  return id;
}

function appendEvent(world: World, event: Omit<WorldEvent, 'eventId' | 'observations'>): WorldEvent {
  const complete: WorldEvent = { ...event, eventId: eventId(world), observations: [] };
  world.events.push(complete);
  return complete;
}

function observe(world: World, observerId: string, event: WorldEvent, summary: string): void {
  const civ = world.civilizations.find((candidate) => candidate.id === observerId);
  if (!civ) return;
  const observation: EventObservation = { observerId, observedTick: world.tick, sourceEventId: event.eventId, summary };
  event.observations.push(observation);
  civ.observations.push({ sourceEventId: event.eventId, occurredTick: event.occurredTick, observedTick: world.tick, kind: event.kind, summary });
  civ.history.push(`[${world.tick}] ${summary}`);
}

function emitFor(world: World, kind: string, participants: string[], summary: string, facts: WorldEvent['facts'] = {}, causalEventIds: string[] = []): WorldEvent {
  const event = appendEvent(world, { occurredTick: world.tick, source: 'engine', participants, kind, summary, facts, causalEventIds });
  for (const id of participants) observe(world, id, event, summary);
  return event;
}

function normalizeConfig(config: EngineConfig): Required<Pick<EngineConfig, 'seed' | 'civilizationCount'>> & Partial<RunConfig> {
  return {
    seed: String(config.seed ?? 'cosmic-seed'),
    civilizationCount: clamp(Math.floor(config.civilizationCount || 2), 2, 50),
    maxTicks: config.maxTicks ?? 100,
    segmentTicks: config.segmentTicks ?? 100,
    mode: config.mode ?? 'offline',
    concurrency: config.concurrency ?? 4,
    timeoutMs: config.timeoutMs ?? 5000,
    maxOutputTokens: config.maxOutputTokens ?? 1000,
    requestLimit: config.requestLimit ?? 500,
    failurePolicy: config.failurePolicy ?? 'auto-fallback',
  };
}

export function initWorld(config: EngineConfig, personas?: Personality[]): World {
  const normalized = normalizeConfig(config);
  let rng = seedPRNG(normalized.seed);
  const civilizations: Civilization[] = [];
  for (let i = 0; i < normalized.civilizationCount; i += 1) {
    let x: number;
    let y: number;
    [x, rng] = randomInt(rng, 2, 98);
    [y, rng] = randomInt(rng, 2, 98);
    const personality = personas?.[i] ? deepClone(personas[i]) : makePersonality(normalized.seed, i);
    civilizations.push({
      id: `civ-${i + 1}`, name: personality.name, color: `hsl(${Math.round((i * 360) / normalized.civilizationCount)},70%,60%)`, position: { x, y },
      health: 100, resources: 120, technology: 10, economy: 10, defense: 5, stealth: 5, recon: 12, signature: 20, intel: [],
      beliefs: [], history: [], pendingActions: [], alive: true, personality, contacts: [], sites: [], proposals: [], observations: [], contactMap: {}, siteMap: {},
    });
  }
  const sites: ResourceSite[] = [];
  for (let i = 0; i < Math.max(3, Math.ceil(normalized.civilizationCount / 2)); i += 1) {
    let x: number;
    let y: number;
    let resources: number;
    [x, rng] = randomInt(rng, 5, 95);
    [y, rng] = randomInt(rng, 5, 95);
    [resources, rng] = randomInt(rng, 60, 160);
    sites.push({ id: `site-${i + 1}`, position: { x, y }, resources, kind: 'resource' });
  }
  const initial: World = { tick: 0, rngState: rng, civilizations, sites, transits: [], cooperations: [], events: [], nextId: 1 };
  emitFor(initial, 'initialization', civilizations.map((civ) => civ.id), 'The sector initialized with independent civilizations and finite sites.');
  return initial;
}

function hasThreat(world: World, survivor: Civilization): boolean {
  return world.transits.some(t=>(t.kind==='attack'||t.kind==='environment')&&t.toId===survivor.id&&t.arrivesAt>world.tick&&(t.payload.damage??0)>(t.kind==='attack'?survivor.defense*0.2:0));
}

export function evaluateEnd(world: World, limit: number): EndEvaluation {
  const alive = world.civilizations.filter((civ) => civ.alive);
  if (alive.length === 0) return { ended: true, reason: 'all-dead' };
  if (alive.length === 1 && !hasThreat(world, alive[0])) return { ended: true, reason: 'last-civilization' };
  if (world.tick >= limit) return { ended: true, reason: 'limit' };
  return { ended: false, reason: null };
}

function freshContact(civ: Civilization, target: Civilization, tick: number, sourceEventId: string, rng: PRNGState): [KnownContact, PRNGState] {
  const [noiseX, afterX] = nextRandom(rng);
  const [noiseY, next] = nextRandom(afterX);
  const error = Math.max(0.5, 10 - civ.recon / 10 + target.stealth / 30);
  // Coordinates in a contact are relative to the observer. The observer never sees
  // the sector's absolute frame, and the error is frozen with this observation.
  const estimatedPosition = { x: target.position.x - civ.position.x + (noiseX - 0.5) * error * 2, y: target.position.y - civ.position.y + (noiseY - 0.5) * error * 2 };
  const contactId = localContactId(civ, target.id);
  civ.contactMap[contactId] = target.id;
  return [{ contactId, label: `Contact ${contactId.replace('contact-', '')}`, estimatedPosition, uncertainty: error, observedAt: tick, receivedAt: tick, sourceEventId, estimatedPower: clamp(target.technology + target.defense / 2, 0, 100), status: target.alive ? 'active' : 'destroyed' }, next];
}

function refreshObservations(world: World, rng: PRNGState): PRNGState {
  let current = rng;
  const living = world.civilizations.filter((civ) => civ.alive);
  for (const observer of living) {
    const explored = observer.pendingActions.includes('explore');
    for (const target of living) {
      if (observer.id === target.id) continue;
      const distance = pointDistance(observer.position, target.position);
      const detect = observer.recon + target.signature / 5 + (explored ? 18 : 0) >= distance + target.stealth;
      if (detect) {
        const e = emitFor(world, 'observation', [observer.id], `A distant civilization was observed at range ${Math.round(distance)}.`, { range: Math.round(distance), observer: true });
        const [contact, next] = freshContact(observer, target, world.tick, e.eventId, current);
        current = next;
        const existing = observer.contacts.find((c) => c.contactId === contact.contactId);
        if (existing) Object.assign(existing, contact);
        else observer.contacts.push(contact);
      }
    }
    for (const site of world.sites) {
      if (site.resources <= 0) continue;
      const distance = pointDistance(observer.position, site.position);
      const detect = explored && observer.recon + 20 >= distance;
      if (detect) {
        const e = emitFor(world, 'site-discovery', [observer.id], 'A resource signature was detected.', { kind: site.kind==='debris'?'debris':'resource' });
        const [noise, next] = nextRandom(current);
        current = next;
        const uncertainty = Math.max(0.5, 8 - observer.recon / 8);
        const id = localSiteId(observer, site.id);
        observer.siteMap[id] = site.id;
        const known: KnownSite = { siteId: id, position: { x: site.position.x - observer.position.x + (noise - 0.5) * uncertainty * 2, y: site.position.y - observer.position.y + (noise - 0.5) * uncertainty * 2 }, uncertainty, observedAt: world.tick, receivedAt: world.tick, sourceEventId: e.eventId, estimatedResources: Math.round(site.resources * (0.75 + noise * 0.3)), kind: site.kind==='debris'?'debris':'resource' };
        const existing = observer.sites.find((s) => s.siteId === id);
        if (existing) Object.assign(existing, known);
        else observer.sites.push(known);
      }
    }
  }
  return current;
}

function sendCooperationResult(world: World, c: Cooperation, research: number): void {
  const from=world.civilizations.find(x=>x.id===c.fromId)!,to=world.civilizations.find(x=>x.id===c.toId)!;
  const delay=Math.max(1,Math.ceil(pointDistance(from.position,to.position)/25));
  const e=appendEvent(world,{occurredTick:world.tick,source:'engine',participants:[from.id,to.id],kind:'cooperation-result-dispatched',summary:'A bounded research exchange result entered transit.',facts:{proposalId:c.id,research},causalEventIds:[]});
  for(const civ of [from,to]){
    const contribution=c.escrow?.[civ.id]??0;
    addTransit(world,{kind:'cooperation-result',fromId:civ.id===from.id?to.id:from.id,toId:civ.id,launchedAt:world.tick,arrivesAt:world.tick+delay,payload:{proposalId:c.id,contribution,research,status:c.status,sourceEventId:e.eventId}});
  }
  c.escrow={};
}
function settleCooperations(world: World): void {
  for(const c of world.cooperations){
    if(c.status==='pending'&&c.expiresAt<=world.tick){c.status='expired';sendCooperationResult(world,c,0);}
    if(c.status==='accepted'&&(c.settlesAt??Infinity)<=world.tick){
      const alive=[c.fromId,c.toId].every(id=>world.civilizations.find(x=>x.id===id)?.alive);
      c.status=alive?'settled':'rejected';sendCooperationResult(world,c,alive?c.reward:0);
    }
  }
}
function settleTransit(world:World,t:Transit):void {
  const to=world.civilizations.find(c=>c.id===t.toId),from=world.civilizations.find(c=>c.id===t.fromId);
  if(!to)return;
  if(t.kind==='warning'){
    const e=world.events.find(e=>e.eventId===t.payload.sourceEventId)!;
    if(e){observe(world,to.id,e,'Reconnaissance detected an approaching hostile trajectory.');to.intel.push({...to.observations.at(-1)!});}return;
  }
  if(t.kind==='cooperation-result'){
    const principal=Math.max(0,t.payload.contribution??0),research=to.alive?Math.max(0,Math.min(2,t.payload.research??0)):0;
    to.resources=clamp(to.resources+principal,0,MAX_RESOURCES);to.technology=clamp(to.technology+research);
    const local=to.proposals.find(p=>p.proposalId===t.payload.proposalId);if(local)local.status=t.payload.status??'settled';
    const original=world.events.find(e=>e.eventId===t.payload.sourceEventId);
    if(original)observe(world,to.id,original,`Research result received: principal ${principal}, technology gain ${research}.`);return;
  }
  const sourceEvent=world.events.find(e=>e.eventId===t.payload.launchEventId)??appendEvent(world,{occurredTick:t.launchedAt,source:'engine',participants:[t.fromId,t.toId],kind:'transmission',summary:'A transmission was launched.',facts:{},causalEventIds:[]});
  observe(world,to.id,sourceEvent,t.payload.message??'A transmission arrived.');
  if(from){
    const id=localContactId(to,from.id);to.contactMap[id]=from.id;
    if(!to.contacts.some(c=>c.contactId===id))to.contacts.push({contactId:id,label:`Contact ${id.replace('contact-','')}`,estimatedPosition:null,uncertainty:100,observedAt:t.launchedAt,receivedAt:world.tick,sourceEventId:sourceEvent.eventId,estimatedPower:null,status:'unknown'});
  }
  if(t.kind==='proposal'){
    const c=world.cooperations.find(c=>c.id===t.payload.proposalId);
    if(c&&!to.proposals.some(p=>p.proposalId===c.id))to.proposals.push({proposalId:c.id,contactId:localContactId(to,t.fromId),direction:'incoming',expiresAt:c.expiresAt,contribution:c.contribution,reward:c.reward,status:c.expiresAt<=world.tick?'expired':'pending'});
  }
  if(t.kind==='accept'||t.kind==='reject'){
    const c=world.cooperations.find(c=>c.id===t.payload.proposalId&&c.fromId===t.toId&&c.toId===t.fromId&&c.status==='pending');
    if(!c)return;
    if(world.tick>=c.expiresAt){c.status='expired';sendCooperationResult(world,c,0);}
    else if(t.kind==='reject'||!from?.alive||!to.alive||(c.escrow?.[from.id]??0)!==c.contribution){c.status='rejected';sendCooperationResult(world,c,0);}
    else{c.status='accepted';c.acceptedAt=world.tick;c.settlesAt=world.tick+1;}
    const local=to.proposals.find(p=>p.proposalId===c.id);if(local)local.status=c.status;
  }
}
function settleTransits(world:World):void {
  const frozen=deepClone(world),due=world.transits.filter(t=>t.arrivesAt<=world.tick).sort((a,b)=>a.id.localeCompare(b.id));
  world.transits=world.transits.filter(t=>t.arrivesAt>world.tick);
  for(const victim of frozen.civilizations){
    const impacts=due.filter(t=>(t.kind==='attack'||t.kind==='environment')&&t.toId===victim.id);if(!impacts.length)continue;
    const total=impacts.reduce((sum,t)=>sum+Math.max(0,(t.payload.damage??0)-(t.kind==='attack'?victim.defense*0.2:0)),0);
    const target=world.civilizations.find(c=>c.id===victim.id)!;
    target.health=clamp(victim.health-total);target.alive=victim.alive&&target.health>0;
    const causes=impacts.map(t=>t.payload.launchEventId).filter((id):id is string=>!!id&&world.events.some(e=>e.eventId===id));
    const impact=emitFor(world,'attack-impact',[victim.id],`Simultaneous impacts caused ${Math.round(victim.health-target.health)} damage.`,{damage:victim.health-target.health,incoming:impacts.length,lethal:!target.alive},causes);
    if(victim.alive&&!target.alive)emitFor(world,'civilization-destroyed',[victim.id],'A civilization fell silent after accumulated damage.',{},[impact.eventId]);
  }
  for(const site of frozen.sites){
    const claims=due.filter(t=>t.kind==='salvage'&&t.payload.siteId===site.id&&frozen.civilizations.some(c=>c.id===t.toId&&c.alive));
    const demand=claims.reduce((n,t)=>n+Math.max(0,t.payload.damage??0),0);if(demand===0)continue;
    const supply=Math.min(site.resources,demand);world.sites.find(s=>s.id===site.id)!.resources=Math.max(0,site.resources-supply);
    for(const claim of claims){const civ=world.civilizations.find(c=>c.id===claim.toId)!;const amount=supply*Math.max(0,claim.payload.damage??0)/demand;civ.resources=clamp(civ.resources+amount,0,MAX_RESOURCES);emitFor(world,'salvage',[civ.id],`Recovered ${Number(amount.toFixed(2))} units from a finite site.`,{amount},claim.payload.launchEventId?[claim.payload.launchEventId]:[]);}
  }
  for(const t of due)if(!['attack','environment','salvage'].includes(t.kind))settleTransit(world,t);
}

function produceResources(world: World): void {
  for (const civ of world.civilizations) {
    if (!civ.alive) continue;
    const before=civ.resources;
    civ.resources = clamp(civ.resources + Math.min(12, 2 + civ.economy * 0.15), 0, MAX_RESOURCES);
    emitFor(world,'income',[civ.id],'Bounded local production was credited.',{source:'local-economy',amount:civ.resources-before,balance:civ.resources,perTickCap:12,balanceCap:MAX_RESOURCES});
  }
  settleCooperations(world);
}

function settleEnvironment(world: World, rng: PRNGState): PRNGState {
  if (world.tick % 5 !== 0) return rng;
  let intensity: number;
  let radius: number;
  [intensity, rng] = randomInt(rng, 1, 4);
  [radius, rng] = randomInt(rng, 8, 20);
  const center = { x: 50, y: 50 };
  const participants = world.civilizations.filter((civ) => civ.alive && pointDistance(civ.position, center) <= radius).map((civ) => civ.id);
  const event = appendEvent(world, { occurredTick: world.tick, source: 'engine', participants, kind: 'environment', summary: 'A bounded environmental disturbance crossed the sector.', facts: { radius, intensity, center: 'sector-center' }, causalEventIds: [] });
  for(const id of participants){
    observe(world,id,event,'A local environmental disturbance is forecast for the next tick.');
    addTransit(world,{kind:'environment',fromId:id,toId:id,launchedAt:world.tick,arrivesAt:world.tick+1,payload:{damage:intensity*2,launchEventId:event.eventId}});
  }
  return rng;
}

/** Advance only deterministic physical state. It never asks for or applies a decision. */
export function prepareTick(world: World, rngState: PRNGState = world.rngState): PreparedTick {
  const nextWorld = deepClone(world);
  nextWorld.tick = world.tick + 1;
  let nextRng = deepClone(rngState);
  settleTransits(nextWorld);
  produceResources(nextWorld);
  nextRng = settleEnvironment(nextWorld, nextRng);
  nextRng = refreshObservations(nextWorld, nextRng);
  for (const civ of nextWorld.civilizations) civ.pendingActions = [];
  nextWorld.rngState = nextRng;
  return { tick: nextWorld.tick, physicalWorld: nextWorld, rngState: nextRng, generation: 0, decisions: {}, requests: {} };
}

export function viewFor(world: World, civilizationId: string): VisibleView {
  const civ = world.civilizations.find((candidate) => candidate.id === civilizationId);
  if (!civ) throw new Error('unknown civilization');
  const personality: Personality = { name: String(civ.personality.name), values: civ.personality.values.map(String), tendencies: civ.personality.tendencies.map(String), source: ['llm','rules','template'].includes(civ.personality.source)?civ.personality.source:'rules' };
  const contacts: KnownContact[] = civ.contacts.map((contact) => ({
    contactId: String(contact.contactId), label: String(contact.label),
    estimatedPosition: contact.estimatedPosition ? { x: Number(contact.estimatedPosition.x), y: Number(contact.estimatedPosition.y) } : null,
    uncertainty: Number(contact.uncertainty), observedAt: Number(contact.observedAt), receivedAt: Number(contact.receivedAt), sourceEventId: String(contact.sourceEventId), estimatedPower: contact.estimatedPower === null ? null : Number(contact.estimatedPower),
    ...(contact.lastMessage === undefined ? {} : { lastMessage: String(contact.lastMessage) }), status: ['unknown','active','silent','destroyed'].includes(contact.status)?contact.status:'unknown',
  }));
  const proposals: VisibleProposal[] = civ.proposals.filter((proposal) => proposal.expiresAt >= world.tick).map((proposal) => ({ proposalId: String(proposal.proposalId), contactId: String(proposal.contactId), direction: proposal.direction==='outgoing'?'outgoing':'incoming', expiresAt: Number(proposal.expiresAt), contribution: Number(proposal.contribution), reward: Number(proposal.reward), status: ['pending','accepted','rejected','expired','settled'].includes(proposal.status)?proposal.status:'expired' }));
  const sites: KnownSite[] = civ.sites.map((site) => ({ siteId: String(site.siteId), position: { x: Number(site.position.x), y: Number(site.position.y) }, uncertainty: Number(site.uncertainty), observedAt: Number(site.observedAt), receivedAt: Number(site.receivedAt), sourceEventId: String(site.sourceEventId), estimatedResources: Number(site.estimatedResources), kind: site.kind==='debris'?'debris':'resource' }));
  const beliefs: Belief[] = civ.beliefs.map((belief) => ({ subject: String(belief.subject), claim: String(belief.claim), confidence: Number(belief.confidence), updatedTick: Number(belief.updatedTick), sourceEventIds: belief.sourceEventIds.map(String) }));
  const observations: VisibleEvent[] = civ.observations.slice(-100).map((event) => ({ sourceEventId: String(event.sourceEventId), occurredTick: Number(event.occurredTick), observedTick: Number(event.observedTick), kind: String(event.kind), summary: String(event.summary) }));
  return {
    tick: Number(world.tick),
    self: { name: String(civ.name), health: Number(civ.health), resources: Number(civ.resources), technology: Number(civ.technology), economy: Number(civ.economy), defense: Number(civ.defense), stealth: Number(civ.stealth), recon: Number(civ.recon), signature: Number(civ.signature), personality },
    beliefs, contacts, sites, proposals, observations,
  };
}

function validBelief(value: unknown): value is Belief {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if(Object.keys(candidate).some(k=>!['subject','claim','confidence','updatedTick','sourceEventIds'].includes(k)))return false;
  return typeof candidate.subject === 'string' && candidate.subject.length <= 100 && typeof candidate.claim === 'string' && candidate.claim.length <= MAX_BELIEF && typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1 && Number.isInteger(candidate.updatedTick) && Array.isArray(candidate.sourceEventIds) && candidate.sourceEventIds.every((id) => typeof id === 'string');
}

function decisionValue(view: VisibleView, raw: unknown): Decision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['action', 'target', 'intensity', 'budget', 'message', 'reason', 'beliefUpdates'].includes(key))) return null;
  if (typeof candidate.action !== 'string' || !ACTION_SET.has(candidate.action)) return null;
  if (!(candidate.target === null || typeof candidate.target === 'string')) return null;
  if (typeof candidate.intensity !== 'number' || !Number.isFinite(candidate.intensity) || candidate.intensity < 0 || candidate.intensity > 1) return null;
  if (typeof candidate.budget !== 'number' || !Number.isFinite(candidate.budget) || candidate.budget < 0 || candidate.budget > 1000) return null;
  if (typeof candidate.reason !== 'string' || candidate.reason.length > MAX_REASON) return null;
  if (candidate.message !== null && !validMessage(candidate.message)) return null;
  if (candidate.beliefUpdates !== undefined && (!Array.isArray(candidate.beliefUpdates) || !candidate.beliefUpdates.every(validBelief))) return null;
  const decision = candidate as unknown as Decision;
  const action = decision.action;
  const cost = decisionCost(decision);
  if (action === 'wait' && decision.budget !== 0) return null;
  if (action !== 'wait' && (decision.budget < cost || decision.budget > view.self.resources)) return null;
  const targetIds = action === 'salvage' ? view.sites.map((site) => site.siteId) : view.contacts.map((contact) => contact.contactId);
  if (['contact', 'cooperate', 'strike', 'salvage'].includes(action) && (typeof decision.target !== 'string' || !targetIds.includes(decision.target))) return null;
  if (['develop', 'explore', 'hide', 'defend', 'broadcast', 'wait'].includes(action) && decision.target !== null) return null;
  if (action === 'cooperate' && (!decision.message || !['proposal', 'accept', 'reject'].includes(decision.message.kind))) return null;
  if (action === 'cooperate' && decision.message && ['accept', 'reject'].includes(decision.message.kind) && !decision.message.replyTo) return null;
  if (action === 'cooperate' && decision.message && ['accept', 'reject'].includes(decision.message.kind)) {
    const proposal = view.proposals.find((item) => item.proposalId === decision.message?.replyTo && item.direction === 'incoming' && item.status === 'pending' && item.expiresAt > view.tick);
    if (!proposal || proposal.contactId !== decision.target) return null;
  }
  if (['contact', 'broadcast'].includes(action) && (!decision.message || decision.message.kind !== 'information')) return null;
  if (!['contact', 'broadcast', 'cooperate'].includes(action) && decision.message !== null) return null;
  if (action === 'strike' && (!decision.target || decision.message !== null || !view.contacts.find(c=>c.contactId===decision.target)?.estimatedPosition)) return null;
  if (decision.beliefUpdates?.some((belief) => belief.sourceEventIds.some((sourceId) => !view.observations.some((observation) => observation.sourceEventId === sourceId)))) return null;
  return { action, target: decision.target, intensity: decision.intensity, budget: decision.budget, message: decision.message, reason: decision.reason, beliefUpdates: decision.beliefUpdates };
}

function validMessage(value: unknown): value is DecisionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some((key) => !['kind', 'replyTo', 'text'].includes(key))) return false;
  return typeof message.kind === 'string' && ['proposal', 'accept', 'reject', 'information'].includes(message.kind) && (message.replyTo === null || typeof message.replyTo === 'string') && typeof message.text === 'string' && message.text.length <= MAX_MESSAGE && !/[\u0000-\u001f\u007f]/.test(message.text);
}

/** Boolean predicate kept deliberately small for callers receiving untrusted JSON. */
export function validateDecision(view: VisibleView, unknownDecision: unknown): boolean {
  return decisionValue(view, unknownDecision) !== null;
}

export interface DecisionLegality {
  valid: boolean;
  errors: string[];
  candidate?: {action: string | null; intensity: number | string | null; budget: number | string | null; computedCost: number | null; resources: number};
}

/** Detailed, safe diagnostics for repairing one untrusted decision response. */
export function explainDecision(view: VisibleView, raw: unknown): DecisionLegality {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, errors: ['decision must be a JSON object'] };
  const candidate = raw as Record<string, unknown>;
  const allowed = ['action', 'target', 'intensity', 'budget', 'message', 'reason', 'beliefUpdates'];
  for (const key of Object.keys(candidate)) if (!allowed.includes(key)) errors.push(`unknown field: ${key}`);
  if (typeof candidate.action !== 'string' || !ACTION_SET.has(candidate.action)) errors.push(`action must be one of: ${ACTION_TYPES.join(', ')}`);
  if (!(candidate.target === null || typeof candidate.target === 'string')) errors.push('target must be null or a local handle');
  if (typeof candidate.intensity !== 'number' || !Number.isFinite(candidate.intensity) || candidate.intensity < 0 || candidate.intensity > 1) errors.push('intensity must be a finite number in [0,1]');
  if (typeof candidate.budget !== 'number' || !Number.isFinite(candidate.budget) || candidate.budget < 0 || candidate.budget > 1000) errors.push('budget must be a finite number in [0,1000]');
  if (typeof candidate.reason !== 'string' || candidate.reason.length > MAX_REASON) errors.push(`reason must be a string of at most ${MAX_REASON} characters`);
  if (candidate.message !== null && !validMessage(candidate.message)) errors.push('message must match the safe message schema');
  const action = typeof candidate.action === 'string' ? candidate.action : '';
  const target = typeof candidate.target === 'string' ? candidate.target : null;
  const targetIds = action === 'salvage' ? view.sites.map((site) => site.siteId) : view.contacts.map((contact) => contact.contactId);
  if (['contact', 'cooperate', 'strike', 'salvage'].includes(action) && (!target || !targetIds.includes(target))) errors.push('target is not a currently visible local contactId/siteId');
  if (['develop', 'explore', 'hide', 'defend', 'broadcast', 'wait'].includes(action) && candidate.target !== null) errors.push(`${action} requires target=null`);
  const message = candidate.message as DecisionMessage | null;
  if (action === 'cooperate' && (!message || !['proposal', 'accept', 'reject'].includes(message.kind))) errors.push('cooperate requires message.kind proposal, accept, or reject');
  if (action === 'cooperate' && message && ['accept', 'reject'].includes(message.kind)) {
    const proposal = view.proposals.find((item) => item.proposalId === message.replyTo && item.direction === 'incoming' && item.status === 'pending' && item.expiresAt > view.tick);
    if (!proposal) errors.push('replyTo must reference a non-expired incoming proposal');
    if (!proposal || proposal.contactId !== target) errors.push('cooperate reply target must match the proposal contactId');
    if (!proposal || proposal.contactId !== target) {
      const legalReplies=view.proposals.filter(p=>p.direction==='incoming'&&p.status==='pending'&&p.expiresAt>view.tick&&view.contacts.some(c=>c.contactId===p.contactId)).slice(0,12).map(p=>{
        const reply:Decision={action:'cooperate',target:p.contactId,intensity:0,budget:0,message:{kind:message.kind,replyTo:p.proposalId,text:''},reason:''};
        const cost=decisionCost(reply);
        return {replyTo:p.proposalId,contactId:p.contactId,kind:message.kind,intensity:0,cost,affordable:cost<=view.self.resources};
      });
      errors.push(`At tick ${view.tick}, reply only to matching incoming/pending proposals with expiresAt > tick; outgoing proposals cannot be replied to. First available reply options (intensity=0; higher intensity requires a new cost): ${JSON.stringify(legalReplies)}. Choose any legal action yourself; an empty list means no valid reply of this kind.`);
    }
  }
  if (['contact', 'broadcast'].includes(action) && message && message.kind !== 'information') errors.push(`${action} message.kind must be information`);
  if (['contact', 'broadcast'].includes(action) && !message) errors.push(`${action} requires an information message`);
  if (!['contact', 'broadcast', 'cooperate'].includes(action) && message !== null) errors.push(`${action} requires message=null`);
  if (action === 'strike' && candidate.message !== null) errors.push('strike requires message=null');
  if (action === 'strike' && !view.contacts.find(c => c.contactId === target)?.estimatedPosition) errors.push('strike requires a visible contact with an estimatedPosition');
  if (candidate.beliefUpdates !== undefined && (!Array.isArray(candidate.beliefUpdates) || !candidate.beliefUpdates.every(validBelief))) errors.push('beliefUpdates must contain only bounded beliefs');
  if (Array.isArray(candidate.beliefUpdates)) {
    const unavailable=[...new Set(candidate.beliefUpdates.filter(validBelief).flatMap(belief=>belief.sourceEventIds).filter(sourceId=>!view.observations.some(observation=>observation.sourceEventId===sourceId)))];
    if(unavailable.length)errors.push(`beliefUpdates may cite only allowedBeliefSourceEventIds from this decision input; unavailable evidence (first 12): ${JSON.stringify(unavailable.slice(0,12).map(id=>id.slice(0,100)))}. Do not copy old beliefs with unavailable evidence. Omit beliefUpdates or use [] when making no new update.`);
  }
  let computedCost: number | null = null;
  if (ACTION_SET.has(action) && typeof candidate.intensity === 'number' && Number.isFinite(candidate.intensity)) {
    const estimatedCost = decisionCost({ action: action as ActionType, target, intensity: candidate.intensity, budget: 0, message: (candidate.message ?? null) as DecisionMessage | null, reason: typeof candidate.reason === 'string' ? candidate.reason : '' });
    computedCost = estimatedCost;
    if (estimatedCost > view.self.resources) {
      errors.push(`insufficient resources: computedCost ${estimatedCost} > resources ${view.self.resources}`);
      const minimumCost = decisionCost({action: action as ActionType, target, intensity: 0, budget: 0, message, reason: ''});
      if (minimumCost > view.self.resources) errors.push(`${action}${action === 'cooperate' ? '/' + message?.kind : ''} minimumCost ${minimumCost} > resources ${view.self.resources}; no intensity, including 0, is affordable. Choose another legal action yourself.`);
    }
    if (action === 'wait' && candidate.budget !== 0) errors.push('wait requires budget=0');
    if (action !== 'wait' && typeof candidate.budget === 'number' && candidate.budget < estimatedCost) errors.push(`budget must cover action cost ${estimatedCost}`);
    if (action !== 'wait' && typeof candidate.budget === 'number' && candidate.budget > view.self.resources) errors.push(`budget ${candidate.budget} > resources ${view.self.resources}; require computedCost <= budget <= resources, without rounding resources up`);
  }
  const valid = validateDecision(view, raw);
  if (!valid && errors.length === 0) errors.push('decision does not satisfy the action schema or current visible-state constraints');
  const scalar = (value: unknown): number | string | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? value.slice(0,80) : null;
  return { valid, errors, candidate: {action: ACTION_SET.has(action) ? action : null, intensity: scalar(candidate.intensity), budget: scalar(candidate.budget), computedCost, resources: view.self.resources} };
}

export function parseDecision(view: VisibleView, unknownDecision: unknown): Decision | null {
  return decisionValue(view, unknownDecision);
}

export function decisionCost(decision: Decision): number {
  const base = ACTION_COSTS[decision.action];
  const variable = decision.action === 'strike' ? 20 : decision.action === 'cooperate' ? 8 : decision.action === 'develop' ? 10 : decision.action === 'explore' ? 5 : 0;
  return Math.ceil(base + variable * clamp(decision.intensity, 0, 1)) + (decision.action==='cooperate'&&['proposal','accept'].includes(decision.message?.kind??'')?6:0);
}

function offlineChoice(view: VisibleView, seed: string): number {
  return hashSeed(`${seed}:${view.tick}:${view.self.name}`) % 100;
}

export function offlineDecision(view: VisibleView, seed: string): Decision {
  const choice = offlineChoice(view, seed);
  const targetContact = view.contacts.find((contact) => contact.status === 'active'&&contact.estimatedPosition);
  const targetSite = view.sites.find((site) => site.estimatedResources > 0);
  let action: ActionType = 'wait';
  let target: string | null = null;
  let message: DecisionMessage | null = null;
  const incoming=view.proposals.find(p=>p.direction==='incoming'&&p.status==='pending'&&p.expiresAt>view.tick);
  if(incoming&&choice<60){action='cooperate';target=incoming.contactId;message={kind:'accept',replyTo:incoming.proposalId,text:'Accept the bounded research exchange.'};}
  else if (view.self.resources < 25) action = 'develop';
  else if (targetSite && choice < 35) { action = 'salvage'; target = targetSite.siteId; }
  else if (choice < 55) action = 'explore';
  else if (targetContact && choice < 72) { action = 'contact'; target = targetContact.contactId; message = { kind: 'information', replyTo: null, text: 'A peaceful signal seeking context.' }; }
  else if (choice < 84) action = 'develop';
  else if (choice < 87) { action = 'broadcast'; message = { kind: 'information', replyTo: null, text: 'A bounded public signal seeking context.' }; }
  else if (choice < 91) action = 'hide';
  else if (choice < 95) action = 'defend';
  else if (targetContact && choice < 98) { action = 'strike'; target = targetContact.contactId; }
  else if (targetContact) { action = 'cooperate'; target = targetContact.contactId; message = { kind: 'proposal', replyTo: null, text: 'A bounded exchange proposal.' }; }
  let result: Decision = { action, target, intensity: action === 'wait' ? 0 : 0.5, budget: 0, message, reason: `Deterministic offline policy ${choice}.` };
  if (decisionCost(result) > view.self.resources) result = { action: 'wait', target: null, intensity: 0, budget: 0, message: null, reason: 'Resources below the deterministic action cost.' };
  else if (result.action !== 'wait') result.budget = decisionCost(result);
  return result;
}

function addTransit(world: World, transit: Omit<Transit, 'id'>): void {
  world.transits.push({ ...transit, id: transitId(world) });
}

function resolveTarget(civ: Civilization, decision: Decision): string | undefined {
  if (!decision.target) return undefined;
  return decision.action === 'salvage' ? civ.siteMap[decision.target] : civ.contactMap[decision.target];
}

function launchMessage(world: World, civ: Civilization, targetId: string, decision: Decision, kind: Transit['kind'], physicsWorld: World = world): void {
  const target = physicsWorld.civilizations.find((item) => item.id === targetId);
  if (!target) return;
  const distance = pointDistance(civ.position, target.position);
  const e=emitFor(world,'transmission-launched',[civ.id],'A transmission was launched.',{kind});
  addTransit(world, { kind, fromId: civ.id, toId: targetId, launchedAt: world.tick, arrivesAt: world.tick + Math.max(1, Math.ceil(distance / 25)), payload: { message: decision.message?.text ?? 'A transmission arrived.', proposalId: decision.message?.replyTo ?? undefined,launchEventId:e.eventId } });
}

function executeDecision(world: World, civ: Civilization, decision: Decision, physicsWorld: World = world): void {
  const intensity = clamp(decision.intensity, 0, 1);
  const frozenCiv = physicsWorld.civilizations.find((candidate) => candidate.id === civ.id) ?? civ;
  const targetId = resolveTarget(civ, decision);
  civ.resources = clamp(civ.resources - decisionCost(decision), 0, MAX_RESOURCES);
  civ.pendingActions.push(decision.action);
  civ.lastDecision=deepClone(decision);
  switch (decision.action) {
    case 'develop':
      civ.technology = clamp(civ.technology + (1 + intensity * 2)*Math.max(0.25,1-frozenCiv.stealth/125));
      civ.economy = clamp(civ.economy + (1 + intensity)*Math.max(0.25,1-frozenCiv.stealth/125));
      break;
    case 'explore': civ.recon = clamp(civ.recon + 2 + intensity * 3); break;
    case 'hide': civ.signature = clamp(civ.signature - (3 + intensity * 4)); civ.stealth = clamp(civ.stealth + 1 + intensity * 2); break;
    case 'defend': civ.defense = clamp(civ.defense + 2 + intensity * 4); break;
    case 'contact': if (targetId) launchMessage(world, civ, targetId, decision, 'message', physicsWorld); break;
    case 'broadcast':
      civ.signature = clamp(civ.signature + 3 + intensity * 2);
      for (const target of physicsWorld.civilizations.filter((item) => item.alive && item.id !== civ.id)) launchMessage(world, civ, target.id, decision, 'broadcast', physicsWorld);
      break;
    case 'cooperate': {
      if (!targetId || !decision.message) break;
      if (decision.message.kind === 'proposal') {
        const id = cooperationId(world);
        const target = physicsWorld.civilizations.find((item) => item.id === targetId);
        if (!target) break;
        const distance = pointDistance(civ.position, target.position);
        const contribution = 6;
        const reward = 2;
        if (!target.alive) { civ.resources=clamp(civ.resources+contribution,0,MAX_RESOURCES); break; }
        // Principal is already included in decisionCost; settlement returns it without minting resources.
        const delay = Math.max(1, Math.ceil(distance / 25));
        const proposal: Cooperation = { id, fromId: civ.id, toId: targetId, createdAt: world.tick, expiresAt: world.tick + Math.max(RULES.proposalLifetime + 1, delay * 2 + 2), contribution, reward, status: 'pending' };
        proposal.escrow = { [civ.id]: contribution };
        world.cooperations.push(proposal);
        civ.proposals.push({ proposalId: id, contactId: decision.target!, direction: 'outgoing', expiresAt: proposal.expiresAt, contribution, reward, status: 'pending' });
        addTransit(world, { kind: 'proposal', fromId: civ.id, toId: targetId, launchedAt: world.tick, arrivesAt: world.tick + delay, payload: { message: decision.message.text, proposalId: id, damage: contribution, origin: { x: reward, y: 0 }, expiresAt: proposal.expiresAt } });
      } else {
        const visible = civ.proposals.find((proposal) => proposal.proposalId === decision.message?.replyTo && proposal.direction === 'incoming' && proposal.status === 'pending' && proposal.expiresAt > world.tick && proposal.contactId === decision.target);
        const truth = world.cooperations.find((proposal) => proposal.id === decision.message?.replyTo && proposal.toId === civ.id && proposal.status === 'pending' && proposal.expiresAt > world.tick);
        if (!visible || !truth) {if(decision.message.kind==='accept')civ.resources=clamp(civ.resources+6,0,MAX_RESOURCES);break;}
        if(decision.message.kind==='accept'){truth.escrow={...truth.escrow,[civ.id]:6};visible.status='accepted';}else visible.status='rejected';
        const distance = pointDistance(civ.position, physicsWorld.civilizations.find((item) => item.id === targetId)?.position ?? civ.position);
        addTransit(world, { kind: decision.message.kind === 'accept' ? 'accept' : 'reject', fromId: civ.id, toId: targetId, launchedAt: world.tick, arrivesAt: world.tick + Math.max(1, Math.ceil(distance / 25)), payload: { message: decision.message.text, proposalId: decision.message.replyTo ?? undefined } });
      }
      break;
    }
    case 'strike': {
      if (!targetId) break;
      const target = world.civilizations.find((item) => item.id === targetId);
      const frozenTarget = physicsWorld.civilizations.find((item) => item.id === targetId);
      const contact = civ.contacts.find((item) => item.contactId === decision.target);
      if (!target || !frozenTarget || !contact || !contact.estimatedPosition) break;
      const estimated = contact.estimatedPosition;
      const aimPoint = { x: civ.position.x + estimated.x, y: civ.position.y + estimated.y };
      const aimDistance=pointDistance(civ.position,aimPoint);
      const accuracy=clamp((frozenCiv.technology+frozenCiv.recon-aimDistance/5)/100,0.15,0.95);
      const [roll,nextRng]=nextRandom(world.rngState);world.rngState=nextRng;
      const hit=pointDistance(aimPoint,frozenTarget.position)<=Math.max(1,2+frozenCiv.technology/10)&&roll<accuracy;
      const damage=hit?clamp(10+frozenCiv.technology*0.6+intensity*30,1,90):0;
      const launch=emitFor(world,'attack-launched',[civ.id],'A strike was launched toward an uncertain observed location.',{cost:decisionCost(decision),intensity});
      const attackDelay=Math.max(2,Math.ceil(aimDistance/25));
      addTransit(world,{kind:'attack',fromId:civ.id,toId:target.id,launchedAt:world.tick,arrivesAt:world.tick+attackDelay,payload:{damage,cost:decisionCost(decision),intensity,launchEventId:launch.eventId,origin:aimPoint,aimPoint,hit}});
      const actualDistance=pointDistance(frozenCiv.position,frozenTarget.position);
      if(frozenTarget.recon+frozenCiv.signature/5>=actualDistance+frozenCiv.stealth){
        const warning=appendEvent(world,{occurredTick:world.tick,source:'engine',participants:[target.id],kind:'attack-warning',summary:'An approaching trajectory emitted a detectable signature.',facts:{},causalEventIds:[launch.eventId]});
        addTransit(world,{kind:'warning',fromId:civ.id,toId:target.id,launchedAt:world.tick,arrivesAt:world.tick+1,payload:{sourceEventId:warning.eventId}});
      }
      break;
    }
    case 'salvage': {
      if (!targetId) break;
      const site = world.sites.find((item) => item.id === targetId);
      if (!site || site.resources <= 0) {
        emitFor(world, 'salvage-failed', [civ.id], '拾荒未完成：目标地点已耗尽或不可用。', { site: targetId ?? null });
        break;
      }
      const amount = Math.min(site.resources, Math.max(1, Math.round(10 + intensity * 20 + civ.economy / 5)));
      addTransit(world, { kind: 'salvage', fromId: civ.id, toId: civ.id, launchedAt: world.tick, arrivesAt: world.tick + 1, payload: { siteId: site.id, damage: amount, cost: decisionCost(decision) } });
      break;
    }
    case 'wait': break;
  }
  if (decision.beliefUpdates) {
    for (const belief of decision.beliefUpdates) {
      if (belief.sourceEventIds.every((sourceId) => civ.observations.some((observation) => observation.sourceEventId === sourceId))) {
        const existing = civ.beliefs.find((item) => item.subject === belief.subject);
        if (existing) Object.assign(existing, deepClone(belief));
        else civ.beliefs.push(deepClone(belief));
      }
    }
  }
  emitFor(world, 'decision-applied', [civ.id], `Action ${decision.action} completed.`, { action: decision.action, cost: decisionCost(decision) });
}

function pendingWorld(pending: PreparedTick | PendingTick): World {
  return deepClone(pending.physicalWorld);
}

/** Atomically reserves costs per civilization, then applies all actions against one frozen world. */
export function applyDecisions(pending: PreparedTick | PendingTick, records: DecisionRecord[] | Record<string, DecisionRecord>): World {
  const world = pendingWorld(pending);
  const physicsSnapshot = deepClone(pending.physicalWorld);
  const list = Array.isArray(records) ? records : Object.values(records);
  const byId = new Map(list.map((record) => [record.civilizationId, record]));
  const ordered = physicsSnapshot.civilizations.filter((civ) => civ.alive).sort((a, b) => a.id.localeCompare(b.id));
  for (const civ of ordered) {
    const record = byId.get(civ.id);
    if (!record) continue;
    const parsed = decisionValue(viewFor(physicsSnapshot,civ.id), record.decision);
    if (!parsed) {emitFor(world,'decision-rejected',[civ.id],'The proposed action failed frozen-view validation.',{});continue;}
    const cost = decisionCost(parsed);
    const destination = world.civilizations.find((candidate) => candidate.id === civ.id);
    if (!destination || record.reservedCost !== cost || cost > civ.resources || record.reservedCost > civ.resources || record.reservedCost < 0) {
      emitFor(world, 'decision-rejected', [civ.id], 'Action rejected because the frozen resource reservation was insufficient.', { cost });
      continue;
    }
    const eventStart=world.events.length;
    executeDecision(world, destination, parsed, physicsSnapshot);
    if(record.source==='human')for(const event of world.events.slice(eventStart))if(event.kind==='decision-applied')event.source='human';
  }
  return world;
}

export function toDecisionRecord(civilizationId: string, view: VisibleView, decision: Decision, source: DecisionRecord['source'] = 'rules'): DecisionRecord {
  return { civilizationId, view, decision, source, reservedCost: decisionCost(decision), requestId: `decision-${view.tick}-${civilizationId}` };
}

