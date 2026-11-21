import type { Rng } from './rng.ts';

/** A cell is addressed by a single index: `y * width + x`. */
export type Cell = number;

const UNREACHABLE = -1;

/**
 * Road graph on a grid. Free cells are nodes; each free cell connects to its
 * free 4-neighbours with an edge of length one. Blocked cells are buildings.
 *
 * Shortest paths come from breadth-first distance fields, one per target cell,
 * computed on first use and cached. A path is recovered by walking downhill on
 * the target's field, with a fixed neighbour order so that ties always resolve
 * the same way.
 */
export class RoadMap {
  readonly width: number;
  readonly height: number;
  readonly blocked: Uint8Array;
  readonly freeCells: readonly Cell[];
  private readonly adjacency: readonly (readonly Cell[])[];
  private readonly fields = new Map<Cell, Int32Array>();

  constructor(width: number, height: number, blocked: Uint8Array) {
    if (blocked.length !== width * height) throw new Error('blocked mask does not match the grid');
    this.width = width;
    this.height = height;
    this.blocked = blocked;
    const free: Cell[] = [];
    const adjacency: Cell[][] = [];
    for (let c = 0; c < blocked.length; c++) {
      const list: Cell[] = [];
      if (blocked[c] === 0) {
        free.push(c);
        const x = c % width;
        const y = (c - x) / width;
        // Fixed order: north, east, south, west.
        if (y > 0 && blocked[c - width] === 0) list.push(c - width);
        if (x < width - 1 && blocked[c + 1] === 0) list.push(c + 1);
        if (y < height - 1 && blocked[c + width] === 0) list.push(c + width);
        if (x > 0 && blocked[c - 1] === 0) list.push(c - 1);
      }
      adjacency.push(list);
    }
    this.freeCells = free;
    this.adjacency = adjacency;
  }

  cell(x: number, y: number): Cell {
    return y * this.width + x;
  }

  x(cell: Cell): number {
    return cell % this.width;
  }

  y(cell: Cell): number {
    return Math.floor(cell / this.width);
  }

  isFree(cell: Cell): boolean {
    return cell >= 0 && cell < this.blocked.length && this.blocked[cell] === 0;
  }

  neighbours(cell: Cell): readonly Cell[] {
    return this.adjacency[cell] ?? [];
  }

  /** Hop distance from every cell to `target` (-1 where there is no route). */
  distanceField(target: Cell): Int32Array {
    let field = this.fields.get(target);
    if (field !== undefined) return field;
    field = new Int32Array(this.blocked.length).fill(UNREACHABLE);
    if (this.isFree(target)) {
      field[target] = 0;
      const queue: Cell[] = [target];
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!;
        const next = field[current]! + 1;
        for (const n of this.adjacency[current]!) {
          if (field[n] === UNREACHABLE) {
            field[n] = next;
            queue.push(n);
          }
        }
      }
    }
    this.fields.set(target, field);
    return field;
  }

  /** Shortest path length in cells, or Infinity when there is no route. */
  distance(from: Cell, to: Cell): number {
    const d = this.distanceField(to)[from];
    return d === undefined || d === UNREACHABLE ? Infinity : d;
  }

  /** The next cell on a shortest path from `from` towards `target`. */
  nextStep(from: Cell, target: Cell): Cell {
    const field = this.distanceField(target);
    const here = field[from];
    if (here === undefined || here === UNREACHABLE)
      throw new Error(`no route from ${from} to ${target}`);
    if (here === 0) return from;
    for (const n of this.adjacency[from]!) {
      if (field[n] === here - 1) return n;
    }
    throw new Error('distance field is inconsistent');
  }

  /** Cells of a shortest path, both ends included. */
  path(from: Cell, to: Cell): Cell[] {
    const cells = [from];
    let current = from;
    while (current !== to) {
      current = this.nextStep(current, to);
      cells.push(current);
    }
    return cells;
  }
}

export interface CityOptions {
  width: number;
  height: number;
  /** Streets run along every `blockPitch`-th row and column. */
  blockPitch?: number;
  /** Share of building blocks opened up into squares. */
  plazaShare?: number;
  /** Share of mid-block street cells closed off. */
  closureShare?: number;
}

/**
 * Generate a city: a regular street grid, a few building blocks opened into
 * squares, and a few street cells closed. Anything cut off from the largest
 * connected area is then blocked, so every free cell can reach every other.
 */
export function generateCity(rng: Rng, options: CityOptions): RoadMap {
  const { width, height } = options;
  const pitch = options.blockPitch ?? 3;
  const plazaShare = options.plazaShare ?? 0.12;
  const closureShare = options.closureShare ?? 0.08;
  const blocked = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x % pitch !== 0 && y % pitch !== 0) blocked[y * width + x] = 1;
    }
  }
  // Open some blocks. One draw per block, in row order.
  for (let by = 0; by < height; by += pitch) {
    for (let bx = 0; bx < width; bx += pitch) {
      if (rng.next() >= plazaShare) continue;
      for (let y = by + 1; y < Math.min(by + pitch, height); y++) {
        for (let x = bx + 1; x < Math.min(bx + pitch, width); x++) blocked[y * width + x] = 0;
      }
    }
  }
  // Close some street cells that are not intersections.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onRow = y % pitch === 0;
      const onColumn = x % pitch === 0;
      if (onRow === onColumn) continue;
      if (rng.next() < closureShare) blocked[y * width + x] = 1;
    }
  }
  keepLargestComponent(width, height, blocked);
  return new RoadMap(width, height, blocked);
}

function keepLargestComponent(width: number, height: number, blocked: Uint8Array): void {
  const label = new Int32Array(blocked.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  let components = 0;
  for (let start = 0; start < blocked.length; start++) {
    if (blocked[start] === 1 || label[start] !== -1) continue;
    const id = components++;
    const queue = [start];
    label[start] = id;
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      const x = c % width;
      const y = (c - x) / width;
      const around = [
        y > 0 ? c - width : -1,
        x < width - 1 ? c + 1 : -1,
        y < height - 1 ? c + width : -1,
        x > 0 ? c - 1 : -1,
      ];
      for (const n of around) {
        if (n >= 0 && blocked[n] === 0 && label[n] === -1) {
          label[n] = id;
          queue.push(n);
        }
      }
    }
    if (queue.length > bestSize) {
      bestSize = queue.length;
      best = id;
    }
  }
  for (let c = 0; c < blocked.length; c++) {
    if (label[c] !== best) blocked[c] = 1;
  }
}

/**
 * Spread `count` sites over the map: the first goes nearest the centre, each
 * following one goes to the free cell farthest (by road) from those already
 * placed. Ties go to the lowest cell index.
 */
export function spreadSites(map: RoadMap, count: number): Cell[] {
  const free = map.freeCells;
  if (free.length === 0 || count <= 0) return [];
  const cx = (map.width - 1) / 2;
  const cy = (map.height - 1) / 2;
  let first = free[0]!;
  let firstScore = Infinity;
  for (const c of free) {
    const score = Math.abs(map.x(c) - cx) + Math.abs(map.y(c) - cy);
    if (score < firstScore) {
      firstScore = score;
      first = c;
    }
  }
  const sites = [first];
  while (sites.length < Math.min(count, free.length)) {
    let best = -1;
    let bestScore = -1;
    for (const c of free) {
      let nearest = Infinity;
      for (const s of sites) nearest = Math.min(nearest, map.distance(c, s));
      if (nearest > bestScore) {
        bestScore = nearest;
        best = c;
      }
    }
    sites.push(best);
  }
  return sites;
}
