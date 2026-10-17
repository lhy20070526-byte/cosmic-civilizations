import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePackedLayout,
  geometrySpheresSeparated,
  layoutHasNoOverlap,
  MAX_GALAXY_SATELLITE_RADIUS,
  MIN_GALAXY_ORBIT_RADIUS,
  RING_INNER_RADIUS,
  SATELLITE_ORBIT_RADIUS,
  SATELLITE_RADIUS,
  SYSTEM_CHILD_LAYOUT,
  type LayoutCivilization,
} from '../src/ui/universe3d-layout';

function civilizations(count: number, seed: number): LayoutCivilization[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `civ-${seed}-${index}`,
    name: `Fixture ${seed}-${index}`,
    position: { x: 50, y: 50 },
  }));
}

function extent(civilization: LayoutCivilization): number {
  const index = Number(civilization.id.split('-').at(-1));
  return 2.3 + ((index * 17) % 11) * 0.13;
}

test('dense coincident civilizations receive a deterministic, selected-safe layout', () => {
  for (const count of [12, 50]) {
    for (const seed of [1, 7, 23, 101]) {
      const input = civilizations(count, seed);
      const options = { extent: (civ: LayoutCivilization) => extent(civ) * 1.14, gap: 2.4 };
      const first = computePackedLayout(input, options);
      const second = computePackedLayout(input, options);
      assert.deepEqual([...first.entries()], [...second.entries()]);
      assert.equal(layoutHasNoOverlap(input, first, options), true, `${count} civs seed ${seed}`);
    }
  }
});

test('galaxy satellites have a clear primary-body boundary', () => {
  assert.ok(MIN_GALAXY_ORBIT_RADIUS - MAX_GALAXY_SATELLITE_RADIUS > 1);
});

test('planet, moon, ring and system bodies have non-intersecting envelopes', () => {
  const primary = { x: 0, y: 0, z: 0, radius: 1 };
  assert.ok(SATELLITE_ORBIT_RADIUS - SATELLITE_RADIUS > primary.radius);
  assert.ok(RING_INNER_RADIUS > primary.radius);
  assert.equal(geometrySpheresSeparated([primary, { x: SATELLITE_ORBIT_RADIUS, y: 0.42, z: 0, radius: SATELLITE_RADIUS }]), true);
  assert.equal(geometrySpheresSeparated(SYSTEM_CHILD_LAYOUT.map((body) => body)), true);
  assert.equal(geometrySpheresSeparated([primary, ...SYSTEM_CHILD_LAYOUT]), true);
});

test('different visual envelopes remain separated after selected scaling', () => {
  const input = civilizations(12, 3);
  const options = { extent: (civ: LayoutCivilization) => extent(civ) * 1.14, gap: 2.4 };
  const positions = computePackedLayout(input, options);
  assert.equal(layoutHasNoOverlap(input, positions, options), true);
});
