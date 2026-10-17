import test from 'node:test';
import assert from 'node:assert/strict';
import { initWorld } from '../src/engine/index';
import { projectObserverTimeline } from '../src/ui/observer';
import type { Decision, DecisionRecord, HistoryFrame, World, WorldEvent } from '../src/shared/types';

function event(eventId: string, occurredTick: number, action: string, civilizationId: string, observations: WorldEvent['observations'] = []): WorldEvent {
  return { eventId, occurredTick, source: 'engine', participants: [civilizationId], kind: 'decision-applied', summary: `Action ${action} completed.`, facts: { action }, causalEventIds: [], observations };
}

function record(civilizationId: string, action: Decision['action'], target: string | null = null, message: Decision['message'] = null): DecisionRecord {
  return {
    civilizationId,
    view: {} as never,
    decision: { action, target, intensity: 0.5, budget: 0, message, reason: 'test fixture' },
    source: 'rules',
    reservedCost: 0,
    requestId: `request-${civilizationId}-${action}-${target ?? 'none'}`,
  };
}

function frame(world: World, tick: number, decisions: DecisionRecord[]): HistoryFrame {
  const snapshot = structuredClone(world);
  snapshot.tick = tick;
  snapshot.events = [];
  return { tick, world: snapshot, decisions, rngState: structuredClone(snapshot.rngState) };
}

function contactMap(world: World, from: string, ...targets: string[]): void {
  const civ = world.civilizations.find((candidate) => candidate.id === from)!;
  targets.forEach((target, index) => { civ.contactMap[`contact-${index + 2}`] = target; });
}

test('交错文明按 actor、target 合并连续行动，不被其他文明打断', () => {
  const world = initWorld({ seed: 'observer-interleaved', civilizationCount: 3, maxTicks: 50 });
  const [a, b, c] = world.civilizations;
  contactMap(world, a.id, b.id, c.id);
  const events: WorldEvent[] = [];
  const history: HistoryFrame[] = [];
  const actions: Array<[number, string, string, string]> = [
    [1, a.id, 'strike', 'contact-2'], [1, b.id, 'explore', ''],
    [2, a.id, 'strike', 'contact-3'], [2, b.id, 'explore', ''], [2, c.id, 'develop', ''],
    [3, a.id, 'strike', 'contact-3'], [3, b.id, 'explore', ''],
  ];
  for (const tick of [1, 2, 3]) {
    const decisions = actions.filter(([t]) => t === tick).map(([, civilizationId, action, target]) => record(civilizationId, action as Decision['action'], target || null));
    decisions.forEach((decision) => {
      events.push(event(`decision-${tick}-${decision.civilizationId}`, tick, decision.decision.action, decision.civilizationId));
    });
    history.push(frame(world, tick, decisions));
  }
  world.tick = 3;
  world.events = events;
  const items = projectObserverTimeline(world, history);
  const continuousTargeted = items.find((item) => item.kind === 'action' && item.fromTick === 2 && item.toTick === 3 && item.text.includes('目标三号·远岚'));
  assert.ok(continuousTargeted, '同一文明对同一目标的连续行动应合并');
  assert.match(continuousTargeted!.text, /连续 2 轮/);
  assert.equal(items.some((item) => item.kind === 'action' && item.fromTick === 1 && item.toTick === 2 && item.text.includes('目标三号·远岚')), false, '目标变化时不应跨目标合并');
  assert.ok(items.some((item) => item.kind === 'action' && item.text.includes('二号·织巢连续 3 轮扩大观测范围')), '其他文明交错行动也应独立合并');
});

test('联络数量来自历史 contactMap，transit 消失后仍保留且 strike 不计入联络', () => {
  const world = initWorld({ seed: 'observer-contact-history', civilizationCount: 2, maxTicks: 50 });
  const [a, b] = world.civilizations;
  contactMap(world, a.id, b.id);
  const events: WorldEvent[] = [];
  const history: HistoryFrame[] = [];
  for (const tick of [1, 2]) {
    const decision = record(a.id, 'contact', 'contact-2');
    events.push(event(`decision-contact-${tick}`, tick, 'contact', a.id));
    events.push({ ...event(`signal-${tick}`, tick, 'contact', a.id), kind: 'transmission-launched', summary: 'A transmission was launched.' });
    const launchWorld = structuredClone(world);
    launchWorld.tick = tick;
    launchWorld.events = [];
    launchWorld.transits = [{ id: `message-${tick}`, kind: 'message', fromId: a.id, toId: b.id, launchedAt: tick, arrivesAt: tick + 3, payload: { launchEventId: `signal-${tick}` } }];
    history.push(frame(launchWorld, tick, [decision]));
  }
  const strikeDecision = record(a.id, 'strike', 'contact-2');
  events.push(event('decision-strike-3', 3, 'strike', a.id));
  history.push(frame(world, 3, [strikeDecision]));
  world.tick = 3;
  world.events = events;
  world.transits = [];
  const items = projectObserverTimeline(world, history);
  const contact = items.find((item) => item.kind === 'contact');
  assert.ok(contact);
  assert.match(contact!.text, /一号·曙光向二号·织巢发出 2 次联络/);
  assert.equal(contact!.eventIds.includes('signal-1'), true);
  assert.equal(contact!.eventIds.includes('signal-2'), true);
  assert.equal(items.filter((item) => item.kind === 'contact').length, 1, 'strike 不应生成另一条联络摘要');
});

test('合作 accept、reject 会显示实际处理，不误称为发起 proposal', () => {
  const world = initWorld({ seed: 'observer-cooperation-copy', civilizationCount: 2, maxTicks: 50 });
  const [a, b] = world.civilizations;
  contactMap(world, a.id, b.id);
  const decisions: Array<[number, DecisionRecord, string]> = [
    [1, record(a.id, 'cooperate', 'contact-2', { kind: 'proposal', replyTo: null, text: 'proposal' }), 'proposal'],
    [2, record(b.id, 'cooperate', 'contact-2', { kind: 'accept', replyTo: 'proposal-1', text: 'accept' }), 'accept'],
    [3, record(b.id, 'cooperate', 'contact-2', { kind: 'reject', replyTo: 'proposal-2', text: 'reject' }), 'reject'],
  ];
  const history = decisions.map(([tick, decision]) => {
    world.events.push(event(`cooperation-${tick}`, tick, 'cooperate', decision.civilizationId));
    return frame(world, tick, [decision]);
  });
  world.tick = 3;
  const items = projectObserverTimeline(world, history);
  const texts = items.filter((item) => item.kind === 'action').map((item) => item.text);
  assert.ok(texts.some((text) => text.includes('发起了合作请求')));
  assert.ok(texts.some((text) => text.includes('接受了合作提议')));
  assert.ok(texts.some((text) => text.includes('拒绝了合作提议')));
  assert.equal(texts.some((text) => text.includes('接受了合作请求') || text.includes('拒绝了合作请求')), false);
});

test('所有摘要引用已发生事件，未来事件与长浮点数不会进入当前观察', () => {
  const world = initWorld({ seed: 'observer-boundary', civilizationCount: 2, maxTicks: 50 });
  const [a] = world.civilizations;
  const previous = structuredClone(world);
  previous.tick = 0;
  previous.events = [];
  previous.civilizations[0].resources = 100;
  previous.civilizations[0].technology = 10;
  const current = event('decision-1', 1, 'develop', a.id, [{ observerId: world.civilizations[1].id, observedTick: 1, sourceEventId: 'decision-1', summary: '已观察' }, { observerId: world.civilizations[1].id, observedTick: 4, sourceEventId: 'decision-1', summary: '未来才会看到' }]);
  const future = event('decision-4', 4, 'develop', a.id);
  world.tick = 1;
  world.civilizations[0].resources = 99.333333333;
  world.civilizations[0].technology = 11.23456789;
  world.events = [current, future];
  const items = projectObserverTimeline(world, [frame(previous, 0, []), frame(world, 1, [record(a.id, 'develop')])]);
  const eventIds = new Set(world.events.filter((candidate) => candidate.occurredTick <= world.tick).map((candidate) => candidate.eventId));
  for (const item of items) {
    for (const eventId of item.eventIds) {
      assert.equal(eventIds.has(eventId), true, `${item.id} 引用了未来或不存在的事件 ${eventId}`);
    }
  }
  assert.equal(items.some((item) => item.eventIds.includes('decision-4')), false);
  const change = items.find((item) => item.kind === 'change');
  assert.ok(change);
  assert.match(change!.text, /储备 -0\.7/);
  assert.equal(/\d+\.\d{2,}/.test(change!.text), false, `数值不应暴露长浮点：${change!.text}`);
});
