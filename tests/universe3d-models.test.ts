import test from 'node:test';
import assert from 'node:assert/strict';
import { CIVILIZATION_SHAPE_EXTENTS, CIVILIZATION_SHAPE_NAMES, civilizationShapeExtentMultiplier, civilizationShapeIndex, civilizationShapePlan } from '../src/ui/universe3d-models';

test('civilization shape catalog has twelve stable, named silhouettes', () => {
  assert.equal(CIVILIZATION_SHAPE_NAMES.length, 12);
  assert.equal(new Set(CIVILIZATION_SHAPE_NAMES).size, 12);
  assert.equal(CIVILIZATION_SHAPE_EXTENTS.length, 12);
  for (let seed = 0; seed < 64; seed += 1) {
    assert.equal(civilizationShapeExtentMultiplier(seed), CIVILIZATION_SHAPE_EXTENTS[civilizationShapeIndex(seed)]);
  }
});

test('shape selection is deterministic for stable civilization seeds', () => {
  assert.equal(civilizationShapeIndex(17), civilizationShapeIndex(17));
  assert.equal(civilizationShapeIndex(-17), civilizationShapeIndex(17));
  assert.ok(CIVILIZATION_SHAPE_EXTENTS.every((extent) => Number.isFinite(extent) && extent > 1));
});

test('default twelve civilizations receive unique primary silhouettes', () => {
  const civilizations = Array.from({ length: 12 }, (_, index) => ({ id: `civ-${index + 1}`, name: `文明-${index + 1}` }));
  const plan = civilizationShapePlan(civilizations);
  const profiles = civilizations.map((civ) => plan.get(civ.id)!);
  assert.equal(new Set(profiles.map((profile) => profile.index)).size, 12);
  assert.deepEqual(profiles.map((profile) => profile.variant), Array(12).fill(0));
});

test('fifty civilizations retain stable slots and distinct batch profiles', () => {
  const civilizations = Array.from({ length: 50 }, (_, index) => ({ id: `civ-${index + 1}`, name: `文明-${index + 1}` }));
  const plan = civilizationShapePlan(civilizations);
  const profiles = civilizations.map((civ) => plan.get(civ.id)!);
  assert.equal(new Set(profiles.map((profile) => `${profile.index}:${profile.variant}`)).size, 50);
  assert.equal(profiles[0].rotation, profiles[49].rotation);
  assert.equal(profiles[12].variant, 1);
  assert.equal(profiles[24].variant, 2);
  assert.equal(profiles[48].variant, 4);
  assert.equal(civilizationShapePlan([...civilizations].reverse()).get('civ-17')?.index, profiles[16].index);
});
