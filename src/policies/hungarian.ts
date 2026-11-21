export interface AssignmentResult {
  /** For each row, the column it is matched to, or -1 if it is left unmatched. */
  assignment: number[];
  /** Sum of the costs of the matched pairs. */
  total: number;
}

/**
 * Minimum-cost assignment on a rectangular cost matrix (Hungarian algorithm,
 * shortest augmenting path form with potentials, O(n^2 m) for n <= m).
 *
 * Each row is matched to at most one column and each column to at most one
 * row. `Infinity` marks a pair that must not be matched. The result matches as
 * many pairs as possible - min(rows, columns) unless forbidden pairs prevent
 * it - and among such matchings has the smallest total cost. Costs may be
 * negative.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): AssignmentResult {
  const rows = cost.length;
  const columns = cost[0]?.length ?? 0;
  const assignment = new Array<number>(rows).fill(-1);
  if (rows === 0 || columns === 0) return { assignment, total: 0 };

  let largest = 0;
  for (const row of cost) {
    if (row.length !== columns) throw new Error('cost matrix is not rectangular');
    for (const value of row) {
      if (Number.isNaN(value) || value === -Infinity) throw new Error('invalid cost');
      if (value !== Infinity) largest = Math.max(largest, Math.abs(value));
    }
  }
  // A forbidden pair costs more than any set of allowed pairs can save, so the
  // solver only uses one when no allowed pair is left.
  const big = (2 * largest + 1) * (Math.min(rows, columns) + 1);

  // The core needs rows <= columns; flip the matrix if it is the other way round.
  const flipped = rows > columns;
  const n = flipped ? columns : rows;
  const m = flipped ? rows : columns;
  const at = (i: number, j: number): number => {
    const value = flipped ? cost[j]![i]! : cost[i]![j]!;
    return value === Infinity ? big : value;
  };

  // 1-based arrays; index 0 is a sentinel. matched[j] is the row on column j.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const matched = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);

  for (let i = 1; i <= n; i++) {
    matched[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = matched[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j] === 1) continue;
        const reduced = at(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (reduced < minv[j]!) {
          minv[j] = reduced;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j] === 1) {
          u[matched[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (matched[j0] !== 0);
    do {
      const j1 = way[j0]!;
      matched[j0] = matched[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  let total = 0;
  for (let j = 1; j <= m; j++) {
    const i = matched[j]!;
    if (i === 0) continue;
    const row = flipped ? j - 1 : i - 1;
    const column = flipped ? i - 1 : j - 1;
    const value = cost[row]![column]!;
    if (value === Infinity) continue;
    assignment[row] = column;
    total += value;
  }
  return { assignment, total };
}
