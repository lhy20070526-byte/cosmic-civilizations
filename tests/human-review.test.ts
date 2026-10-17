import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, step, humanTurn, submitHumanDecision, runs } from '../src/server/runtime.js';
import { exportArchive, importSnapshot } from '../src/server/snapshot.js';
import { decisionCost } from '../src/engine/index.js';
import type { Decision } from '../src/shared/types.js';

test('independent review: human frozen decisions survive recovery with identical world and no external requests', async () => {
  async function play(recover: boolean) {
    let run = await createRun({ mode: 'offline', civilizationCount: 2, segmentTicks: 3, seed: 'human-recovery-independent', humanCivilizationId: 'civ-1' });
    for (const [index, action] of (['explore', 'develop', 'wait'] as const).entries()) {
      await step(run);
      assert.equal(run.world.tick, index, 'awaiting a human must not commit an incomplete tick');
      if (recover && index === 1) { run = importSnapshot(exportArchive(run)); runs.set(run.id, run); }
      const turn = humanTurn(run);
      assert.equal(turn.waiting, true);
      assert.ok(turn.turnId);
      const d: Decision = { action, intensity: action === 'wait' ? 0 : 0.3, budget: 0, target: null, message: null, reason: '独立验收：按记录提交同一策略。' };
      d.budget = decisionCost(d);
      await submitHumanDecision(run, { turnId: turn.turnId, decision: d });
      if (recover && index === 2) { run = importSnapshot(exportArchive(run)); runs.set(run.id, run); }
      await step(run);
      assert.equal(run.history.at(-1)?.decisions.find(d => d.civilizationId === 'civ-1')?.source, 'human');
      assert.equal(run.usedRequests, 0);
    }
    assert.equal(run.status, 'completed');
    assert.equal(run.narratives.length, 1);
    const reloaded = importSnapshot(exportArchive(run));
    assert.equal(reloaded.humanCivilizationId, 'civ-1');
    return run;
  }
  const continuous = await play(false), resumed = await play(true);
  assert.deepEqual(resumed.world, continuous.world);
  assert.deepEqual(resumed.rngState, continuous.rngState);
  assert.equal(resumed.requestLog.filter(r => r.source === 'human').length, 3);
});

test('independent review: manual attack cannot use spectator true IDs or overdraw resources', async () => {
  const run = await createRun({ mode: 'offline', civilizationCount: 2, segmentTicks: 2, seed: 'human-local-only', humanCivilizationId: 'civ-1' });
  await step(run);
  const turn = humanTurn(run), before = JSON.stringify(run.world);
  await assert.rejects(submitHumanDecision(run, { turnId: turn.turnId, decision: { action: 'strike', target: 'civ-2', intensity: 0.4, budget: 30, message: null, reason: '非法观众目标测试' } }), /校验失败/);
  await assert.rejects(submitHumanDecision(run, { turnId: turn.turnId, decision: { action: 'develop', target: null, intensity: 1, budget: 1000, message: null, reason: '超支测试' } }), /校验失败/);
  assert.equal(JSON.stringify(run.world), before);
  assert.equal(run.usedRequests, 0);
  assert.equal(run.pendingTick?.decisions['civ-1'], undefined);
});
