import { describe, expect, it } from 'vitest';
import { solveAssignment } from '../src/policies/hungarian.ts';
import { Rng } from '../src/sim/rng.ts';

/**
 * Reference: try every way of matching rows to distinct columns (or leaving a
 * row out), keep the matching with the most pairs and, among those, the
 * lowest total cost.
 */
function bruteForce(cost: number[][]): { pairs: number; total: number } {
  const columns = cost[0]?.length ?? 0;
  const used = new Array<boolean>(columns).fill(false);
  let best = { pairs: 0, total: 0 };
  const search = (row: number, pairs: number, total: number): void => {
    if (row === cost.length) {
      if (pairs > best.pairs || (pairs === best.pairs && total < best.total)) {
        best = { pairs, total };
      }
      return;
    }
    search(row + 1, pairs, total);
    for (let c = 0; c < columns; c++) {
      const value = cost[row]![c]!;
      if (used[c] === true || value === Infinity) continue;
      used[c] = true;
      search(row + 1, pairs + 1, total + value);
      used[c] = false;
    }
  };
  search(0, 0, 0);
  return best;
}

function randomMatrix(
  rng: Rng,
  rows: number,
  columns: number,
  make: () => number,
  forbiddenShare = 0,
): number[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => (rng.next() < forbiddenShare ? Infinity : make())),
  );
}

function expectValid(cost: number[][], assignment: number[], total: number): number {
  expect(assignment.length).toBe(cost.length);
  const seen = new Set<number>();
  let sum = 0;
  let pairs = 0;
  assignment.forEach((column, row) => {
    if (column === -1) return;
    expect(seen.has(column)).toBe(false);
    seen.add(column);
    const value = cost[row]![column]!;
    expect(value).not.toBe(Infinity);
    sum += value;
    pairs++;
  });
  expect(total).toBeCloseTo(sum, 9);
  return pairs;
}

describe('solveAssignment', () => {
  it('solves a known 3x3 case', () => {
    const { assignment, total } = solveAssignment([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]);
    expect(assignment).toEqual([1, 0, 2]);
    expect(total).toBe(5);
  });

  it('handles empty input', () => {
    expect(solveAssignment([])).toEqual({ assignment: [], total: 0 });
    expect(solveAssignment([[], []])).toEqual({ assignment: [-1, -1], total: 0 });
  });

  it('rejects a ragged matrix and invalid costs', () => {
    expect(() => solveAssignment([[1, 2], [3]])).toThrow();
    expect(() => solveAssignment([[NaN]])).toThrow();
    expect(() => solveAssignment([[-Infinity]])).toThrow();
  });

  it('matches brute force on square integer matrices', () => {
    const rng = new Rng(1);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + rng.int(6);
      const cost = randomMatrix(rng, n, n, () => rng.int(41) - 10);
      const result = solveAssignment(cost);
      const reference = bruteForce(cost);
      expect(expectValid(cost, result.assignment, result.total)).toBe(n);
      expect(result.total).toBe(reference.total);
    }
  });

  it('matches brute force on rectangular matrices, both ways round', () => {
    const rng = new Rng(2);
    for (let trial = 0; trial < 300; trial++) {
      const rows = 1 + rng.int(6);
      const columns = 1 + rng.int(6);
      const cost = randomMatrix(rng, rows, columns, () => rng.int(100));
      const result = solveAssignment(cost);
      const reference = bruteForce(cost);
      expect(expectValid(cost, result.assignment, result.total)).toBe(Math.min(rows, columns));
      expect(result.total).toBe(reference.total);
    }
  });

  it('matches brute force with forbidden pairs', () => {
    const rng = new Rng(3);
    for (let trial = 0; trial < 400; trial++) {
      const rows = 1 + rng.int(6);
      const columns = 1 + rng.int(6);
      const cost = randomMatrix(rng, rows, columns, () => rng.int(60) - 20, 0.35);
      const result = solveAssignment(cost);
      const reference = bruteForce(cost);
      expect(expectValid(cost, result.assignment, result.total)).toBe(reference.pairs);
      expect(result.total).toBe(reference.total);
    }
  });

  it('matches brute force on fractional costs', () => {
    const rng = new Rng(4);
    for (let trial = 0; trial < 200; trial++) {
      const rows = 1 + rng.int(5);
      const columns = 1 + rng.int(7);
      const cost = randomMatrix(rng, rows, columns, () => rng.range(-500, 2000), 0.15);
      const result = solveAssignment(cost);
      const reference = bruteForce(cost);
      expect(expectValid(cost, result.assignment, result.total)).toBe(reference.pairs);
      expect(result.total).toBeCloseTo(reference.total, 6);
    }
  });

  it('leaves every row unmatched when everything is forbidden', () => {
    const cost = [
      [Infinity, Infinity],
      [Infinity, Infinity],
      [Infinity, Infinity],
    ];
    expect(solveAssignment(cost)).toEqual({ assignment: [-1, -1, -1], total: 0 });
  });

  it('solves a 60x60 problem no worse than a greedy matching', () => {
    const rng = new Rng(5);
    const n = 60;
    const cost = randomMatrix(rng, n, n, () => rng.int(1000));
    const result = solveAssignment(cost);
    expect(expectValid(cost, result.assignment, result.total)).toBe(n);
    const taken = new Set<number>();
    let greedy = 0;
    for (const row of cost) {
      let best = -1;
      row.forEach((value, c) => {
        if (!taken.has(c) && (best === -1 || value < row[best]!)) best = c;
      });
      taken.add(best);
      greedy += row[best]!;
    }
    expect(result.total).toBeLessThanOrEqual(greedy);
  });
});
