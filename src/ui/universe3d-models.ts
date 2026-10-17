export const CIVILIZATION_SHAPE_NAMES = [
  '海洋行星',
  '冰封行星',
  '熔岩行星',
  '环形居住带',
  '轨道站群',
  '双星系统',
  '多行星系统',
  '旋臂星系',
  '小行星蜂群',
  '戴森阵列',
  '棱晶构造体',
  '中空星港',
] as const;

export type CivilizationShape = typeof CIVILIZATION_SHAPE_NAMES[number];

// Conservative visual envelopes for the builders. They include every
// decoration and the selected 1.14x viewer scale is applied by the layout.
export const CIVILIZATION_SHAPE_EXTENTS = [2.52, 1.55, 1.42, 2.15, 2.48, 1.82, 2.82, 2.86, 2.38, 2.12, 1.72, 1.92] as const;

export type ShapeCivilization = { id: string; name: string; position?: { x: number; y: number } };

export type CivilizationShapeProfile = {
  index: number;
  name: CivilizationShape;
  slot: number;
  variant: number;
  rotation: number;
  extentMultiplier: number;
};

function hashString(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** A stable run/name fingerprint used only to rotate the shape catalogue. */
export function civilizationShapeRotation(civilizations: ShapeCivilization[]): number {
  const fingerprint = [...civilizations]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((civ) => `${civ.id}:${civ.name}`)
    .join('|');
  return hashString(fingerprint) % CIVILIZATION_SHAPE_NAMES.length;
}

/** Stable slot ordering; a dead civilization keeps its slot in history. */
export function civilizationShapePlan(civilizations: ShapeCivilization[]): Map<string, CivilizationShapeProfile> {
  const rotation = civilizationShapeRotation(civilizations);
  const ordered = [...civilizations].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return new Map(ordered.map((civ, slot) => {
    const index = positiveModulo(slot + rotation, CIVILIZATION_SHAPE_NAMES.length);
    const variant = Math.floor(slot / CIVILIZATION_SHAPE_NAMES.length);
    return [civ.id, {
      index,
      name: CIVILIZATION_SHAPE_NAMES[index],
      slot,
      variant,
      rotation,
      extentMultiplier: CIVILIZATION_SHAPE_EXTENTS[index],
    }];
  }));
}

/** Legacy seed-only helper remains deterministic for geometry fixtures. */
export function civilizationShapeIndex(seed: number, slot?: number, rotation = 0): number {
  if (typeof slot !== 'number') return Math.abs(seed) % CIVILIZATION_SHAPE_NAMES.length;
  return positiveModulo(slot + rotation, CIVILIZATION_SHAPE_NAMES.length);
}

export function civilizationShapeProfile(seed: number, slot: number, rotation = 0): CivilizationShapeProfile {
  const index = civilizationShapeIndex(seed, slot, rotation);
  return {
    index,
    name: CIVILIZATION_SHAPE_NAMES[index],
    slot,
    variant: Math.floor(slot / CIVILIZATION_SHAPE_NAMES.length),
    rotation,
    extentMultiplier: CIVILIZATION_SHAPE_EXTENTS[index],
  };
}

export function civilizationShapeName(seed: number, profile?: Pick<CivilizationShapeProfile, 'index'>): CivilizationShape {
  return CIVILIZATION_SHAPE_NAMES[profile?.index ?? civilizationShapeIndex(seed)];
}

export function civilizationShapeExtentMultiplier(seed: number, profile?: Pick<CivilizationShapeProfile, 'extentMultiplier'>): number {
  return profile?.extentMultiplier ?? CIVILIZATION_SHAPE_EXTENTS[civilizationShapeIndex(seed)];
}
