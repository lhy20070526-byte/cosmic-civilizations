import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecisions,
  decisionCost,
  initWorld,
  prepareTick,
  toDecisionRecord,
  viewFor,
} from '../src/engine/index';
import { humanMajorCandidates, selectMajorEvents } from '../src/ui/importantEvents';
import type { Decision, KnownContact, World, WorldEvent } from '../src/shared/types';

function decision(action: Decision['action'], target: string | null = null, patch: Partial<Decision> = {}): Decision {
  const result: Decision = { action, target, intensity: 0.5, budget: 0, message: null, reason: 'important-events engine test', ...patch };
  if (result.action !== 'wait' && patch.budget === undefined) result.budget = decisionCost(result);
  return result;
}

function addContact(world: World, observerIndex: number, targetIndex: number, contactId: string): string {
  const observer = world.civilizations[observerIndex];
  const target = world.civilizations[targetIndex];
  observer.contactMap[contactId] = target.id;
  const known: KnownContact = {
    contactId,
    label: `Contact ${targetIndex + 1}`,
    estimatedPosition: { x: target.position.x - observer.position.x, y: target.position.y - observer.position.y },
    uncertainty: 0.5,
    observedAt: world.tick,
    receivedAt: world.tick,
    sourceEventId: 'engine-test-contact',
    estimatedPower: 20,
    status: 'active',
  };
  observer.contacts.push(known);
  return contactId;
}

function applyFor(world: World, civilizationId: string, next: Decision): World {
  const pending = prepareTick(world, world.rngState);
  const view = viewFor(pending.physicalWorld, civilizationId);
  return applyDecisions(pending, [toDecisionRecord(civilizationId, view, next)]);
}

function advance(world: World, count = 1): World {
  let current = world;
  for (let index = 0; index < count; index += 1) current = applyDecisions(prepareTick(current, current.rngState), []);
  return current;
}

function event(world: World, kind: string): WorldEvent {
  const found = world.events.find((candidate) => candidate.kind === kind);
  assert.ok(found, `engine should generate ${kind}`);
  return found;
}

function observerCandidate(source: WorldEvent, labels: Map<string, string>) {
  return {
    event: {
      ...source,
      participants: source.participants.map((id) => labels.get(id) ?? '相关文明'),
      observations: [],
    },
    observedTick: source.observations[0]?.observedTick,
  };
}

function attackWorld(seed: string, hit: boolean): { launched: World; attackerId: string; targetId: string } {
  const world = initWorld({ seed, civilizationCount: 2, maxTicks: 20 });
  world.civilizations[0].position = { x: 5, y: 5 };
  world.civilizations[1].position = { x: 10, y: 5 };
  world.civilizations[1].recon = hit ? 100 : 0;
  const attackerId = world.civilizations[0].id;
  const targetId = world.civilizations[1].id;
  const target = addContact(world, 0, 1, 'contact-target');
  if (!hit) world.civilizations[0].contacts[0].estimatedPosition = { x: 100, y: 100 };
  const launched = applyFor(world, attackerId, decision('strike', target, { intensity: 1 }));
  return { launched, attackerId, targetId };
}

function settleAttack(seed: string, hit: boolean): { world: World; targetId: string } {
  const { launched, targetId } = attackWorld(seed, hit);
  const attack = launched.transits.find((transit) => transit.kind === 'attack');
  assert.ok(attack, 'engine should create an attack transit');
  if (hit) {
    attack.payload.damage = 20;
    launched.civilizations.find((civ) => civ.id === targetId)!.health = 10;
    launched.civilizations.find((civ) => civ.id === targetId)!.defense = 0;
  } else {
    assert.equal(attack.payload.damage, 0, 'miss fixture must be a real zero-damage attack');
  }
  return { world: advance(launched, attack.arrivesAt - launched.tick), targetId };
}

function cooperationWorld(seed: string, accept: boolean): { world: World; proposerId: string; receiverId: string } {
  let world = initWorld({ seed, civilizationCount: 2, maxTicks: 30 });
  world.civilizations[0].position = { x: 10, y: 10 };
  world.civilizations[1].position = { x: 12, y: 10 };
  const proposerId = world.civilizations[0].id;
  const receiverId = world.civilizations[1].id;
  const proposerContact = addContact(world, 0, 1, 'contact-receiver');
  const receiverContact = addContact(world, 1, 0, 'contact-proposer');
  world = applyFor(world, proposerId, decision('cooperate', proposerContact, { intensity: 0.5, message: { kind: 'proposal', replyTo: null, text: 'bounded research exchange' } }));
  world = advance(world);
  if (accept) {
    const incoming = world.civilizations.find((civ) => civ.id === receiverId)!.proposals.find((proposal) => proposal.direction === 'incoming');
    assert.ok(incoming, 'receiver must actually observe the proposal before accepting');
    world = applyFor(world, receiverId, decision('cooperate', receiverContact, { intensity: 0.5, message: { kind: 'accept', replyTo: incoming.proposalId, text: 'accept exchange' } }));
  }
  return { world, proposerId, receiverId };
}

test('engine-delayed warning and impact alerts stay local, factual, and deduplicated', () => {
  const { launched, targetId, attackerId } = attackWorld('major-warning-delay', true);
  const warning = event(launched, 'attack-warning');
  assert.equal(warning.observations.length, 0, 'warning must not be visible before its warning transit arrives');
  assert.equal(humanMajorCandidates(viewFor(launched, targetId)).some((candidate) => candidate.event.kind === 'attack-warning'), false);
  assert.equal(humanMajorCandidates(viewFor(launched, attackerId)).some((candidate) => candidate.event.kind === 'attack-warning'), false);

  const warningWorld = advance(launched);
  const warningAfterDelay = event(warningWorld, 'attack-warning');
  assert.ok(warningAfterDelay.observations[0].observedTick > warningAfterDelay.occurredTick);
  assert.equal(humanMajorCandidates(viewFor(warningWorld, targetId)).some((candidate) => candidate.event.kind === 'attack-warning'), true);
  assert.equal(humanMajorCandidates(viewFor(warningWorld, attackerId)).some((candidate) => candidate.event.kind === 'attack-warning'), false);

  const { world: impactWorld, targetId: impactTarget } = settleAttack('major-impact', true);
  const impact = event(impactWorld, 'attack-impact');
  const destroyed = event(impactWorld, 'civilization-destroyed');
  assert.ok(Number(impact.facts.damage) > 0);
  assert.equal(destroyed.observations[0].observedTick, destroyed.occurredTick);
  const labels = new Map(impactWorld.civilizations.map((civ, index) => [civ.id, `文明${index + 1}`]));
  const observerAlerts = selectMajorEvents('engine-major', [observerCandidate(impact, labels), observerCandidate(destroyed, labels)], new Set());
  assert.ok(observerAlerts.some((alert) => alert.kind === 'attack-impact' && /健康下降/.test(alert.text)));
  assert.ok(observerAlerts.some((alert) => alert.kind === 'civilization-destroyed' && /已灭亡/.test(alert.text)));
  assert.equal(observerAlerts.some((alert) => /civ-\d/.test(alert.text)), false, 'observer alert must not expose engine civilization IDs');

  const received = humanMajorCandidates(viewFor(impactWorld, impactTarget));
  assert.ok(received.some((candidate) => candidate.event.kind === 'attack-impact'));
  assert.ok(received.some((candidate) => candidate.event.kind === 'civilization-destroyed'));
  const otherCiv = impactWorld.civilizations.find((civ) => civ.id !== impactTarget)!;
  assert.equal(humanMajorCandidates(viewFor(impactWorld, otherCiv.id)).some((candidate) => candidate.event.kind === 'civilization-destroyed'), false);
  const seen = new Set(observerAlerts.map((alert) => alert.key));
  assert.deepEqual(selectMajorEvents('engine-major', [observerCandidate(impact, labels), observerCandidate(destroyed, labels)], seen), [], 'closing the same event must not reopen it');
});

test('zero-damage impact does not create a damage alert', () => {
  const { world, targetId } = settleAttack('major-zero-damage', false);
  const impact = event(world, 'attack-impact');
  assert.equal(Number(impact.facts.damage), 0);
  assert.equal(selectMajorEvents('engine-zero', [observerCandidate(impact, new Map())], new Set()).length, 0);
  assert.equal(humanMajorCandidates(viewFor(world, targetId)).some((candidate) => candidate.event.kind === 'attack-impact'), false);
});

test('cooperation dispatch alerts only for nonzero research and remains delayed for the receiver', () => {
  const accepted = cooperationWorld('major-cooperation-positive', true);
  let positive = accepted.world;
  let dispatch = positive.events.find((candidate) => candidate.kind === 'cooperation-result-dispatched');
  for (let index = 0; index < 6 && !dispatch; index += 1) {
    positive = advance(positive);
    dispatch = positive.events.find((candidate) => candidate.kind === 'cooperation-result-dispatched');
  }
  assert.ok(dispatch);
  assert.ok(Number(dispatch.facts.research) > 0);
  assert.equal(dispatch.observations.length, 0, 'dispatch is a real in-transit event until the result arrives');
  const labels = new Map(positive.civilizations.map((civ, index) => [civ.id, `文明${index + 1}`]));
  const positiveObserverAlerts = selectMajorEvents('coop-positive', [observerCandidate(dispatch, labels)], new Set());
  assert.equal(positiveObserverAlerts.length, 1);
  assert.equal(positiveObserverAlerts.some((alert) => /civ-\d/.test(alert.text)), false);
  const receivedWorld = advance(positive);
  assert.ok(humanMajorCandidates(viewFor(receivedWorld, accepted.receiverId)).some((candidate) => candidate.event.kind === 'cooperation-result-dispatched'));

  const expired = cooperationWorld('major-cooperation-zero', false);
  let zero = expired.world;
  let zeroDispatch = zero.events.find((candidate) => candidate.kind === 'cooperation-result-dispatched');
  for (let index = 0; index < 12 && !zeroDispatch; index += 1) {
    zero = advance(zero);
    zeroDispatch = zero.events.find((candidate) => candidate.kind === 'cooperation-result-dispatched');
  }
  assert.ok(zeroDispatch);
  assert.equal(Number(zeroDispatch.facts.research), 0);
  assert.equal(selectMajorEvents('coop-zero', [observerCandidate(zeroDispatch, new Map())], new Set()).length, 0);
  const zeroReceived = advance(zero);
  assert.equal(humanMajorCandidates(viewFor(zeroReceived, expired.receiverId)).some((candidate) => candidate.event.kind === 'cooperation-result-dispatched'), false, 'zero research return must not be called a settled cooperation result');
});
