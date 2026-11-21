import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng.ts';
import { generateCity, RoadMap, spreadSites } from '../src/sim/road-map.ts';

function randomMap(rng: Rng, width: number, height: number, blockedShare: number): RoadMap {
  const blocked = new Uint8Array(width * height);
  for (let c = 0; c < blocked.length; c++) blocked[c] = rng.next() < blockedShare ? 1 : 0;
  return new RoadMap(width, height, blocked);
}

/** All-pairs shortest paths by Floyd-Warshall, as an independent reference. */
function floydWarshall(map: RoadMap): number[][] {
  const n = map.width * map.height;
  const d = Array.from({ length: n }, () => new Array<number>(n).fill(Infinity));
  for (const c of map.freeCells) {
    d[c]![c] = 0;
    for (const nb of map.neighbours(c)) d[c]![nb] = 1;
  }
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const ik = d[i]![k]!;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j++) {
        if (ik + d[k]![j]! < d[i]![j]!) d[i]![j] = ik + d[k]![j]!;
      }
    }
  }
  return d;
}

describe('RoadMap', () => {
  it('matches Floyd-Warshall on random grids', () => {
    const rng = new Rng(2024);
    for (let trial = 0; trial < 25; trial++) {
      const map = randomMap(rng, 3 + rng.int(6), 3 + rng.int(5), 0.3);
      const reference = floydWarshall(map);
      const wrong: [number, number][] = [];
      for (const a of map.freeCells) {
        for (const b of map.freeCells) {
          if (map.distance(a, b) !== reference[a]![b]) wrong.push([a, b]);
        }
      }
      expect(wrong).toEqual([]);
    }
  });

  it('returns valid shortest paths', () => {
    const rng = new Rng(99);
    for (let trial = 0; trial < 25; trial++) {
      const map = randomMap(rng, 8, 7, 0.25);
      for (let k = 0; k < 30; k++) {
        const a = rng.pick(map.freeCells);
        const b = rng.pick(map.freeCells);
        const distance = map.distance(a, b);
        if (distance === Infinity) {
          expect(() => map.path(a, b)).toThrow();
          continue;
        }
        const path = map.path(a, b);
        expect(path[0]).toBe(a);
        expect(path.at(-1)).toBe(b);
        expect(path.length).toBe(distance + 1);
        const steps = path.slice(1).map((cell, i) => map.neighbours(path[i]!).includes(cell));
        expect(steps.every(Boolean)).toBe(true);
      }
    }
  });

  it('is symmetric and obeys the triangle inequality', () => {
    const map = generateCity(new Rng(4), { width: 16, height: 13 });
    const rng = new Rng(8);
    for (let k = 0; k < 300; k++) {
      const a = rng.pick(map.freeCells);
      const b = rng.pick(map.freeCells);
      const c = rng.pick(map.freeCells);
      expect(map.distance(a, b)).toBe(map.distance(b, a));
      expect(map.distance(a, c)).toBeLessThanOrEqual(map.distance(a, b) + map.distance(b, c));
    }
  });

  it('routes around a wall', () => {
    // A wall across the middle with a single gap at the right-hand end.
    const blocked = new Uint8Array(5 * 3);
    for (let x = 0; x < 4; x++) blocked[1 * 5 + x] = 1;
    const map = new RoadMap(5, 3, blocked);
    expect(map.distance(map.cell(0, 0), map.cell(0, 2))).toBe(10);
    expect(map.path(map.cell(0, 0), map.cell(0, 2))).toContain(map.cell(4, 1));
  });

  it('treats blocked and out-of-range cells as unreachable', () => {
    const blocked = new Uint8Array(9);
    blocked[4] = 1;
    const map = new RoadMap(3, 3, blocked);
    expect(map.distance(0, 4)).toBe(Infinity);
    expect(map.distance(4, 0)).toBe(Infinity);
    expect(map.distance(0, 99)).toBe(Infinity);
    expect(map.distance(0, 0)).toBe(0);
    expect(map.nextStep(0, 0)).toBe(0);
  });

  it('breaks path ties the same way every time', () => {
    const map = new RoadMap(6, 6, new Uint8Array(36));
    const first = map.path(0, 35);
    const again = new RoadMap(6, 6, new Uint8Array(36)).path(0, 35);
    expect(again).toEqual(first);
  });
});

describe('generateCity', () => {
  it('is deterministic for a seed', () => {
    const a = generateCity(new Rng(5), { width: 28, height: 19 });
    const b = generateCity(new Rng(5), { width: 28, height: 19 });
    expect([...a.blocked]).toEqual([...b.blocked]);
    const c = generateCity(new Rng(6), { width: 28, height: 19 });
    expect([...a.blocked]).not.toEqual([...c.blocked]);
  });

  it('produces one connected road network', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const map = generateCity(new Rng(seed), { width: 28, height: 19 });
      expect(map.freeCells.length).toBeGreaterThan(150);
      const field = map.distanceField(map.freeCells[0]!);
      expect(map.freeCells.filter((c) => field[c]! < 0)).toEqual([]);
    }
  });

  it('spreads sites over distinct free cells', () => {
    const map = generateCity(new Rng(3), { width: 28, height: 19 });
    const sites = spreadSites(map, 4);
    expect(new Set(sites).size).toBe(4);
    for (const s of sites) expect(map.isFree(s)).toBe(true);
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        expect(map.distance(sites[i]!, sites[j]!)).toBeGreaterThan(8);
      }
    }
  });
});
