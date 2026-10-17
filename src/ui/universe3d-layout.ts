export type LayoutCivilization = {
  id: string;
  name: string;
  position: { x: number; y: number };
};

export type LayoutPoint = { x: number; y: number; z: number };

export type LayoutOptions = {
  extent: (civilization: LayoutCivilization) => number;
  gap?: number;
  maxPasses?: number;
};

export const MIN_GALAXY_ORBIT_RADIUS = 1.35;
export const MAX_GALAXY_SATELLITE_RADIUS = 0.23;
export const SATELLITE_ORBIT_RADIUS = 2;
export const SATELLITE_RADIUS = 0.29;
export const RING_INNER_RADIUS = 1.22;
export const RING_OUTER_RADIUS = 1.7;
export const SYSTEM_CHILD_LAYOUT = [
  { x: 2.2, y: -0.325, z: -0.55, radius: 0.48 },
  { x: -2.2, y: 0.325, z: 0.8, radius: 0.39 },
] as const;

export type GeometrySphere = { x: number; y: number; z: number; radius: number };

export function geometrySpheresSeparated(spheres: GeometrySphere[], epsilon = 1e-6): boolean {
  for (let first = 0; first < spheres.length; first += 1) {
    for (let second = first + 1; second < spheres.length; second += 1) {
      const a = spheres[first];
      const b = spheres[second];
      const centerDistance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (centerDistance + epsilon < a.radius + b.radius) return false;
    }
  }
  return true;
}

function hashString(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function direction(a: LayoutCivilization, b: LayoutCivilization): { x: number; z: number } {
  const angle = (hashString(`${a.id}|${b.id}`) / 0xffffffff) * Math.PI * 2;
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

function distance(a: LayoutPoint, b: LayoutPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function requiredDistance(a: number, b: number, gap: number): number {
  return a + b + gap;
}

function hasNoOverlap(civilizations: LayoutCivilization[], positions: Map<string, LayoutPoint>, options: LayoutOptions): boolean {
  const gap = options.gap ?? 2.4;
  for (let first = 0; first < civilizations.length; first += 1) {
    for (let second = first + 1; second < civilizations.length; second += 1) {
      const a = civilizations[first];
      const b = civilizations[second];
      const pa = positions.get(a.id);
      const pb = positions.get(b.id);
      if (!pa || !pb || distance(pa, pb) + 1e-6 < requiredDistance(options.extent(a), options.extent(b), gap)) return false;
    }
  }
  return true;
}

function fallbackGrid(civilizations: LayoutCivilization[], options: LayoutOptions): Map<string, LayoutPoint> {
  const ordered = [...civilizations].sort((a, b) => a.id.localeCompare(b.id));
  const gap = options.gap ?? 2.4;
  const cell = Math.max(...ordered.map((civilization) => options.extent(civilization) * 2), 1) + gap;
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / columns);
  const result = new Map<string, LayoutPoint>();
  ordered.forEach((civilization, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    result.set(civilization.id, {
      x: (column - (columns - 1) / 2) * cell,
      y: 0,
      z: (row - (rows - 1) / 2) * cell,
    });
  });
  return result;
}

/**
 * Deterministic viewer-only packing. It never mutates engine coordinates.
 * Relaxation preserves geography when possible; the grid fallback is a proof
 * of separation for dense or coincident inputs because every cell uses the
 * largest padded diameter.
 */
export function computePackedLayout(civilizations: LayoutCivilization[], options: LayoutOptions): Map<string, LayoutPoint> {
  const ordered = [...civilizations].sort((a, b) => a.id.localeCompare(b.id));
  const gap = options.gap ?? 2.4;
  const positions = new Map<string, LayoutPoint>(ordered.map((civilization) => [civilization.id, {
    x: (Number(civilization.position.x) - 50) * 0.42,
    y: 0,
    z: (Number(civilization.position.y) - 50) * 0.42,
  }]));
  const maxPasses = options.maxPasses ?? Math.max(48, ordered.length * 4);
  for (let pass = 0; pass < maxPasses && !hasNoOverlap(ordered, positions, options); pass += 1) {
    for (let first = 0; first < ordered.length; first += 1) {
      for (let second = first + 1; second < ordered.length; second += 1) {
        const a = ordered[first];
        const b = ordered[second];
        const pa = positions.get(a.id)!;
        const pb = positions.get(b.id)!;
        const dx = pb.x - pa.x;
        const dz = pb.z - pa.z;
        const actual = Math.hypot(dx, dz);
        const minimum = requiredDistance(options.extent(a), options.extent(b), gap);
        if (actual + 1e-6 >= minimum) continue;
        const unit = actual > 1e-6 ? { x: dx / actual, z: dz / actual } : direction(a, b);
        const correction = (minimum - Math.max(actual, 1e-6)) * 0.52;
        pa.x -= unit.x * correction;
        pa.z -= unit.z * correction;
        pb.x += unit.x * correction;
        pb.z += unit.z * correction;
      }
    }
  }
  const packed = hasNoOverlap(ordered, positions, options) ? positions : fallbackGrid(ordered, options);
  if (!hasNoOverlap(ordered, packed, options)) throw new Error('viewer layout failed to separate civilization envelopes');
  return packed;
}

export function layoutHasNoOverlap(civilizations: LayoutCivilization[], positions: Map<string, LayoutPoint>, options: LayoutOptions): boolean {
  return hasNoOverlap(civilizations, positions, options);
}
