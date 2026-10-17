import type { VisibleEvent, VisibleView, World, WorldEvent } from '../shared/types';

export type MajorEventCandidate = {
  event: WorldEvent;
  observedTick?: number;
  /** Set only for a candidate already filtered from a local VisibleView. */
  trusted?: boolean;
};

export type MajorAlert = {
  key: string;
  eventId: string;
  occurredTick: number;
  observedTick?: number;
  kind: string;
  text: string;
};

function numberFact(event: WorldEvent, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(event.facts?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function stringFact(event: WorldEvent, ...keys: string[]): string {
  for (const key of keys) {
    const value = event.facts?.[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** Keep the alert surface sparse: routine actions, income and messages do not qualify. */
export function isMajorEvent(event: WorldEvent): boolean {
  if (event.kind === 'attack-warning') return true;
  const status = stringFact(event, 'status', 'cooperationStatus');
  if ((event.kind === 'cooperation-result' || event.kind === 'cooperation') && status === 'settled') return true;
  if (event.kind === 'cooperation-result-dispatched') return (numberFact(event, 'research') ?? 0) > 0;
  if (event.kind === 'attack-impact' || event.kind === 'attack-arrived' || event.kind === 'environment' || event.kind === 'environment-change') {
    const damage = numberFact(event, 'damage', 'healthDelta', 'healthLoss');
    const before = numberFact(event, 'healthBefore');
    const after = numberFact(event, 'healthAfter');
    if (damage !== null && damage > 0) return true;
    if (before !== null && after !== null && after < before) return true;
    if (event.facts?.destroyed === true || event.facts?.dead === true) return true;
  }
  if (event.facts?.destroyed === true || event.facts?.dead === true || event.kind.includes('death') || event.kind.includes('destroy')) return true;
  return false;
}

export function majorEventKey(runId: string, eventId: string): string {
  return `${runId}:${eventId}`;
}

export function selectMajorEvents(runId: string, candidates: MajorEventCandidate[], seen: ReadonlySet<string>): MajorAlert[] {
  const result: MajorAlert[] = [];
  for (const candidate of candidates) {
    const { event, observedTick } = candidate;
    const key = majorEventKey(runId, event.eventId);
    if ((!candidate.trusted && !isMajorEvent(event)) || seen.has(key)) continue;
    result.push({ key, eventId: event.eventId, occurredTick: event.occurredTick, observedTick, kind: event.kind, text: majorEventText(event) });
  }
  return result.sort((a, b) => a.occurredTick - b.occurredTick || a.eventId.localeCompare(b.eventId));
}

export function majorEventText(event: WorldEvent): string {
  const participants = event.participants.length ? event.participants.join('、') : '相关文明';
  if (event.kind === 'attack-warning') return `${participants}收到接近中的轨迹预警。`;
  if (event.kind === 'cooperation-result-dispatched') return event.participants.length ? `${participants}之间的合作结果已发出，等待接收。` : event.summary;
  if (event.kind === 'cooperation-result' || event.kind === 'cooperation') return `${participants}之间的合作已结算。`;
  const damage = numberFact(event, 'damage', 'healthDelta', 'healthLoss');
  if (event.kind === 'environment' || event.kind === 'environment-change') return damage && damage > 0 ? `${participants}受到环境冲击，记录到健康下降。` : `${participants}受到环境冲击。`;
  if (event.facts?.destroyed === true || event.facts?.dead === true || event.kind.includes('death') || event.kind.includes('destroy')) return `${participants}已灭亡。`;
  if (damage !== null && damage > 0) return `${participants}的健康下降了 ${Math.round(damage * 10) / 10}。`;
  return event.summary;
}

export function groupMajorAlerts(alerts: MajorAlert[]): MajorAlert[] {
  const byTick = new Map<number, MajorAlert[]>();
  for (const alert of alerts) byTick.set(alert.observedTick ?? alert.occurredTick, [...(byTick.get(alert.observedTick ?? alert.occurredTick) ?? []), alert]);
  return [...byTick.entries()].sort(([a], [b]) => a - b).map(([tick, group]) => group.length > 1 ? { ...group[0], key: group.map((item) => item.key).join('|'), eventId: group.map((item) => item.eventId).join(','), occurredTick: Math.min(...group.map((item) => item.occurredTick)), observedTick: tick, text: group.map((item) => item.text).join(' ') } : group[0]);
}

function visibleDamage(summary: string): number | null {
  const match = summary.match(/(?:damage|伤害|健康下降|损失)[^\d]*(\d+(?:\.\d+)?)/i) ?? summary.match(/(\d+(?:\.\d+)?)\s*(?:damage|伤害|健康下降|损失)/i);
  const value = match?.[1] ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function visibleResearch(summary: string): number | null {
  const match = summary.match(/technology\s+gain\s+(\d+(?:\.\d+)?)/i) ?? summary.match(/(?:研究收益|研究增加|research)[^\d]*(\d+(?:\.\d+)?)/i);
  const value = match?.[1] ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function visibleIsMajor(event: VisibleEvent): boolean {
  const summary = event.summary.toLowerCase();
  if (event.kind === 'attack-warning') return true;
  if (event.kind === 'civilization-destroyed' || event.kind.includes('death')) return true;
  if (event.kind === 'attack-impact') return (visibleDamage(summary) ?? 0) > 0;
  if (event.kind === 'cooperation-result-dispatched') return (visibleResearch(summary) ?? 0) > 0;
  if (event.kind === 'environment' || event.kind === 'environment-change') return /damage|health|伤害|健康|死亡|destroy|灭亡/.test(summary);
  return false;
}

/** Project only the observer's local observations into alert candidates.
 * No global participants, facts or causal links are copied into this path. */
export function humanMajorCandidates(view: VisibleView): MajorEventCandidate[] {
  return view.observations.filter(visibleIsMajor).map((observation): MajorEventCandidate => {
    const damage = visibleDamage(observation.summary);
    const facts: WorldEvent['facts'] = damage === null ? {} : { damage };
    return {
      event: {
        eventId: observation.sourceEventId,
        occurredTick: observation.occurredTick,
        source: 'engine',
        participants: [],
        kind: observation.kind,
        summary: observation.summary,
        facts,
        causalEventIds: [],
        observations: [],
      },
      observedTick: observation.observedTick,
      trusted: true,
    };
  });
}
