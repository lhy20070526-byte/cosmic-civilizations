import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecisions,
  decisionCost,
  evaluateEnd,
  initWorld,
  offlineDecision,
  prepareTick,
  seedPRNG,
  toDecisionRecord,
  validateDecision,
  viewFor,
} from '../src/engine/index';
import type { Decision, KnownContact, World } from '../src/shared/types';

function world(seed = 'engine-test', count = 2): World {
  return initWorld({ seed, civilizationCount: count, maxTicks: 50 });
}

function decision(action: Decision['action'], target: string | null = null, patch: Partial<Decision> = {}): Decision {
  const base: Decision = { action, target, intensity: 0.5, budget: 0, message: null, reason: 'test', ...patch };
  if (base.action !== 'wait' && patch.budget === undefined) base.budget = decisionCost(base);
  return base;
}

function contact(worldState: World, observerIndex: number, targetIndex: number): string {
  const observer = worldState.civilizations[observerIndex];
  const target = worldState.civilizations[targetIndex];
  const contactId = 'contact-test';
  observer.contactMap[contactId] = target.id;
  const known: KnownContact = { contactId, label: 'Contact 1', estimatedPosition: { x: target.position.x - observer.position.x, y: target.position.y - observer.position.y }, uncertainty: 2, observedAt: 0, receivedAt: 0, sourceEventId: 'test-observation', estimatedPower: 20, status: 'active' };
  observer.contacts.push(known);
  return contactId;
}

test('seeded worlds and identical decisions are deterministic', () => {
  const first = world('same', 4);
  const second = world('same', 4);
  assert.deepEqual(first, second);
  for (let i = 0; i < 8; i += 1) {
    const p1 = prepareTick(first, first.rngState);
    const p2 = prepareTick(second, second.rngState);
    const records1 = first.civilizations.map((civ) => toDecisionRecord(civ.id, viewFor(p1.physicalWorld, civ.id), offlineDecision(viewFor(p1.physicalWorld, civ.id), 'same'), 'rules'));
    const records2 = second.civilizations.map((civ) => toDecisionRecord(civ.id, viewFor(p2.physicalWorld, civ.id), offlineDecision(viewFor(p2.physicalWorld, civ.id), 'same'), 'rules'));
    const next1 = applyDecisions(p1, records1);
    const next2 = applyDecisions(p2, records2);
    assert.deepEqual(next1, next2);
    Object.assign(first, next1);
    Object.assign(second, next2);
  }
});

test('view is whitelist isolated and decisions reject global identifiers and extra fields', () => {
  const state = world();
  const view = viewFor(state, state.civilizations[0].id);
  assert.equal('id' in view.self, false);
  assert.equal('position' in view.self, false);
  assert.equal('civilizationId' in view, false);
  assert.equal(validateDecision(view, decision('wait')), true);
  assert.equal(validateDecision(view, { ...decision('wait'), extra: 'leak' }), false);
  assert.equal(validateDecision(view, decision('strike', 'civ-2')), false);
});

test('costs are bounded and actions never make resources negative', () => {
  const state = world();
  state.civilizations[0].resources = 0;
  const pending = prepareTick(state, state.rngState);
  const civ = pending.physicalWorld.civilizations[0];
  const d = decision('develop');
  const record = toDecisionRecord(civ.id, viewFor(pending.physicalWorld, civ.id), d);
  const next = applyDecisions(pending, [record]);
  assert.ok(next.civilizations[0].resources >= 0);
  assert.ok(next.civilizations.every((candidate) => candidate.resources >= 0));
  assert.equal(decisionCost(d), 13);
});

test('same-tick attacks are launched from frozen views and damage aggregates', () => {
  const state = world('mutual', 2);
  const aContact = contact(state, 0, 1);
  const bContact = contact(state, 1, 0);
  const pending = prepareTick(state, state.rngState);
  const records = pending.physicalWorld.civilizations.map((civ, index) => {
    const target = index === 0 ? aContact : bContact;
    const view = viewFor(pending.physicalWorld, civ.id);
    return toDecisionRecord(civ.id, view, decision('strike', target, { intensity: 1 }));
  });
  const launched = applyDecisions(pending, records);
  assert.equal(launched.transits.filter((transit) => transit.kind === 'attack').length, 2);
  assert.equal(launched.civilizations.every((candidate) => candidate.alive), true);
  assert.ok(launched.civilizations.every((candidate) => candidate.health <= 100));
});

test('estimated aim error can miss, and same-tick defense cannot alter frozen strike damage', () => {
  const accurate = world('frozen-defense');
  const accurateTarget = contact(accurate, 0, 1);
  const pending = prepareTick(accurate, accurate.rngState);
  const strike = toDecisionRecord(pending.physicalWorld.civilizations[0].id, viewFor(pending.physicalWorld, pending.physicalWorld.civilizations[0].id), decision('strike', accurateTarget, { intensity: 1 }));
  const defend = toDecisionRecord(pending.physicalWorld.civilizations[1].id, viewFor(pending.physicalWorld, pending.physicalWorld.civilizations[1].id), decision('defend', null, { intensity: 1 }));
  const both = applyDecisions(pending, [defend, strike]);
  const attackOnly = applyDecisions(pending, [strike]);
  assert.equal(both.transits.find((transit) => transit.kind === 'attack')?.payload.damage, attackOnly.transits.find((transit) => transit.kind === 'attack')?.payload.damage);
  assert.ok(both.civilizations[1].defense > attackOnly.civilizations[1].defense);

  const missWorld = world('frozen-aim');
  const missContact = contact(missWorld, 0, 1);
  const missPending = prepareTick(missWorld, missWorld.rngState);
  const missCiv = missPending.physicalWorld.civilizations[0];
  const known = missCiv.contacts.find((candidate) => candidate.contactId === missContact)!;
  known.estimatedPosition = { x: known.estimatedPosition!.x + 100, y: known.estimatedPosition!.y + 100 };
  const missRecord = toDecisionRecord(missCiv.id, viewFor(missPending.physicalWorld, missCiv.id), decision('strike', missContact, { intensity: 1 }));
  const missed = applyDecisions(missPending, [missRecord]);
  assert.equal(missed.transits.find((transit) => transit.kind === 'attack')?.payload.hit, false);
});

test('an in-flight attack still resolves after its attacker dies, and health damage is non-lethal', () => {
  const state = world('dead-transit');
  const target = contact(state, 0, 1);
  const pending = prepareTick(state, state.rngState);
  const attacker = pending.physicalWorld.civilizations[0];
  const record = toDecisionRecord(attacker.id, viewFor(pending.physicalWorld, attacker.id), decision('strike', target, { intensity: 0.2 }));
  let next = applyDecisions(pending, [record]);
  // Isolate flight persistence from the separately tested seeded hit probability.
  next.transits.find(t=>t.kind==='attack')!.payload.damage=20;
  next.civilizations[0].alive = false;
  next.civilizations[0].health = 0;
  const before = next.civilizations[1].health;
  for (let i = 0; i < 8 && next.transits.some((transit) => transit.kind === 'attack'); i += 1) next = applyDecisions(prepareTick(next, next.rngState), []);
  assert.ok(next.civilizations[1].health < before);
  assert.equal(next.civilizations[0].alive, false);
  assert.equal(next.civilizations[0].observations.some((event) => event.kind === 'attack-impact'), false);
});

test('offline policy stays valid across a real 50 civilization, 50 tick run', () => {
  let state = world('large', 50);
  for (let i = 0; i < 50; i += 1) {
    const pending = prepareTick(state, state.rngState);
    const records = pending.physicalWorld.civilizations.filter((civ) => civ.alive).map((civ) => {
      const view = viewFor(pending.physicalWorld, civ.id);
      const next = offlineDecision(view, `large-${i}`);
      assert.equal(validateDecision(view, next), true);
      return toDecisionRecord(civ.id, view, next, 'rules');
    });
    state = applyDecisions(pending, records);
    assert.ok(state.civilizations.every((civ) => civ.resources >= 0 && civ.health >= 0));
  }
  assert.equal(state.tick, 50);
  assert.ok(state.events.length > 0);
});

test('end evaluation keeps a pending attack alive until the threat resolves', () => {
  const state = world('end');
  state.civilizations[1].alive = false;
  state.transits.push({ id: 'pending-attack', kind: 'attack', fromId: state.civilizations[1].id, toId: state.civilizations[0].id, launchedAt: 0, arrivesAt: 5, payload: { damage: 20 } });
  assert.deepEqual(evaluateEnd(state, 20), { ended: false, reason: null });
  state.transits = [];
  assert.deepEqual(evaluateEnd(state, 20), { ended: true, reason: 'last-civilization' });
  assert.deepEqual(evaluateEnd(state, 0), { ended: true, reason: 'last-civilization' });
});

test('PRNG state is explicit and repeatable', () => {
  const a = seedPRNG('rng');
  const b = seedPRNG('rng');
  assert.deepEqual(a, b);
});


test('simultaneous lethal impacts aggregate and both civilizations die independent of transit ordering',()=>{
 const w=world('mutual-real');for(const c of w.civilizations){c.health=10;c.defense=0;}
 w.transits=w.civilizations.map((c,i)=>({id:`attack-${i}`,kind:'attack' as const,fromId:c.id,toId:w.civilizations[1-i].id,launchedAt:0,arrivesAt:1,payload:{damage:20}}));
 const reversed=structuredClone(w);reversed.transits.reverse();
 const a=prepareTick(w).physicalWorld,b=prepareTick(reversed).physicalWorld;
 assert.deepEqual(a,b);assert.ok(a.civilizations.every(c=>!c.alive&&c.health===0));
 assert.equal(a.events.filter(e=>e.kind==='civilization-destroyed').length,2);
});

test('cooperation reserves both principals, returns them after delayed acceptance and grants bounded research',()=>{
 let w=world('cooperation-complete');w.civilizations[0].position={x:10,y:10};w.civilizations[1].position={x:12,y:10};
 const local=contact(w,0,1);const initialTotal=w.civilizations.reduce((n,c)=>n+c.resources,0);
 let p=prepareTick(w);const proposer=p.physicalWorld.civilizations[0];
 const proposal=decision('cooperate',local,{message:{kind:'proposal',replyTo:null,text:'research'}});
 w=applyDecisions(p,[toDecisionRecord(proposer.id,viewFor(p.physicalWorld,proposer.id),proposal)]);
 assert.equal(w.cooperations[0].escrow?.[proposer.id],6);assert.equal(w.civilizations[0].technology,10);
 p=prepareTick(w);const receiver=p.physicalWorld.civilizations[1],incoming=receiver.proposals[0];
 assert.equal(incoming.status,'pending');
 const accept=decision('cooperate',incoming.contactId,{message:{kind:'accept',replyTo:incoming.proposalId,text:'accept'}});
 w=applyDecisions(p,[toDecisionRecord(receiver.id,viewFor(p.physicalWorld,receiver.id),accept)]);
 assert.equal(w.cooperations[0].status,'pending');assert.equal(w.cooperations[0].escrow?.[receiver.id],6);
 for(let i=0;i<3;i++)w=applyDecisions(prepareTick(w),[]);
 assert.equal(w.tick,5);assert.equal(w.cooperations[0].status,'settled');assert.deepEqual(w.cooperations[0].escrow,{});
 assert.ok(w.civilizations.every(c=>c.technology===12));
 assert.equal(w.civilizations.reduce((n,c)=>n+c.resources,0),initialTotal+5*2*3.5-(decisionCost(proposal)-6)-(decisionCost(accept)-6));
 assert.ok(w.civilizations.every(c=>c.proposals[0].status==='settled'));
});

test('a received warning permits a full decision before the earliest possible impact',()=>{
 const w=world('warning-window');w.civilizations[0].position={x:5,y:5};w.civilizations[1].position={x:10,y:5};w.civilizations[1].recon=100;
 const local=contact(w,0,1),p=prepareTick(w),attacker=p.physicalWorld.civilizations[0];
 const launched=applyDecisions(p,[toDecisionRecord(attacker.id,viewFor(p.physicalWorld,attacker.id),decision('strike',local))]);
 const attack=launched.transits.find(t=>t.kind==='attack')!,warning=launched.transits.find(t=>t.kind==='warning')!;
 assert.ok(warning.arrivesAt<attack.arrivesAt);
 const beforeImpact=prepareTick(launched).physicalWorld;assert.equal(beforeImpact.civilizations[1].health,100);
 assert.ok(viewFor(beforeImpact,beforeImpact.civilizations[1].id).observations.some(e=>e.kind==='attack-warning'));
 const event=beforeImpact.events.find(e=>e.eventId===warning.payload.sourceEventId)!;
 assert.ok(event.observations[0].observedTick>event.occurredTick);
});

test('simultaneous salvage shares a finite site without order dependence or duplication',()=>{
 const w=world('site-sharing');w.sites[0].resources=10;
 w.transits=w.civilizations.map((c,i)=>({id:`salvage-${i}`,kind:'salvage' as const,fromId:c.id,toId:c.id,launchedAt:0,arrivesAt:1,payload:{siteId:w.sites[0].id,damage:20}}));
 const rev=structuredClone(w);rev.transits.reverse();const a=prepareTick(w).physicalWorld,b=prepareTick(rev).physicalWorld;
 assert.deepEqual(a,b);assert.equal(a.sites[0].resources,0);assert.ok(a.civilizations.every(c=>c.resources===128.5));
});
