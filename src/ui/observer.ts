import type { Civilization, HistoryFrame, World, WorldEvent } from '../shared/types';

const MARKS = ['◆', '●', '▲', '■', '✦', '◇', '⬟', '✧', '○', '△'];
const CN_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const SHORT_NAMES = ['曙光', '织巢', '远岚', '蓝脉', '静潮', '赤环', '澄星', '寒焰', '雾航', '松石', '灰曜', '归潮'];
const ACTION_LABELS: Record<string, string> = {
  develop: '扩建研究设施', explore: '扩大观测范围', hide: '降低自身信号', defend: '加强防护',
  contact: '发出联络信号', broadcast: '向周围广播', cooperate: '发起合作请求', strike: '发起攻击',
  salvage: '派出回收任务', wait: '选择等待',
};
const MAJOR_KINDS = new Set(['attack-launched', 'attack-arrived', 'attack-impact', 'attack-warning', 'death', 'destroyed', 'civilization-destroyed', 'cooperation-result', 'cooperation-result-dispatched', 'cooperation', 'environment-change', 'environment', 'disaster', 'catastrophe']);
const TECHNICAL_KINDS = new Set(['commit', 'genesis', 'initialization', 'income']);

export interface CivilizationIdentity {
  id: string;
  number: number;
  label: string;
  marker: string;
  color: string;
  secondaryName: string;
  shortName: string;
}

export interface ObserverTimelineItem {
  id: string;
  tick: number;
  fromTick?: number;
  toTick?: number;
  kind: 'round' | 'action' | 'major' | 'change' | 'contact' | 'broadcast';
  title: string;
  text: string;
  eventIds: string[];
  civilizationIds: string[];
}

export function civilizationIdentity(civ: Civilization, index = 0): CivilizationIdentity {
  const suffix = civ.id.match(/(\d+)$/)?.[1];
  const number = suffix ? Number(suffix) : index + 1;
  const shortNumber = CN_NUMBERS[number - 1] ?? number.toString();
  const shortName = SHORT_NAMES[(number - 1) % SHORT_NAMES.length];
  return { id: civ.id, number, label: `${shortNumber}号·${shortName}`, marker: MARKS[(number - 1) % MARKS.length], color: civ.color, secondaryName: civ.name, shortName };
}

export function civilizationIdentities(civilizations: Civilization[]): Record<string, CivilizationIdentity> {
  return Object.fromEntries(civilizations.map((civ, index) => [civ.id, civilizationIdentity(civ, index)]));
}

function eventActors(event: WorldEvent, identities: Record<string, CivilizationIdentity>): string[] {
  return event.participants.map((id) => identities[id]?.label ?? id);
}

function actionFor(event: WorldEvent): string | undefined {
  return typeof event.facts?.action === 'string' ? event.facts.action : undefined;
}

function roundText(tick: number, commit: WorldEvent | undefined, world: World): string {
  if (commit?.summary) {
    const match = commit.summary.match(/第\s*\d+\s*轮.*?：(.+)/);
    if (match) return `第 ${tick} 轮：${match[1].replace(/完整提交|完成提交/g, '完成')}`;
  }
  return `第 ${tick} 轮完成，${world.civilizations.filter((civ) => civ.alive).length} 个文明仍在活动。`;
}

function actionLabel(action: string | undefined, messageKind?: string): string {
  if (action === 'cooperate' && messageKind === 'accept') return '接受了合作提议';
  if (action === 'cooperate' && messageKind === 'reject') return '拒绝了合作提议';
  if (action === 'cooperate' && messageKind === 'proposal') return '发起了合作请求';
  return ACTION_LABELS[action ?? ''] ?? '完成了一次行动';
}

function actionText(event: WorldEvent, identities: Record<string, CivilizationIdentity>, target?: string, messageKind?: string): string {
  const actor = eventActors(event, identities)[0] ?? '一个文明';
  const action = actionFor(event);
  const targetText = target ? `（目标${identities[target]?.label ?? target}）` : '';
  return `${actor}${actionLabel(action, messageKind)}${targetText}`;
}

function majorText(event: WorldEvent, identities: Record<string, CivilizationIdentity>): string {
  const actors = eventActors(event, identities);
  const actor = actors[0] ?? '一个文明';
  if (event.kind === 'attack-launched') return `${actor}发起了攻击`;
  if (event.kind === 'attack-arrived' || event.kind === 'attack-impact') return `${actor}收到了攻击结果`;
  if (event.kind === 'attack-warning' || event.kind === 'warning') return `${actor}收到了接近中的轨迹警报`;
  if (event.kind === 'death' || event.kind === 'destroyed' || event.kind === 'civilization-destroyed') return `${actor}停止了活动`;
  if (event.kind === 'cooperation-result-dispatched') return `${actor}与${actors[1] ?? '另一个文明'}的结算结果已发出，等待接收`;
  if (event.kind === 'cooperation' || event.kind === 'cooperation-result') return `${actor}与${actors[1] ?? '另一个文明'}产生了合作结算`;
  if (event.kind === 'environment-change') return '环境扰动改变了这片区域';
  return event.summary;
}

function stateFrame(history: HistoryFrame[], tick: number): World | undefined {
  return history.filter((frame) => frame.tick <= tick).sort((a, b) => b.tick - a.tick)[0]?.world;
}

function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded) < 0.05) return '0';
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, '');
  return rounded > 0 ? `+${text}` : text;
}

function changeText(civ: Civilization, previous: Civilization | undefined, identity: CivilizationIdentity): string | null {
  if (!previous) return null;
  const changes = [
    ['健康', civ.health - previous.health],
    ['储备', civ.resources - previous.resources],
    ['研究', civ.technology - previous.technology],
  ].filter(([, value]) => value !== 0) as [string, number][];
  return changes.length ? `${identity.label}本轮${changes.map(([label, value]) => `${label} ${signed(value)}`).join('，')}` : null;
}

function decisionTarget(frameWorld: World, civId: string, decision: Civilization['lastDecision']): string | undefined {
  if (!decision?.target) return undefined;
  const civ = frameWorld.civilizations.find((item) => item.id === civId);
  return civ?.contactMap[decision.target] ?? civ?.siteMap[decision.target];
}

function actionTarget(event: WorldEvent): string | undefined {
  for (const key of ['targetId', 'targetCivilizationId', 'toId']) {
    const value = event.facts?.[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

interface HistoricalContact {
  mode: 'contact' | 'broadcast';
  from: string;
  to?: string;
  tick: number;
  eventIds: string[];
}

function historicalContacts(world: World, history: HistoryFrame[], events: WorldEvent[]): HistoricalContact[] {
  const frames = [...history.filter((frame) => frame.tick <= world.tick), { tick: world.tick, world, decisions: world.civilizations.flatMap((civ) => civ.lastDecision ? [{ civilizationId: civ.id, decision: civ.lastDecision }] : []), rngState: world.rngState } as HistoryFrame];
  const contacts: HistoricalContact[] = [];
  const usedLaunchEvents = new Set<string>();
  const seenContact = new Set<string>();
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const eventIdsByTickCiv = new Map<string, string[]>();
  events.forEach((event) => event.participants.forEach((civId) => {
    const key = `${event.occurredTick}:${civId}`;
    eventIdsByTickCiv.set(key, [...(eventIdsByTickCiv.get(key) ?? []), event.eventId]);
  }));
  const eventsAt = (tick: number, civId: string) => eventIdsByTickCiv.get(`${tick}:${civId}`) ?? [];
  for (const frame of frames) {
    for (const record of frame.decisions) {
      const action = record.decision.action;
      if (!['contact', 'broadcast'].includes(action)) continue;
      const from = record.civilizationId;
      if (action === 'broadcast') {
        const broadcastKey = `${frame.tick}:${from}:broadcast`;
        if (!seenContact.has(broadcastKey)) {
          seenContact.add(broadcastKey);
          contacts.push({ mode: 'broadcast', from, tick: frame.tick, eventIds: eventsAt(frame.tick, from) });
        }
        continue;
      }
      const candidates = [decisionTarget(frame.world, from, record.decision)];
      for (const to of candidates) {
        if (!to || to === from) continue;
        const contactKey = `${frame.tick}:${from}:${to}`;
        if (seenContact.has(contactKey)) continue;
        seenContact.add(contactKey);
        const eventIds = eventsAt(frame.tick, from);
        contacts.push({ mode: 'contact', from, to, tick: frame.tick, eventIds });
      }
    }
    for (const transit of frame.world.transits) {
      const launchEventId = transit.payload.launchEventId;
      if (!launchEventId || usedLaunchEvents.has(launchEventId)) continue;
      const launch = eventById.get(launchEventId);
      if (transit.kind !== 'message' || !launch || !transit.toId || transit.fromId === transit.toId) continue;
      const contactKey = `${launch.occurredTick}:${transit.fromId}:${transit.toId}`;
      if (seenContact.has(contactKey)) continue;
      seenContact.add(contactKey);
      usedLaunchEvents.add(launchEventId);
      contacts.push({ mode: 'contact', from: transit.fromId, to: transit.toId, tick: launch.occurredTick, eventIds: [launchEventId] });
    }
  }
  return contacts;
}

export function projectObserverTimeline(world: World, history: HistoryFrame[] = []): ObserverTimelineItem[] {
  const identities = civilizationIdentities(world.civilizations);
  const events = (world.events ?? []).filter((event) => event.occurredTick <= world.tick).sort((a, b) => a.occurredTick - b.occurredTick || a.eventId.localeCompare(b.eventId));
  const byTick = new Map<number, WorldEvent[]>();
  events.forEach((event) => byTick.set(event.occurredTick, [...(byTick.get(event.occurredTick) ?? []), event]));
  const result: ObserverTimelineItem[] = [];
  const targetByDecision = new Map<string, string | undefined>();
  const messageKindByDecision = new Map<string, string | undefined>();
  for (const frame of history.filter((item) => item.tick <= world.tick)) {
    for (const record of frame.decisions) {
      const key = `${frame.tick}:${record.civilizationId}:${record.decision.action}`;
      targetByDecision.set(key, decisionTarget(frame.world, record.civilizationId, record.decision));
      messageKindByDecision.set(key, record.decision.message?.kind);
    }
  }
  world.civilizations.forEach((civ) => {
    if (civ.lastDecision) {
      const key = `${world.tick}:${civ.id}:${civ.lastDecision.action}`;
      targetByDecision.set(key, decisionTarget(world, civ.id, civ.lastDecision));
      messageKindByDecision.set(key, civ.lastDecision.message?.kind);
    }
  });
  const actionGroupsByActor = new Map<string, { actor: string; action: string; target?: string; messageKind?: string; events: WorldEvent[]; fromTick: number; toTick: number }[]>();
  events.filter((event) => event.kind === 'decision-applied').forEach((event) => {
    const actor = event.participants[0] ?? '';
    const action = actionFor(event) ?? 'unknown';
    const decisionKey = `${event.occurredTick}:${actor}:${action}`;
    const target = actionTarget(event) ?? targetByDecision.get(decisionKey);
    const messageKind = messageKindByDecision.get(decisionKey);
    const groups = actionGroupsByActor.get(actor) ?? [];
    const previous = groups.at(-1);
    if (previous && previous.action === action && previous.target === target && previous.messageKind === messageKind && event.occurredTick === previous.toTick + 1) {
      previous.events.push(event); previous.toTick = event.occurredTick;
    } else groups.push({ actor, action, target, messageKind, events: [event], fromTick: event.occurredTick, toTick: event.occurredTick });
    actionGroupsByActor.set(actor, groups);
  });
  const changeGroups = new Map<string, { civ: Civilization; identity: CivilizationIdentity; fromTick: number; toTick: number; health: number; resources: number; technology: number; eventIds: string[] }>();
  for (const [tick, tickEvents] of byTick) {
    const commit = tickEvents.find((event) => event.kind === 'commit' || event.kind === 'genesis' || event.kind === 'initialization');
    const tickWorld = tick === world.tick ? world : stateFrame(history, tick);
    result.push({ id: `observer-round-${tick}`, tick, kind: 'round', title: `第 ${tick} 轮`, text: roundText(tick, commit, tickWorld ?? world), eventIds: tickEvents.filter((event) => TECHNICAL_KINDS.has(event.kind)).map((event) => event.eventId), civilizationIds: [] });
    tickEvents.filter((event) => MAJOR_KINDS.has(event.kind)).forEach((event) => result.push({ id: `observer-major-${event.eventId}`, tick, kind: 'major', title: event.kind === 'attack-launched' || event.kind === 'attack-arrived' || event.kind === 'attack-impact' ? '重大攻击' : '重要变化', text: majorText(event, identities), eventIds: [event.eventId], civilizationIds: event.participants }));
    if (tickWorld) {
      tickWorld.civilizations.forEach((civ) => {
        const previousWorld = stateFrame(history, tick - 1);
        const previous = previousWorld?.civilizations.find((item) => item.id === civ.id);
        if (!previous) return;
        const health = civ.health - previous.health;
        const resources = civ.resources - previous.resources;
        const technology = civ.technology - previous.technology;
        if (health === 0 && resources === 0 && technology === 0) return;
        const bucket = Math.floor(Math.max(0, tick - 1) / 5);
        const key = `${civ.id}:${bucket}`;
        const prior = changeGroups.get(key) ?? { civ, identity: identities[civ.id], fromTick: tick, toTick: tick, health: 0, resources: 0, technology: 0, eventIds: [] };
        prior.toTick = tick;
        prior.health += health; prior.resources += resources; prior.technology += technology;
        prior.eventIds.push(...tickEvents.filter((event) => event.participants.includes(civ.id)).map((event) => event.eventId));
        changeGroups.set(key, prior);
      });
    }
  }
  changeGroups.forEach((group) => {
    const parts = ([['健康', group.health], ['储备', group.resources], ['研究', group.technology] ] as [string, number][]).filter(([, value]) => Math.abs(Math.round(value * 10) / 10) >= 0.05).map(([label, value]) => `${label} ${signed(value)}`);
    if (!parts.length) return;
    result.push({ id: `observer-change-${group.civ.id}-${group.fromTick}-${group.toTick}`, tick: group.toTick, fromTick: group.fromTick, toTick: group.toTick, kind: 'change', title: group.fromTick === group.toTick ? '状态变化' : '近几轮变化', text: group.fromTick === group.toTick ? `${group.identity.label}本轮${parts.join('，')}` : `${group.identity.label}近 ${group.toTick - group.fromTick + 1} 轮：${parts.join('，')}`, eventIds: [...new Set(group.eventIds)], civilizationIds: [group.civ.id] });
  });
  [...actionGroupsByActor.values()].flat().forEach((group) => {
    if (group.action === 'contact' || group.action === 'broadcast') return;
    const first = group.events[0];
    const identity = identities[group.actor]?.label ?? group.actor;
    const actionLabelText = actionLabel(group.action, group.messageKind);
    result.push({ id: `observer-action-${first.eventId}`, tick: group.toTick, fromTick: group.fromTick, toTick: group.toTick, kind: 'action', title: group.events.length > 1 ? '连续行动' : '文明行动', text: group.events.length > 1 ? `${identity}连续 ${group.events.length} 轮${actionLabelText}${group.target ? `（目标${identities[group.target]?.label ?? group.target}）` : ''}` : actionText(first, identities, group.target, group.messageKind), eventIds: group.events.map((event) => event.eventId), civilizationIds: [group.actor] });
  });
  const contacts = new Map<string, { from: string; to: string; count: number; eventIds: string[]; tick: number }>();
  const broadcasts = new Map<string, { from: string; count: number; eventIds: string[]; tick: number }>();
  historicalContacts(world, history, events).forEach(({ mode, from, to, tick, eventIds }) => {
    if (mode === 'broadcast') {
      const prior = broadcasts.get(from) ?? { from, count: 0, eventIds: [], tick };
      broadcasts.set(from, { from, count: prior.count + 1, eventIds: [...prior.eventIds, ...eventIds], tick: Math.max(prior.tick, tick) });
      return;
    }
    if (!to) return;
    const key = `${from}:${to}`;
    const prior = contacts.get(key) ?? { from, to, count: 0, eventIds: [], tick };
    contacts.set(key, { from, to, count: prior.count + 1, eventIds: [...prior.eventIds, ...eventIds], tick: Math.max(prior.tick, tick) });
  });
  contacts.forEach((contact) => result.push({ id: `observer-contact-${contact.from}-${contact.to}`, tick: contact.tick, kind: 'contact', title: '联络摘要', text: `${identities[contact.from]?.label ?? contact.from}向${identities[contact.to]?.label ?? contact.to}发出 ${contact.count} 次联络`, eventIds: contact.eventIds, civilizationIds: [contact.from, contact.to] }));
  broadcasts.forEach((broadcast) => result.push({ id: `observer-broadcast-${broadcast.from}`, tick: broadcast.tick, kind: 'broadcast', title: '广播摘要', text: `${identities[broadcast.from]?.label ?? broadcast.from}向周围广播 ${broadcast.count} 次`, eventIds: [...new Set(broadcast.eventIds)], civilizationIds: [broadcast.from] }));
  return result.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}

export function recentCivilizationObservations(world: World, history: HistoryFrame[], civId: string, limit = 4): ObserverTimelineItem[] {
  return projectObserverTimeline(world, history).filter((item) => item.civilizationIds.includes(civId)).slice(-limit).reverse();
}
