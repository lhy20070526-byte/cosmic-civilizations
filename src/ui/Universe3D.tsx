import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Civilization, Point, ResourceSite, Transit, World, WorldEvent } from '../shared/types';
import { civilizationIdentity } from './observer';
import { computePackedLayout, MIN_GALAXY_ORBIT_RADIUS, RING_INNER_RADIUS, RING_OUTER_RADIUS, SATELLITE_ORBIT_RADIUS, SATELLITE_RADIUS, SYSTEM_CHILD_LAYOUT } from './universe3d-layout';
import { CIVILIZATION_SHAPE_NAMES, civilizationShapeExtentMultiplier, civilizationShapePlan, type CivilizationShapeProfile } from './universe3d-models';
import './universe3d.css';

export interface Universe3DProps {
  world: World;
  selectedId: string | null;
  onSelect: (id: string) => void;
  running: boolean;
  reducedMotion?: boolean;
  playbackRate?: number;
  inactiveLabel?: string;
}

type Palette = { surface: string; accent: string; deep: string; atmosphere: string; emissive: string };
type ModelRecord = { key: string; group: THREE.Group; center: THREE.Vector3; radius: number; extent: number; localBounds: THREE.Box3; civId: string };
type LabelRecord = { civId: string; element: HTMLButtonElement };
type CameraMode = 'rotate' | 'pan';

const PALETTES: Palette[] = [
  { surface: '#1c74a8', accent: '#66d7d2', deep: '#071a40', atmosphere: '#54d6ff', emissive: '#041c36' },
  { surface: '#c97840', accent: '#f0c474', deep: '#361c1c', atmosphere: '#ffb067', emissive: '#27100b' },
  { surface: '#b8e3f4', accent: '#eaffff', deep: '#315e8c', atmosphere: '#b8efff', emissive: '#091e35' },
  { surface: '#7c2d25', accent: '#fc8f4b', deep: '#240d13', atmosphere: '#ff5c48', emissive: '#3e0e08' },
  { surface: '#dfb34d', accent: '#c879d9', deep: '#302053', atmosphere: '#e8a6ff', emissive: '#2b1a3e' },
  { surface: '#b87c44', accent: '#5f3e26', deep: '#211516', atmosphere: '#ffcf88', emissive: '#1b0e08' },
];

const TRANSIT_COLORS: Record<string, number> = {
  attack: 0xff5f66,
  warning: 0xffb84e,
  message: 0x5be7ff,
  broadcast: 0x5be7ff,
  proposal: 0xffd36a,
  accept: 0xffd36a,
  reject: 0xff8d74ff,
  'cooperation-result': 0xffd36a,
  salvage: 0x77e2a6,
  environment: 0xff8c55,
};

const COMMUNICATION_KINDS = new Set(['message', 'broadcast', 'proposal', 'accept', 'reject', 'cooperation-result']);

function isCommunicationKind(kind: string): boolean {
  return COMMUNICATION_KINDS.has(kind);
}

function hashString(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function seeded(civ: Pick<Civilization, 'id' | 'name' | 'position'>): number {
  return hashString(`${civ.id}:${civ.name}:${civ.position.x.toFixed(3)}:${civ.position.y.toFixed(3)}`);
}

function unit(seed: number, offset: number): number {
  return ((Math.imul(seed ^ (offset * 0x9e3779b9), 1664525) + 1013904223) >>> 0) / 4294967296;
}

function boxCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const { min, max } = bounds;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function modelWorldBounds(model: ModelRecord): THREE.Box3 {
  model.group.updateWorldMatrix(true, false);
  return model.localBounds.clone().applyMatrix4(model.group.matrixWorld);
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const item of materials) {
      const textured = item as THREE.Material & { map?: THREE.Texture };
      textured.map?.dispose();
      item.dispose();
    }
  });
}

function canvasTexture(seed: number, palette: Palette, gas = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建行星表面纹理');
  const image = context.createImageData(canvas.width, canvas.height);
  const base = new THREE.Color(palette.surface);
  const accent = new THREE.Color(palette.accent);
  const deep = new THREE.Color(palette.deep);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      const wave = Math.sin((x + seed % 37) * 0.08) * 0.18 + Math.sin((y + seed % 19) * 0.17) * 0.12;
      const noise = unit(seed, x * 13 + y * 31) * 0.28 + wave;
      const color = new THREE.Color();
      if (gas) {
        color.lerpColors(deep, accent, Math.max(0, Math.min(1, 0.42 + noise + Math.sin(y * 0.3) * 0.17)));
      } else if (noise < -0.02) {
        color.lerpColors(deep, base, Math.max(0, Math.min(1, 0.58 + noise)));
      } else {
        color.lerpColors(base, accent, Math.max(0, Math.min(1, 0.42 + noise)));
      }
      image.data[index] = Math.round(color.r * 255);
      image.data[index + 1] = Math.round(color.g * 255);
      image.data[index + 2] = Math.round(color.b * 255);
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createAtmosphere(radius: number, palette: Palette, opacity = 0.22): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius * 1.14, 32, 20);
  const material = new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false });
  return new THREE.Mesh(geometry, material);
}

function addCloudBands(group: THREE.Group, radius: number, palette: Palette, seed: number): void {
  const cloudMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, transparent: true, opacity: 0.18, roughness: 0.95, depthWrite: false });
  for (let index = 0; index < 2; index += 1) {
    const cloud = new THREE.Mesh(new THREE.TorusGeometry(radius * (0.74 + index * 0.07), radius * 0.038, 6, 48), cloudMaterial.clone());
    cloud.rotation.x = Math.PI / 2 + (unit(seed, index + 51) - 0.5) * 0.5;
    cloud.rotation.z = (unit(seed, index + 61) - 0.5) * 0.7;
    cloud.userData = { detail: 'cloud-band' };
    group.add(cloud);
  }
}

function addCraters(group: THREE.Group, radius: number, palette: Palette, seed: number, count: number): void {
  const craterMaterial = new THREE.MeshStandardMaterial({ color: palette.deep, roughness: 1, metalness: 0 });
  for (let index = 0; index < count; index += 1) {
    const theta = unit(seed, 80 + index) * Math.PI * 2;
    const phi = 0.35 + unit(seed, 100 + index) * 1.7;
    const crater = new THREE.Mesh(new THREE.SphereGeometry(radius * (0.07 + unit(seed, 120 + index) * 0.05), 10, 6), craterMaterial.clone());
    crater.position.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)).multiplyScalar(radius * 0.97);
    crater.scale.set(1.5, 0.28, 1.5);
    crater.lookAt(0, 0, 0);
    crater.userData = { detail: 'crater' };
    group.add(crater);
  }
}

function addSatellite(group: THREE.Group, radius: number, palette: Palette, seed: number, variant = 0): void {
  const orbit = new THREE.Group();
  orbit.rotation.set(unit(seed, 140) * 0.5, unit(seed, 141) * Math.PI * 2, unit(seed, 142) * 0.4);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(radius * SATELLITE_RADIUS, 18, 12), new THREE.MeshStandardMaterial({ color: '#b6b5af', roughness: 0.82, metalness: 0.03, map: canvasTexture(seed ^ 0x3333, { ...palette, surface: '#8b8c8c', accent: '#d1d0c7', deep: '#303235', atmosphere: '#d7d7d7', emissive: '#050505' }) }));
  moon.position.set(radius * (SATELLITE_ORBIT_RADIUS + variant * 0.04), radius * (0.42 + (variant % 2) * 0.06), 0);
  moon.userData = { detail: 'satellite' };
  orbit.add(moon);
  const orbitLine = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.18, radius * 0.004, 4, 64), new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity: 0.12 }));
  orbitLine.rotation.x = Math.PI / 2;
  orbit.add(orbitLine);
  group.add(orbit);
}

function addRing(group: THREE.Group, radius: number, palette: Palette, seed: number): void {
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * RING_INNER_RADIUS, radius * RING_OUTER_RADIUS, 96), new THREE.MeshStandardMaterial({ color: palette.accent, transparent: true, opacity: 0.42, side: THREE.DoubleSide, roughness: 0.8, metalness: 0.06 }));
  ring.rotation.x = Math.PI / 2 + (unit(seed, 160) - 0.5) * 0.5;
  ring.rotation.z = unit(seed, 161) * Math.PI;
  ring.userData = { detail: 'ring-system' };
  group.add(ring);
}

function addIceCaps(group: THREE.Group, radius: number, palette: Palette, seed: number, variant = 0): void {
  const capMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.16, roughness: 0.7, transparent: true, opacity: 0.9 });
  for (const sign of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.7, 24, 12), capMaterial.clone());
    cap.position.y = sign * radius * 0.71;
    cap.scale.set(0.92, 0.22, 0.92);
    cap.userData = { detail: 'ice-cap' };
    group.add(cap);
  }
  const crackMaterial = new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity: 0.78 });
  for (let index = 0; index < 3 + variant; index += 1) {
    const crack = new THREE.Mesh(new THREE.TorusGeometry(radius * (0.42 + index * 0.08), radius * 0.018, 5, 32), crackMaterial.clone());
    crack.rotation.x = Math.PI / 2;
    crack.rotation.z = unit(seed, 410 + index) * Math.PI;
    crack.position.y = radius * (0.2 - index * 0.16);
    crack.userData = { detail: 'ice-fracture' };
    group.add(crack);
  }
  const shardMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.atmosphere, emissiveIntensity: 0.34, roughness: 0.42, metalness: 0.08 });
  for (let index = 0; index < 3; index += 1) {
    const angle = (index / 3) * Math.PI * 2 + unit(seed, 405 + index) * 0.4;
    const shard = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.16, radius * 0.52, 6), shardMaterial.clone());
    shard.position.set(Math.cos(angle) * radius * 0.13, radius * 1.08, Math.sin(angle) * radius * 0.13);
    shard.rotation.z = (unit(seed, 415 + index) - 0.5) * 0.22;
    shard.userData = { detail: 'ice-spire' };
    group.add(shard);
  }
}

function addLavaFeatures(group: THREE.Group, radius: number, palette: Palette, seed: number, variant = 0): void {
  const lavaMaterial = new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const volcanoMaterial = new THREE.MeshStandardMaterial({ color: palette.deep, emissive: palette.accent, emissiveIntensity: 0.5, roughness: 0.9 });
  const lavaBelt = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.07, radius * 0.045, 6, 48), lavaMaterial);
  lavaBelt.rotation.x = Math.PI / 2 + (unit(seed, 430) - 0.5) * 0.35;
  lavaBelt.userData = { detail: 'lava-belt' };
  group.add(lavaBelt);
  for (let index = 0; index < 3 + variant; index += 1) {
    const angle = unit(seed, 440 + index) * Math.PI * 2;
    const volcano = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.12, radius * 0.36, 8), volcanoMaterial.clone());
    volcano.position.set(Math.cos(angle) * radius * 0.62, radius * 0.88, Math.sin(angle) * radius * 0.62);
    volcano.userData = { detail: 'volcano' };
    group.add(volcano);
    const vent = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.06, 8, 6), lavaMaterial.clone());
    vent.position.copy(volcano.position).add(new THREE.Vector3(0, radius * 0.18, 0));
    vent.userData = { detail: 'lava-vent' };
    group.add(vent);
  }
}

/**
 * A small rounded orbital module used by the ring, station, and starport
 * silhouettes.  Keeping the cabin on a cylindrical hull makes these systems
 * read as spacecraft/architecture at panorama scale instead of repeated
 * brown cubes.
 */
function createStreamlinedModule(radius: number, palette: Palette, bodyColor = palette.surface): THREE.Group {
  const module = new THREE.Group();
  const hullMaterial = new THREE.MeshStandardMaterial({ color: bodyColor, emissive: palette.accent, emissiveIntensity: 0.14, metalness: 0.68, roughness: 0.34 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.18, metalness: 0.82, roughness: 0.28 });
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.115, radius * 0.13, radius * 0.36, 12), hullMaterial);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.14, radius * 0.022, 6, 20), trimMaterial);
  collar.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.12, radius * 0.2, 10), trimMaterial.clone());
  nose.position.y = radius * 0.27;
  const tail = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.11, 12, 8), hullMaterial.clone());
  tail.position.y = -radius * 0.19;
  module.add(hull, collar, nose, tail);
  module.userData = { detail: 'streamlined-module' };
  return module;
}

function addHabitatRing(group: THREE.Group, radius: number, palette: Palette, seed: number, variant = 0): void {
  const orbit = new THREE.Group();
  orbit.rotation.x = Math.PI / 2 + (unit(seed, 460) - 0.5) * 0.24;
  orbit.rotation.z = unit(seed, 461) * Math.PI;
  const ringRadius = radius * (1.62 + variant * 0.025);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ringRadius, radius * (0.14 + (variant % 2) * 0.02), 10, 64), new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.22, metalness: 0.55, roughness: 0.4 }));
  ring.userData = { detail: 'habitat-ring' };
  orbit.add(ring);
  const podCount = 8 + variant * 2;
  for (let index = 0; index < podCount; index += 1) {
    const angle = (index / podCount) * Math.PI * 2;
    const pod = createStreamlinedModule(radius, palette);
    pod.position.set(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, 0);
    pod.rotation.z = angle - Math.PI / 2;
    pod.userData = { detail: 'habitat-pod' };
    orbit.add(pod);
  }
  group.add(orbit);
}

function addStationCluster(group: THREE.Group, radius: number, palette: Palette, seed: number, variant = 0): void {
  const stationMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.18, metalness: 0.8, roughness: 0.3 });
  const stationCount = 5 + variant;
  for (let index = 0; index < stationCount; index += 1) {
    const angle = (index / stationCount) * Math.PI * 2 + unit(seed, 480 + index) * 0.25;
    const station = new THREE.Group();
    station.position.set(Math.cos(angle) * radius * 1.9, (unit(seed, 490 + index) - 0.5) * radius * 0.4, Math.sin(angle) * radius * 1.9);
    const core = createStreamlinedModule(radius, palette, palette.accent);
    core.rotation.z = angle - Math.PI / 2;
    const dockingRing = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.18, radius * 0.024, 6, 20), stationMaterial.clone());
    dockingRing.rotation.x = Math.PI / 2;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.025, radius * 0.025, radius * 0.5, 6), stationMaterial.clone());
    mast.rotation.z = Math.PI / 2;
    station.add(core, dockingRing, mast);
    station.userData = { detail: 'orbital-station' };
    group.add(station);
  }
}

function addBinaryStars(group: THREE.Group, radius: number, palette: Palette, seed: number, variant = 0): void {
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.45, radius * 0.022, 6, 48), new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity: 0.24 }));
  orbit.rotation.x = Math.PI / 2;
  orbit.userData = { detail: 'binary-orbit' };
  group.add(orbit);
  for (const sign of [-1, 1]) {
    const sun = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.62, 28, 18), new THREE.MeshBasicMaterial({ color: sign < 0 ? palette.accent : palette.atmosphere, transparent: true, opacity: 0.95 }));
    sun.position.set(sign * radius * (0.68 + variant * 0.03), (unit(seed, 510 + sign) - 0.5) * radius * 0.16, 0);
    sun.userData = { detail: 'binary-star' };
    group.add(sun);
    const glow = createAtmosphere(radius * 0.62, palette, 0.18);
    glow.position.copy(sun.position);
    glow.userData = { detail: 'binary-atmosphere' };
    group.add(glow);
  }
}

function addAsteroidSwarm(group: THREE.Group, radius: number, palette: Palette, seed: number, variant: number): void {
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.38, 1), new THREE.MeshStandardMaterial({ color: palette.deep, roughness: 0.94, metalness: 0.08 }));
  core.userData = { detail: 'swarm-core' };
  group.add(core);
  const rockMaterial = new THREE.MeshStandardMaterial({ color: palette.surface, emissive: palette.emissive, emissiveIntensity: 0.12, roughness: 0.9, metalness: 0.12 });
  const count = 10 + variant;
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * Math.PI * 2 + unit(seed, 610 + index) * 0.34;
    const orbitRadius = radius * (1.02 + unit(seed, 630 + index) * 0.78);
    const size = radius * (0.11 + unit(seed, 650 + index) * 0.13);
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), rockMaterial.clone());
    rock.position.set(Math.cos(angle) * orbitRadius, (unit(seed, 670 + index) - 0.5) * radius * 0.72, Math.sin(angle) * orbitRadius);
    rock.rotation.set(unit(seed, 680 + index), unit(seed, 690 + index), unit(seed, 700 + index));
    rock.userData = { detail: 'asteroid-fragment' };
    group.add(rock);
  }
}

function addDysonArray(group: THREE.Group, radius: number, palette: Palette, seed: number, variant: number): void {
  const star = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.42, 24, 16), new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity: 0.95 }));
  star.userData = { detail: 'dyson-star' };
  group.add(star);
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.05, radius * 0.025, 6, 64), new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity: 0.3 }));
  orbit.rotation.x = Math.PI / 2;
  orbit.userData = { detail: 'dyson-orbit' };
  group.add(orbit);
  const panelMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.25, metalness: 0.78, roughness: 0.32 });
  const count = 8 + variant * 2;
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * Math.PI * 2 + unit(seed, 720 + index) * 0.16;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(radius * 0.62, radius * 0.44), panelMaterial.clone());
    panel.material.side = THREE.DoubleSide;
    panel.position.set(Math.cos(angle) * radius * 1.42, (unit(seed, 740 + index) - 0.5) * radius * 0.28, Math.sin(angle) * radius * 1.42);
    panel.lookAt(0, 0, 0);
    panel.userData = { detail: 'dyson-panel' };
    group.add(panel);
  }
}

function addPrismaticConstruct(group: THREE.Group, radius: number, palette: Palette, seed: number, variant: number): void {
  const material = new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.38, metalness: 0.34, roughness: 0.28 });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(radius * 0.78, 1), material.clone());
  core.rotation.set(unit(seed, 760) * 0.4, unit(seed, 761) * Math.PI, unit(seed, 762) * 0.4);
  core.userData = { detail: 'prism-core' };
  group.add(core);
  const count = 4 + variant;
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * Math.PI * 2 + unit(seed, 770 + index) * 0.25;
    const shard = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.16, radius * (0.9 + unit(seed, 790 + index) * 0.35), 5), material.clone());
    shard.position.set(Math.cos(angle) * radius * 0.92, (unit(seed, 810 + index) - 0.5) * radius * 0.4, Math.sin(angle) * radius * 0.92);
    shard.lookAt(0, 0, 0);
    shard.userData = { detail: 'prism-spire' };
    group.add(shard);
  }
}

function addHollowStarport(group: THREE.Group, radius: number, palette: Palette, seed: number, variant: number): void {
  const orbit = new THREE.Group();
  orbit.rotation.x = Math.PI / 2 + (unit(seed, 830) - 0.5) * 0.28;
  orbit.rotation.z = unit(seed, 831) * Math.PI;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.22, radius * 0.25, 12, 72), new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.emissive, emissiveIntensity: 0.3, metalness: 0.72, roughness: 0.3 }));
  ring.userData = { detail: 'starport-ring' };
  orbit.add(ring);
  const count = 4 + variant;
  for (let index = 0; index < count; index += 1) {
    const angle = index / count * Math.PI * 2;
    const module = createStreamlinedModule(radius, palette, palette.surface);
    module.position.set(Math.cos(angle) * radius * 1.22, Math.sin(angle) * radius * 1.22, 0);
    module.rotation.z = angle - Math.PI / 2;
    module.userData = { detail: 'starport-module' };
    orbit.add(module);
  }
  group.add(orbit);
}

function createPlanet(civ: Civilization, position: THREE.Vector3, seed: number, palette: Palette, profile: CivilizationShapeProfile): ModelRecord {
  const group = new THREE.Group();
  group.position.copy(position);
  const shapeIndex = profile.index;
  const shapeName = profile.name;
  group.userData = { civId: civ.id, name: civ.name, modelType: shapeName, modelTypeIndex: shapeIndex };
  const radius = 1.52 + unit(seed, 1) * 0.75;
  const gas = shapeIndex === 7 || shapeIndex === 5 || seed % 7 === 0;
  const hasPrimaryBody = ![5, 8, 9, 10, 11].includes(shapeIndex);
  if (hasPrimaryBody) {
    const body = new THREE.Mesh(new THREE.SphereGeometry(radius, 42, 28), new THREE.MeshStandardMaterial({ map: canvasTexture(seed, palette, gas), roughness: gas ? 0.66 : 0.92, metalness: gas ? 0.02 : 0.04, emissive: palette.emissive, emissiveIntensity: gas ? 0.12 : 0.06 }));
    body.userData = { civId: civ.id, detail: 'primary-body' };
    group.add(body);
    group.add(createAtmosphere(radius, palette, gas ? 0.12 : 0.14));
    addCloudBands(group, radius, palette, seed);
    if (!gas) addCraters(group, radius, palette, seed, 4 + (seed % 3));
  }
  if (shapeIndex === 0) addSatellite(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 1) addIceCaps(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 2) addLavaFeatures(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 3) addHabitatRing(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 4) addStationCluster(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 5) addBinaryStars(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 6) {
    const childLayouts = [...SYSTEM_CHILD_LAYOUT, { x: 0.1, y: 2.45, z: -0.3, radius: 0.34 }, { x: -0.35, y: -2.25, z: -0.2, radius: 0.3 }, { x: 0.55, y: 0.1, z: 2.3, radius: 0.28 }, { x: -2.05, y: 0.25, z: -1, radius: 0.25 }];
    const childCount = Math.min(childLayouts.length, 2 + profile.variant);
    for (let index = 0; index < childCount; index += 1) {
      const layout = childLayouts[index];
      const child = new THREE.Mesh(new THREE.SphereGeometry(radius * layout.radius, 24, 16), new THREE.MeshStandardMaterial({ map: canvasTexture(seed ^ (index * 0x17af), PALETTES[(seed + index + 2) % PALETTES.length]), roughness: 0.84 }));
      child.position.set(layout.x * radius, layout.y * radius, layout.z * radius);
      child.userData = { civId: civ.id, detail: 'system-body' };
      group.add(child);
    }
  }
  if (shapeIndex === 7) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.34, 24, 16), new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.88 }));
    core.userData = { civId: civ.id, detail: 'galaxy-core' };
    group.add(core);
    const satelliteCount = 6 + profile.variant;
    for (let index = 0; index < satelliteCount; index += 1) {
      const angle = (index / satelliteCount) * Math.PI * 2 + unit(seed, 180 + index) * 0.35;
      // Keep every satellite outside the primary body's surface, including
      // the largest 0.23r satellite at the minimum orbit radius.
      const orbitRadius = radius * (MIN_GALAXY_ORBIT_RADIUS + unit(seed, 200 + index) * 1.15);
      const satellite = new THREE.Mesh(new THREE.SphereGeometry(radius * (0.12 + unit(seed, 220 + index) * 0.11), 14, 10), new THREE.MeshStandardMaterial({ color: PALETTES[(index + seed) % PALETTES.length].accent, roughness: 0.68 }));
      satellite.position.set(Math.cos(angle) * orbitRadius, (unit(seed, 240 + index) - 0.5) * radius * 0.6, Math.sin(angle) * orbitRadius);
      satellite.userData = { civId: civ.id, detail: 'galaxy-body' };
      group.add(satellite);
    }
  }
  if (shapeIndex === 8) addAsteroidSwarm(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 9) addDysonArray(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 10) addPrismaticConstruct(group, radius, palette, seed, profile.variant);
  if (shapeIndex === 11) addHollowStarport(group, radius, palette, seed, profile.variant);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.2, 24, 16), new THREE.MeshBasicMaterial({ color: palette.atmosphere, transparent: true, opacity: 0.035, side: THREE.BackSide, depthWrite: false }));
  halo.userData = { civId: civ.id, detail: 'rim-halo' };
  group.add(halo);
  // The extent is the actual visual envelope, including moons, rings and child bodies.
  // Layout and framing use this value so decorative geometry cannot cross another civ.
  const extentMultiplier = civilizationShapeExtentMultiplier(seed, profile);
  group.userData.visualExtent = radius * extentMultiplier;
  group.updateWorldMatrix(true, true);
  const localBounds = new THREE.Box3().setFromObject(group);
  localBounds.min.sub(position);
  localBounds.max.sub(position);
  return { key: `${civ.id}:${civ.name}:${civ.position.x}:${civ.position.y}:shape-${profile.index}:variant-${profile.variant}:rotation-${profile.rotation}`, group, center: position.clone(), radius, extent: radius * extentMultiplier, localBounds, civId: civ.id };
}

function mapPosition(point: Point): THREE.Vector3 {
  return new THREE.Vector3((Number(point.x) - 50) * 0.42, 0, (Number(point.y) - 50) * 0.42);
}

function estimatedExtent(civ: Pick<Civilization, 'id' | 'name' | 'position'>, profile: CivilizationShapeProfile): number {
  const seed = seeded(civ);
  const radius = 1.52 + unit(seed, 1) * 0.75;
  return radius * civilizationShapeExtentMultiplier(seed, profile);
}

function computeViewerLayout(civilizations: Civilization[], shapePlan: Map<string, CivilizationShapeProfile>): Map<string, THREE.Vector3> {
  const positions = computePackedLayout(civilizations, {
    // selected civilizations scale to 1.14; reserve that envelope for every
    // item so selection cannot reintroduce an overlap.
    extent: (civ) => estimatedExtent(civ, shapePlan.get(civ.id) ?? { index: 0, name: CIVILIZATION_SHAPE_NAMES[0], slot: 0, variant: 0, rotation: 0, extentMultiplier: 2.52 }) * 1.14,
    gap: 2.4,
  });
  return new Map(civilizations.map((civ) => {
    const point = positions.get(civ.id)!;
    return [civ.id, new THREE.Vector3(point.x, 1.2 + unit(seeded(civ), 300) * 3.8, point.z)];
  }));
}

function addOrientedCone(group: THREE.Group, position: THREE.Vector3, direction: THREE.Vector3, color: number, size: number, userData: Record<string, unknown>): THREE.Mesh {
  const geometry = new THREE.ConeGeometry(size * 0.42, size * 1.5, 8);
  // Put the cone base at the curve point so the projectile visibly leaves the muzzle.
  geometry.translate(0, size * 0.75, 0);
  const cone = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.96 }));
  cone.position.copy(position);
  cone.userData = userData;
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  group.add(cone);
  return cone;
}

function lineForTransit(from: THREE.Vector3, to: THREE.Vector3, color: number, transit: Transit): THREE.Group {
  const group = new THREE.Group();
  group.userData = { transitId: transit.id, kind: transit.kind, visualType: 'transit' };
  const midpoint = from.clone().lerp(to, 0.5);
  midpoint.y += from.distanceTo(to) < 0.1 ? 1.2 : Math.min(6, 2 + from.distanceTo(to) * 0.06);
  const curve = new THREE.QuadraticBezierCurve3(from, midpoint, to);
  const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(36));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: transit.kind === 'attack' ? 0.86 : 0.5 }));
  line.userData = { transitId: transit.id, kind: transit.kind, visualType: 'trajectory' };
  group.add(line);
  const attack = transit.kind === 'attack';
  const communication = isCommunicationKind(transit.kind);
  const salvage = transit.kind === 'salvage';
  const pulse = attack
    ? addOrientedCone(group, from.clone(), to.clone().sub(from), color, 0.7, { transitId: transit.id, kind: transit.kind, curve, pulse: true, visualType: 'projectile' })
    : new THREE.Mesh(salvage ? new THREE.OctahedronGeometry(0.34, 0) : new THREE.SphereGeometry(communication ? 0.16 : 0.12, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
  if (!attack) {
    pulse.userData = { transitId: transit.id, kind: transit.kind, curve, pulse: true, flow: communication ? 'communication' : undefined, phase: 0, visualType: salvage ? 'salvage-shuttle' : communication ? 'signal-packet' : 'transit-packet' };
    group.add(pulse);
    if (communication) {
      const particleCount = transit.kind === 'broadcast' ? 7 : 5;
      for (let index = 0; index < particleCount; index += 1) {
        const particle = new THREE.Mesh(new THREE.IcosahedronGeometry(transit.kind === 'broadcast' ? 0.11 : 0.095, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.86, blending: THREE.AdditiveBlending, depthWrite: false }));
        particle.position.copy(from);
        particle.userData = { transitId: transit.id, kind: transit.kind, curve, pulse: true, flow: 'communication', phase: (index + 1) / (particleCount + 1), visualType: 'communication-particle' };
        group.add(particle);
      }
    }
  }
  if (attack) {
    const direction = to.clone().sub(from).normalize();
    // The source is already outside the selected planet's envelope. Keep the
    // whole barrel visible and make the muzzle read as a weapon at close range.
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.58, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffc46c, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    muzzle.position.copy(from);
    muzzle.userData = { transitId: transit.id, visualType: 'muzzle-flash' };
    group.add(muzzle);
    const cannonMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa9bc, metalness: 0.86, roughness: 0.28, transparent: true, opacity: 0.98 });
    const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 1.1, 10), cannonMaterial);
    cannon.position.copy(from).addScaledVector(direction, -0.55);
    cannon.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    cannon.userData = { transitId: transit.id, visualType: 'cannon' };
    group.add(cannon);
    const cannonBand = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.06, 8, 20), new THREE.MeshStandardMaterial({ color: 0x58687c, metalness: 0.92, roughness: 0.24, transparent: true, opacity: 0.98 }));
    cannonBand.position.copy(from).addScaledVector(direction, -0.87);
    cannonBand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    cannonBand.userData = { transitId: transit.id, visualType: 'cannon-band' };
    group.add(cannonBand);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.19, 0.18, 12), new THREE.MeshBasicMaterial({ color: 0xffb15c, transparent: true, opacity: 0.98, blending: THREE.AdditiveBlending, depthWrite: false }));
    nozzle.position.copy(from).addScaledVector(direction, -0.03);
    nozzle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    nozzle.userData = { transitId: transit.id, visualType: 'muzzle-nozzle' };
    group.add(nozzle);
  }
  if (communication) {
    const ringCount = transit.kind === 'broadcast' ? 3 : transit.kind === 'cooperation-result' ? 2 : 1;
    for (let index = 0; index < ringCount; index += 1) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28 + index * 0.16, 0.025, 6, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.68, depthWrite: false }));
      ring.position.copy(from);
      ring.rotation.x = Math.PI / 2;
      ring.userData = { transitId: transit.id, visualType: 'signal-ring', ringIndex: index };
      group.add(ring);
    }
  }
  return group;
}

function transitColor(kind: string): number {
  return TRANSIT_COLORS[kind] ?? 0x9aa7c7;
}

function sitePosition(site: ResourceSite, civ?: Civilization): THREE.Vector3 {
  return mapPosition(site.position).setY(0.9 + (hashString(site.id) % 17) * 0.07);
}

function flashForEvent(event: WorldEvent, models: Map<string, ModelRecord>, world: World): THREE.Group | null {
  const kind = event.kind.toLowerCase();
  const action = typeof event.facts?.action === 'string' ? event.facts.action : '';
  const major = /attack|strike|impact|environment|disaster|death|destroy|collision|salvage|transmission|message|broadcast|cooperation|site-discovery/.test(kind) || (kind.includes('decision-applied') && action !== 'wait') || (Boolean(action) && action !== 'wait');
  const causalKinds = event.causalEventIds.map((id) => world.events.find((candidate) => candidate.eventId === id)?.kind.toLowerCase() ?? '');
  const hasAttackCause = causalKinds.some((candidate) => candidate === 'attack-launched' || candidate.includes('attack-launch'));
  const attackHit = hasAttackCause && Number(event.facts?.damage ?? 0) > 0;
  const attackMiss = hasAttackCause && Number(event.facts?.damage ?? 0) <= 0;
  if (!major) return null;
  const group = new THREE.Group();
  group.userData = { eventId: event.eventId, kind: event.kind };
  let count = 0;
  for (const participant of event.participants) {
    const model = models.get(participant);
    if (!model) continue;
    const isAttackImpact = kind.includes('impact') || kind.includes('attack-result') || kind.includes('destroy') || kind.includes('death');
    const isAttackLaunch = kind.includes('attack-launched') || kind.includes('attack-launch') || kind.includes('strike');
    const isCommunication = kind.includes('transmission') || kind.includes('message') || kind.includes('broadcast') || kind.includes('cooperation') || action === 'contact' || action === 'broadcast' || action === 'cooperate';
    const isExplore = kind.includes('site-discovery') || action === 'explore';
    const isDefend = action === 'defend';
    const isDevelop = action === 'develop';
    const isHide = action === 'hide';
    const isSalvage = kind.includes('salvage') || action === 'salvage';
    const color = isAttackImpact || isAttackLaunch ? 0xff626b : isDefend ? 0x6fd8ff : isDevelop ? 0xffd36a : isCommunication ? 0x5be7ff : isExplore ? 0x9e9cff : isSalvage ? 0x77e2a6 : 0xffb45e;
    if (isAttackImpact && attackHit) {
      const blast = new THREE.Mesh(new THREE.SphereGeometry(model.radius * 0.42, 18, 12), new THREE.MeshBasicMaterial({ color: 0xff8b4d, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false }));
      blast.position.copy(model.center).add(new THREE.Vector3(0, model.radius * 0.92, 0));
      blast.userData = { eventId: event.eventId, visualType: 'impact-blast' };
      group.add(blast);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(model.radius * (isDefend ? 1.2 : isAttackImpact ? 1.18 : 1.06), model.radius * (isDefend ? 1.34 : isAttackImpact ? 1.3 : 1.14), 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.copy(model.center);
    ring.rotation.x = -Math.PI / 2;
    ring.userData = { eventId: event.eventId, kind: event.kind, visualType: isDefend ? 'shield' : 'event-ring' };
    group.add(ring);
    if (isAttackImpact && attackMiss) {
      const missMaterial = new THREE.LineBasicMaterial({ color: 0xff9c68, transparent: true, opacity: 0.82 });
      const crossSize = model.radius * 0.62;
      const miss = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-crossSize, model.radius * 0.25, -crossSize), new THREE.Vector3(crossSize, model.radius * 0.25, crossSize),
        new THREE.Vector3(-crossSize, model.radius * 0.25, crossSize), new THREE.Vector3(crossSize, model.radius * 0.25, -crossSize),
      ]), missMaterial);
      miss.position.copy(model.center);
      miss.userData = { eventId: event.eventId, visualType: 'miss-marker' };
      group.add(miss);
    }
    if (isCommunication) {
      const signal = new THREE.Mesh(new THREE.TorusGeometry(model.radius * 0.7, 0.06, 8, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.74, depthWrite: false }));
      signal.position.copy(model.center).add(new THREE.Vector3(0, model.radius * 1.04, 0));
      signal.rotation.x = Math.PI / 2;
      signal.userData = { eventId: event.eventId, visualType: 'communication-wave' };
      group.add(signal);
    }
    if (isExplore) {
      const scan = new THREE.Mesh(new THREE.RingGeometry(model.radius * 1.45, model.radius * 1.5, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
      scan.position.copy(model.center).setY(model.center.y + model.radius * 0.92);
      scan.rotation.x = -Math.PI / 2;
      scan.userData = { eventId: event.eventId, visualType: 'scan-ring' };
      group.add(scan);
    }
    if (isDevelop) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.22, model.radius * 1.8, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62, depthWrite: false }));
      beam.position.copy(model.center).add(new THREE.Vector3(0, model.radius * 0.8, 0));
      beam.userData = { eventId: event.eventId, visualType: 'build-beam' };
      group.add(beam);
    }
    if (isHide) {
      const veil = new THREE.Mesh(new THREE.SphereGeometry(model.radius * 1.18, 20, 14), new THREE.MeshBasicMaterial({ color: 0x7786a6, transparent: true, opacity: 0.18, side: THREE.BackSide, depthWrite: false }));
      veil.position.copy(model.center);
      veil.userData = { eventId: event.eventId, visualType: 'stealth-veil' };
      group.add(veil);
    }
    if (isSalvage) {
      const transit = world.transits.find((item) => item.payload.launchEventId === event.eventId || (item.kind === 'salvage' && item.launchedAt === event.occurredTick && item.fromId === participant));
      const site = transit?.payload.siteId ? world.sites.find((item) => item.id === transit.payload.siteId) : undefined;
      if (site) {
        const shuttle = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
        shuttle.position.copy(sitePosition(site));
        shuttle.userData = { eventId: event.eventId, visualType: 'salvage-shuttle', siteId: site.id };
        group.add(shuttle);
      }
    }
    count += 1;
  }
  return count ? group : null;
}

export function Universe3D({ world, selectedId, onSelect, running, reducedMotion = false, playbackRate = 1, inactiveLabel = '已暂停 · 轨迹冻结' }: Universe3DProps): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelsRef = useRef(new Map<string, ModelRecord>());
  const transitGroupRef = useRef<THREE.Group | null>(null);
  const flashGroupRef = useRef<THREE.Group | null>(null);
  const labelsRef = useRef<LabelRecord[]>([]);
  const frameRef = useRef<number | null>(null);
  const animateRef = useRef<((time: number) => void) | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const initialOverviewRef = useRef(true);
  const tickClockRef = useRef<{ tick: number; start: number | null; fraction: number }>({ tick: world.tick, start: null, fraction: 0 });
  const communicationClockRef = useRef<{ lastTime: number | null; elapsed: number }>({ lastTime: null, elapsed: 0 });
  const playbackRateRef = useRef(playbackRate);
  const onSelectRef = useRef(onSelect);
  const worldRef = useRef(world);
  const runningRef = useRef(running);
  const reducedMotionRef = useRef(reducedMotion);
  const [cameraMode, setCameraMode] = useState<CameraMode>('rotate');
  const [error, setError] = useState<string | null>(null);

  worldRef.current = world;
  runningRef.current = running;
  reducedMotionRef.current = reducedMotion;
  playbackRateRef.current = playbackRate;
  onSelectRef.current = onSelect;
  if (tickClockRef.current.tick !== world.tick) {
    tickClockRef.current = { tick: world.tick, start: null, fraction: 0 };
  }

  const civilizations = useMemo(() => world.civilizations.filter(Boolean), [world.civilizations]);
  const shapePlan = useMemo(() => civilizationShapePlan(civilizations), [civilizations]);
  // App derives a sorted display event array on every render. Depend on the
  // event identity instead of that wrapper array so status polling, speed
  // changes, and drawer updates do not rebuild live transit meshes.
  const eventVisualKey = useMemo(
    () => world.events.map((event) => `${event.eventId}:${event.occurredTick}:${event.kind}`).join('|'),
    [world.events],
  );
  const transitVisualKey = useMemo(
    () => world.transits.map((transit) => `${transit.id}:${transit.kind}:${transit.fromId}:${transit.toId ?? ''}:${transit.launchedAt}:${transit.arrivesAt}:${transit.payload.siteId ?? ''}`).join('|'),
    [world.transits],
  );
  const activeCommunications = useMemo(
    () => world.transits.filter((transit) => isCommunicationKind(transit.kind) && transit.launchedAt <= world.tick && transit.arrivesAt >= world.tick - 1),
    [world.tick, world.transits],
  );
  const communicationRoutes = useMemo(() => activeCommunications.slice(0, 3).map((transit) => {
    const fromIndex = civilizations.findIndex((civ) => civ.id === transit.fromId);
    const toIndex = civilizations.findIndex((civ) => civ.id === transit.toId);
    const from = civilizations[fromIndex];
    const to = civilizations[toIndex];
    const fromLabel = from ? civilizationIdentity(from, fromIndex).label : transit.fromId;
    const toLabel = to ? civilizationIdentity(to, toIndex).label : transit.toId ?? '周围';
    return `${fromLabel} → ${toLabel}`;
  }).join(' · '), [activeCommunications, civilizations]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      setError('当前设备无法创建 WebGL 3D 场景，可以使用下方文明列表继续查看和选择。');
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x050914, 1);
    renderer.domElement.dataset.renderer = 'three-webgl';
    renderer.domElement.setAttribute('aria-label', '宇宙文明三维视图');
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050914, 0.008);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    camera.position.set(0, 30, 42);
    cameraRef.current = camera;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.enableZoom = true;
    controls.autoRotate = false;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    const refreshView = () => {
      updateDynamic(0);
      render();
    };
    controls.addEventListener('change', refreshView);
    controls.addEventListener('start', () => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
    });
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0x8fa9d8, 0x080b18, 1.35));
    const key = new THREE.DirectionalLight(0xc8ddff, 2.1);
    key.position.set(-30, 36, 22);
    scene.add(key);
    const fill = new THREE.PointLight(0x2f75be, 55, 130, 2);
    fill.position.set(0, 12, 10);
    scene.add(fill);
    const universe = new THREE.Group();
    universe.name = 'civilization-universe';
    scene.add(universe);
    const transits = new THREE.Group();
    transits.name = 'live-transits';
    scene.add(transits);
    transitGroupRef.current = transits;
    const flashes = new THREE.Group();
    flashes.name = 'event-flashes';
    scene.add(flashes);
    flashGroupRef.current = flashes;
    const starsGeometry = new THREE.BufferGeometry();
    const stars = new Float32Array(450 * 3);
    for (let index = 0; index < 450; index += 1) {
      const seed = hashString(`star-${index}`);
      stars[index * 3] = (unit(seed, 1) - 0.5) * 260;
      stars[index * 3 + 1] = (unit(seed, 2) - 0.5) * 150;
      stars[index * 3 + 2] = (unit(seed, 3) - 0.5) * 260;
    }
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(stars, 3));
    const starsPoints = new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0xb8d5ff, size: 0.22, transparent: true, opacity: 0.64, sizeAttenuation: true }));
    starsPoints.userData = { background: true };
    scene.add(starsPoints);

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    let pointerDown = false;
    let pointerMoved = false;
    let pointerStartX = 0;
    let pointerStartY = 0;
    const pointerdown = (event: PointerEvent) => {
      pointerDown = true;
      pointerMoved = false;
      pointerStartX = event.clientX;
      pointerStartY = event.clientY;
    };
    const pointermove = (event: PointerEvent) => {
      if (!pointerDown || pointerMoved) return;
      pointerMoved = Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) > 6;
    };
    const pointerup = () => { pointerDown = false; };
    const click = (event: MouseEvent) => {
      if (pointerMoved) {
        // OrbitControls consumed this gesture as rotate/pan; do not turn the
        // release into an accidental civilization selection.
        pointerMoved = false;
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(universe.children, true);
      const hit = intersections[0];
      let object: THREE.Object3D | null = hit?.object ?? null;
      while (object && typeof object.userData.civId !== 'string') object = object.parent;
      if (object && typeof object.userData.civId === 'string') onSelectRef.current(object.userData.civId);
    };
    renderer.domElement.addEventListener('pointerdown', pointerdown);
    renderer.domElement.addEventListener('pointermove', pointermove);
    renderer.domElement.addEventListener('pointerup', pointerup);
    renderer.domElement.addEventListener('click', click);

    const animate = (time: number) => {
      frameRef.current = null;
      const active = runningRef.current;
      if (active) {
        updateDynamic(time);
        render();
        frameRef.current = requestAnimationFrame(animate);
      } else {
        updateDynamic(0);
        render();
      }
    };
    animateRef.current = animate;
    const renderLoop = () => {
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(animate);
    };
    (renderer.domElement as HTMLCanvasElement).addEventListener('webglcontextlost', () => setError('WebGL 场景已丢失，请刷新或使用下方文明列表继续查看。'));
    (mount as HTMLDivElement).dataset.cameraPosition = `${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)},${camera.position.z.toFixed(2)}`;
    renderLoop();

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
      communicationClockRef.current.lastTime = null;
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerdown);
      renderer.domElement.removeEventListener('pointermove', pointermove);
      renderer.domElement.removeEventListener('pointerup', pointerup);
      renderer.domElement.removeEventListener('click', click);
      controls.removeEventListener('change', refreshView);
      controls.dispose();
      scene.traverse((object) => {
        if (object !== starsPoints) return;
        disposeObject(object);
      });
      disposeObject(universe);
      disposeObject(transits);
      disposeObject(flashes);
      disposeObject(starsPoints);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      animateRef.current = null;
      transitGroupRef.current = null;
      flashGroupRef.current = null;
      modelsRef.current.clear();
      labelsRef.current = [];
      initialOverviewRef.current = true;
    };
    // The setup owns a stable renderer; state updates are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Do not let wall-clock time spent paused advance the next transit frame.
    tickClockRef.current.start = null;
    communicationClockRef.current.lastTime = null;
    if (running && frameRef.current === null && animateRef.current) {
      frameRef.current = requestAnimationFrame(animateRef.current);
    }
  }, [running]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pan = cameraMode === 'pan';
    controls.mouseButtons.LEFT = pan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = pan ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controls.update();
  }, [cameraMode]);

  useEffect(() => {
    communicationClockRef.current.lastTime = null;
  }, [reducedMotion]);

  const render = () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    if (mountRef.current) mountRef.current.dataset.cameraPosition = `${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)},${camera.position.z.toFixed(2)}`;
  };

  const updateDynamic = (time: number) => {
    const worldState = worldRef.current;
    const transits = transitGroupRef.current;
    const models = modelsRef.current;
    if (!transits) return;
    if (runningRef.current && !reducedMotionRef.current && time > 0) {
      const clock = tickClockRef.current;
      if (clock.start === null) clock.start = time - clock.fraction * 850;
      clock.fraction = Math.max(clock.fraction, Math.min(0.92, (time - clock.start) / 850));
      const communicationClock = communicationClockRef.current;
      if (communicationClock.lastTime === null) communicationClock.lastTime = time;
      else {
        const delta = Math.min(80, Math.max(0, time - communicationClock.lastTime));
        communicationClock.elapsed += delta * Math.max(0.25, Math.min(4, playbackRateRef.current));
        communicationClock.lastTime = time;
      }
    }
    const fraction = reducedMotionRef.current ? 0 : tickClockRef.current.fraction;
    for (const object of transits.children) {
      const pulses = object.children.filter((child) => child.userData.pulse) as THREE.Mesh[];
      for (const pulse of pulses) {
        const transitId = pulse.userData.transitId as string | undefined;
        const transit = transitId ? worldState.transits.find((item) => item.id === transitId) : undefined;
        if (!transit) continue;
        const curve = pulse.userData.curve as THREE.QuadraticBezierCurve3;
        const physicsU = Math.max(0, Math.min(0.99, (worldState.tick + fraction - transit.launchedAt) / Math.max(1, transit.arrivesAt - transit.launchedAt)));
        const flow = pulse.userData.flow === 'communication';
        const phase = Number(pulse.userData.phase ?? 0);
        // Communication particles are a continuous, one-way visual stream
        // along this real transit. Their elapsed clock is independent of the
        // tick fraction so a long in-flight message does not freeze at .92.
        const u = flow
          ? (physicsU * 0.18 + (communicationClockRef.current.elapsed * 0.00042 + phase * 0.78) % 0.78)
          : physicsU;
        pulse.position.copy(curve.getPointAt(u));
        if (pulse.userData.visualType === 'projectile') {
          const tangent = curve.getTangentAt(Math.min(0.99, u + 0.01));
          pulse.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent.normalize());
        }
        object.traverse((child) => {
          const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          if (!material) return;
          const materials = Array.isArray(material) ? material : [material];
          for (const item of materials) {
            if (!('opacity' in item) || typeof item.opacity !== 'number') continue;
            if (child.userData.visualType === 'muzzle-flash') item.opacity = Math.max(0.08, 0.9 * (1 - Math.min(1, u * 4)));
            if (child.userData.visualType === 'signal-ring') {
              item.opacity = Math.max(0.15, 0.72 * (1 - Math.min(1, u * 0.9)));
              child.scale.setScalar(0.72 + u * 1.55);
            }
          }
        });
        object.userData.progress = u;
      }
    }
    const flashes = flashGroupRef.current;
    if (flashes) {
      for (const effect of flashes.children) {
        const eventTick = worldState.events.find((item) => item.eventId === effect.userData.eventId)?.occurredTick;
        if (typeof eventTick !== 'number') continue;
        const phase = eventTick === worldState.tick ? fraction : eventTick < worldState.tick ? 1 : 0;
        effect.traverse((child) => {
          const mesh = child as THREE.Mesh;
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (!material) return;
          const materials = Array.isArray(material) ? material : [material];
          for (const item of materials) {
            if ('opacity' in item && typeof item.opacity === 'number') {
              const base = Number(child.userData.baseOpacity ?? item.opacity);
              child.userData.baseOpacity = base;
              item.opacity = Math.max(0.1, base * (eventTick === worldState.tick ? 1 - phase * 0.45 : 0.65));
            }
          }
          if (child.userData.visualType === 'communication-wave') child.scale.setScalar(0.72 + phase * 1.7);
          if (child.userData.visualType === 'scan-ring') child.scale.setScalar(0.78 + phase * 1.55);
          if (child.userData.visualType === 'event-ring' && typeof child.userData.kind === 'string' && child.userData.kind.toLowerCase().includes('impact')) child.scale.setScalar(0.8 + phase * 1.4);
          if (child.userData.visualType === 'miss-marker') child.scale.setScalar(0.86 + phase * 0.24);
        });
        const blast = effect.children.find((child) => child.userData.visualType === 'impact-blast');
        if (blast) blast.scale.setScalar(0.82 + phase * 1.35);
      }
    }
    for (const label of labelsRef.current) {
      const model = models.get(label.civId);
      const camera = cameraRef.current;
      if (!model || !camera || !mountRef.current) continue;
      const projected = model.center.clone().project(camera);
      const x = (projected.x * 0.5 + 0.5) * mountRef.current.clientWidth;
      const y = (-projected.y * 0.5 + 0.5) * mountRef.current.clientHeight;
      // Project the actual mesh envelope. This keeps labels close to irregular
      // silhouettes (rings, swarms, and stations) while leaving a small gap.
      const visualBounds = modelWorldBounds(model);
      const bottomY = boxCorners(visualBounds).reduce((lowest, corner) => {
        const cornerY = (-corner.project(camera).y * 0.5 + 0.5) * mountRef.current!.clientHeight;
        return Math.max(lowest, cornerY);
      }, y);
      label.element.style.left = `${x}px`;
      label.element.style.top = `${bottomY + 8}px`;
      label.element.style.opacity = projected.z > 1 ? '0' : '1';
    }
    const mount = mountRef.current;
    if (mount) {
      const visualTypes = new Set<string>();
      const activeEvents = new Set<string>();
      for (const root of [transits, flashes]) {
        for (const child of root?.children ?? []) {
          if (typeof child.userData.eventId === 'string') activeEvents.add(child.userData.eventId);
          child.traverse((part) => {
            if (typeof part.userData.visualType === 'string') visualTypes.add(part.userData.visualType);
            if (typeof part.userData.eventId === 'string') activeEvents.add(part.userData.eventId);
          });
        }
      }
      mount.dataset.vfxTypes = [...visualTypes].sort().join(',');
      mount.dataset.vfxCount = String(visualTypes.size);
      mount.dataset.activeEvents = [...activeEvents].sort().join(',');
      mount.dataset.signalElapsed = String(Math.round(communicationClockRef.current.elapsed));
      mount.dataset.signalParticles = String([...transits.children].reduce((total, item) => total + item.children.filter((child) => child.userData.visualType === 'communication-particle').length, 0));
      mount.dataset.modelTypes = civilizations.map((civ) => `${civ.id}:${shapePlan.get(civ.id)?.name ?? CIVILIZATION_SHAPE_NAMES[0]}`).join('|');
      if (mount.parentElement) {
        mount.parentElement.dataset.vfxTypes = mount.dataset.vfxTypes;
        mount.parentElement.dataset.vfxCount = mount.dataset.vfxCount;
        mount.parentElement.dataset.activeEvents = mount.dataset.activeEvents;
        mount.parentElement.dataset.signalElapsed = mount.dataset.signalElapsed;
        mount.parentElement.dataset.signalParticles = mount.dataset.signalParticles;
        mount.parentElement.dataset.modelTypes = mount.dataset.modelTypes;
      }
    }
  };

  const cancelCameraMotion = () => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    }
  };

  const moveCamera = (target: THREE.Vector3, destination: THREE.Vector3) => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;
    cancelCameraMotion();
    if (reducedMotionRef.current) {
      camera.position.copy(destination);
      controls.target.copy(target);
      controls.update();
      render();
      return;
    }
    let start: number | null = null;
    const initialPosition = camera.position.clone();
    const initialTarget = controls.target.clone();
    const animateCamera = (time: number) => {
      if (start === null) start = time;
      const progress = Math.min(1, (time - start) / 480);
      const eased = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(initialPosition, destination, eased);
      controls.target.lerpVectors(initialTarget, target, eased);
      controls.update();
      render();
      if (progress < 1) focusFrameRef.current = requestAnimationFrame(animateCamera);
      else focusFrameRef.current = null;
    };
    focusFrameRef.current = requestAnimationFrame(animateCamera);
  };

  const frameAll = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera || modelsRef.current.size === 0) return;
    const worldBounds = new THREE.Box3();
    for (const model of modelsRef.current.values()) {
      worldBounds.union(modelWorldBounds(model));
    }
    const target = worldBounds.getCenter(new THREE.Vector3());
    const corners = boxCorners(worldBounds);
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 0.001) direction.set(0, 0.62, 0.78);
    const forwardFromTarget = direction.normalize();
    const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * Math.max(camera.aspect, 0.1));
    const horizontalTangent = Math.tan(horizontalFov * 0.5) * 0.8;
    const verticalTangent = Math.tan(verticalFov * 0.5) * 0.8;
    let fitDistance = 0;
    for (const corner of corners) {
      const offset = corner.clone().sub(target);
      const depthFromTarget = offset.dot(forwardFromTarget);
      const horizontal = Math.abs(offset.dot(cameraRight)) / Math.max(horizontalTangent, 0.001);
      const vertical = Math.abs(offset.dot(cameraUp)) / Math.max(verticalTangent, 0.001);
      fitDistance = Math.max(fitDistance, depthFromTarget + horizontal, depthFromTarget + vertical);
    }
    // Add a small depth pad for the near plane and keep a comfortable minimum
    // for the selected/compact scenes. There is intentionally no upper cap:
    // dense 50-civilization maps must fit instead of being cropped.
    const destination = target.clone().add(forwardFromTarget.multiplyScalar(Math.max(22, fitDistance + 1.5)));
    moveCamera(target, destination);
  };

  const focusSelected = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const model = selectedId ? modelsRef.current.get(selectedId) : undefined;
    if (!controls || !camera || !model) return;
    const target = model.center.clone();
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 0.001) direction.set(0, 0.62, 0.78);
    direction.normalize();
    const destination = target.clone().add(direction.multiplyScalar(model.radius * 4.8 + 5));
    moveCamera(target, destination);
  };

  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    const universe = scene?.getObjectByName('civilization-universe');
    if (!scene || !renderer || !universe) return;
    const activeIds = new Set(civilizations.map((civ) => civ.id));
    const viewerLayout = computeViewerLayout(civilizations, shapePlan);
    for (const [id, model] of modelsRef.current) {
      if (!activeIds.has(id)) {
        universe.remove(model.group);
        disposeObject(model.group);
        modelsRef.current.delete(id);
      }
    }
    civilizations.forEach((civ) => {
      const seed = seeded(civ);
      const position = viewerLayout.get(civ.id)?.clone() ?? mapPosition(civ.position);
      const profile = shapePlan.get(civ.id);
      if (!profile) return;
      const key = `${civ.id}:${civ.name}:${civ.position.x}:${civ.position.y}:shape-${profile.index}:variant-${profile.variant}:rotation-${profile.rotation}`;
      const existing = modelsRef.current.get(civ.id);
      if (!existing || existing.key !== key) {
        if (existing) {
          universe.remove(existing.group);
          disposeObject(existing.group);
        }
        const model = createPlanet(civ, position, seed, PALETTES[seed % PALETTES.length], profile);
        modelsRef.current.set(civ.id, model);
        universe.add(model.group);
      } else {
        existing.group.position.copy(position);
        existing.center.copy(position);
      }
    });
    for (const model of modelsRef.current.values()) {
      const selected = model.civId === selectedId;
      model.group.scale.setScalar(selected ? 1.14 : 1);
      model.group.traverse((child) => {
        const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (material) {
          for (const item of Array.isArray(material) ? material : [material]) {
            if ('emissiveIntensity' in item && typeof item.emissiveIntensity === 'number') {
              item.emissiveIntensity = selected ? 0.22 : item.emissiveIntensity;
            }
          }
        }
      });
    }
    const transitGroup = transitGroupRef.current;
    if (transitGroup) {
      transitGroup.children.forEach(disposeObject);
      transitGroup.clear();
      const byId = modelsRef.current;
      for (const transit of world.transits) {
        const fromModel = byId.get(transit.fromId);
        const site = transit.kind === 'salvage' && transit.payload.siteId ? world.sites.find((item) => item.id === transit.payload.siteId) : undefined;
        const toModel = transit.toId ? byId.get(transit.toId) : undefined;
        let from = fromModel?.center;
        const rawTo = site ? sitePosition(site) : toModel?.center;
        const to = rawTo?.clone();
        const active = transit.launchedAt <= world.tick && transit.arrivesAt >= world.tick - 1;
        if (!from || !to || transit.kind === 'environment' || !active) continue;
        if (fromModel) {
          const direction = to.clone().sub(from).setY(0);
          if (direction.lengthSq() < 0.001) direction.set(1, 0, 0);
          direction.normalize();
          // Reserve the selected scale for every attack muzzle so a later
          // selection change cannot pull the barrel back into the planet.
          const visualRadius = fromModel.radius * 1.14;
          const sourceOffset = transit.kind === 'attack' ? visualRadius + 1.1 : fromModel.radius * 1.04;
          from = from.clone().addScaledVector(direction, sourceOffset).setY(from.y + Math.max(0.2, fromModel.radius * 0.16));
          if (transit.kind === 'attack' && toModel) {
            to.addScaledVector(direction, -toModel.radius * 0.92).setY(to.y + Math.max(0.16, toModel.radius * 0.12));
          } else if (toModel) {
            to.addScaledVector(direction, -toModel.radius * 0.86).setY(to.y + Math.max(0.12, toModel.radius * 0.08));
          }
        }
        transitGroup.add(lineForTransit(from.clone(), to, transitColor(transit.kind), transit));
      }
    }
    const flashes = flashGroupRef.current;
    if (flashes) {
      flashes.children.forEach(disposeObject);
      flashes.clear();
      const currentEvents = world.events.filter((item) => item.occurredTick === world.tick);
      const attackEvents = currentEvents.filter((item) => /attack|strike|impact|destroy|death/.test(item.kind.toLowerCase()));
      const otherActionEvents = currentEvents.filter((item) => {
        const action = typeof item.facts?.action === 'string' ? item.facts.action : '';
        return action !== '' && action !== 'wait' && !attackEvents.includes(item);
      });
      for (const event of [...attackEvents.slice(-12), ...otherActionEvents.slice(-28)].slice(-40)) {
        const flash = flashForEvent(event, modelsRef.current, world);
        if (flash) flashes.add(flash);
      }
    }
    if (labelLayerRef.current) {
      labelLayerRef.current.replaceChildren();
      labelsRef.current = civilizations.map((civ, index) => {
        const identity = civilizationIdentity(civ, index);
        const shapeName = shapePlan.get(civ.id)?.name ?? CIVILIZATION_SHAPE_NAMES[0];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `universe3d-label ${civ.id === selectedId ? 'is-selected' : ''} ${civ.alive ? '' : 'is-dead'}`;
        button.dataset.civId = civ.id;
        button.textContent = identity.label;
        button.title = `${identity.label} · ${shapeName} · ${identity.secondaryName} · ${civ.alive ? '存活' : '已沉寂'}`;
        button.dataset.modelType = shapeName;
        // Keep the label listener stable across ordinary App polling renders.
        // The latest callback is read from the ref so changing parent function
        // identity cannot tear down and rebuild live transit visuals.
        button.addEventListener('click', () => onSelectRef.current(civ.id));
        labelLayerRef.current?.appendChild(button);
        return { civId: civ.id, element: button };
      });
    }
    if (initialOverviewRef.current && modelsRef.current.size > 0) {
      initialOverviewRef.current = false;
      frameAll();
    }
    updateDynamic(0);
    render();
  }, [civilizations, eventVisualKey, selectedId, shapePlan, transitVisualKey, world.tick]);

  useEffect(() => {
    if (initialOverviewRef.current) return undefined;
    if (!selectedId) return undefined;
    focusSelected();
    return cancelCameraMotion;
  }, [selectedId, reducedMotion]);

  return (
      <section className="universe3d" aria-label="宇宙文明三维视图" data-camera-mode={cameraMode}>
      <div ref={mountRef} className="universe3d-canvas" data-camera-position="" data-renderer="pending" />
      <div ref={labelLayerRef} className="universe3d-label-layer" aria-label="文明标签" />
      <div className="universe3d-hud"><span>{running ? '实时轨迹' : inactiveLabel}</span><span>第 {world.tick} 轮</span><span className="universe3d-layout-note">示意星图 · 展示比例已调整</span><span className="universe3d-communications" title="连续光点表示已有消息仍在传播，不代表新增消息">信号传送中 · {activeCommunications.length} 条通信</span>{communicationRoutes ? <span className="universe3d-communication-routes" title={`连续光点表示已有消息仍在传播，不代表新增消息 · ${communicationRoutes}`}>{communicationRoutes}</span> : null}<span className="universe3d-camera-hint">{cameraMode === 'rotate' ? '左键/单指旋转 · 右键平移' : '左键/单指平移 · 右键平移'} · 滚轮缩放</span><div className="universe3d-actions"><div className="universe3d-camera-mode" role="group" aria-label="相机操作模式"><button type="button" aria-pressed={cameraMode === 'rotate'} className={cameraMode === 'rotate' ? 'is-active' : ''} onClick={() => setCameraMode('rotate')} title="左键或单指拖动旋转视角">旋转</button><button type="button" aria-pressed={cameraMode === 'pan'} className={cameraMode === 'pan' ? 'is-active' : ''} onClick={() => setCameraMode('pan')} title="左键或单指拖动平移视图">平移</button></div><button type="button" onClick={frameAll}>纵览宇宙</button><button type="button" onClick={focusSelected} disabled={!selectedId}>靠近选中文明</button></div></div>
      {error ? <div className="universe3d-fallback" role="alert"><strong>三维场景不可用</strong><p>{error}</p><div className="universe3d-fallback-list">{civilizations.map((civ) => <button key={civ.id} type="button" onClick={() => onSelect(civ.id)}>{civ.name}<span>{civ.alive ? '存活' : '沉寂'}</span></button>)}</div></div> : null}
    </section>
  );
}

