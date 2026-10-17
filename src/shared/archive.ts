/** Lossless JSON DAG codec. All observations and historical values are retained. */
export type ArchiveNode = ['p', null | boolean | number | string] | ['a', number[]] | ['o', Array<[string, number]>];
export interface Archive { format: 'cosmic-dag-v1'; root: number; nodes: ArchiveNode[]; checksum?: string }
export function isArchive(value: unknown): value is Archive {
  return !!value && typeof value === 'object' && (value as Archive).format === 'cosmic-dag-v1';
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function encodeArchive<T>(value: T): Archive {
  const nodes: ArchiveNode[] = [], intern = new Map<string, number>(), seen = new WeakMap<object, number>(), active = new WeakSet<object>();
  function add(node: ArchiveNode): number {
    const key = JSON.stringify(node), existing = intern.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length; nodes.push(node); intern.set(key, id); return id;
  }
  function visit(input: unknown, depth: number): number {
    if (depth > 90) throw new Error('Archive nesting is too deep');
    if (input === null || input === undefined) return add(['p', null]);
    if (typeof input === 'string' || typeof input === 'boolean') return add(['p', input]);
    if (typeof input === 'number') { if (!Number.isFinite(input)) throw new Error('Archive number is not finite'); return add(['p', input]); }
    if (typeof input !== 'object') throw new Error('Archive contains a non-JSON value');
    const known = seen.get(input); if (known !== undefined) return known;
    if (active.has(input)) throw new Error('Archive cycle'); active.add(input);
    let node: ArchiveNode;
    if (Array.isArray(input)) node = ['a', input.map(item => visit(item, depth + 1))];
    else node = ['o', Object.keys(input).sort().filter(k => (input as Record<string, unknown>)[k] !== undefined).map(k => {
      if (forbidden.has(k)) throw new Error('Archive contains a forbidden key');
      return [k, visit((input as Record<string, unknown>)[k], depth + 1)] as [string,number];
    })];
    active.delete(input); const id = add(node); seen.set(input, id); return id;
  }
  const root = visit(value, 0); return { format: 'cosmic-dag-v1', root, nodes };
}
export function decodeArchive<T = unknown>(raw: unknown): T {
  if (!isArchive(raw) || !Array.isArray(raw.nodes) || raw.nodes.length > 2_000_000 || !Number.isInteger(raw.root) || raw.root < 0 || raw.root >= raw.nodes.length) throw new Error('Invalid archive graph');
  const values: unknown[] = [], depths: number[] = [], costs: number[] = [];
  for (let i = 0; i < raw.nodes.length; i++) {
    const node = raw.nodes[i]; if (!Array.isArray(node) || node.length !== 2) throw new Error('Invalid archive node');
    let depth = 1, cost = 1;
    const child = (id: number) => {
      if (!Number.isInteger(id) || id < 0 || id >= i) throw new Error('Archive forward or circular reference');
      depth = Math.max(depth, depths[id] + 1); cost += costs[id];
      // Bound logical expansion as well as stored size to reject graph bombs.
      if (depth > 90 || cost > 100_000_000) throw new Error('Archive expansion limit exceeded');
      return values[id];
    };
    if (node[0] === 'p') {
      if (!(node[1] === null || typeof node[1] === 'boolean' || typeof node[1] === 'string' || typeof node[1] === 'number') || typeof node[1] === 'number' && !Number.isFinite(node[1])) throw new Error('Invalid archive primitive');
      values.push(node[1]);
    } else if (node[0] === 'a' && Array.isArray(node[1])) values.push(node[1].map(child));
    else if (node[0] === 'o' && Array.isArray(node[1])) {
      const out: Record<string, unknown> = {}, keys = new Set<string>();
      for (const entry of node[1]) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || forbidden.has(entry[0]) || keys.has(entry[0])) throw new Error('Invalid archive object key');
        keys.add(entry[0]); out[entry[0]] = child(entry[1]);
      }
      values.push(out);
    } else throw new Error('Invalid archive node type');
    depths.push(depth); costs.push(cost);
  }
  return values[raw.root] as T;
}
