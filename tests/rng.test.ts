import { describe, expect, it } from 'vitest';
import { EventQueue } from '../src/sim/event-queue.ts';
import { deriveSeed, Rng } from '../src/sim/rng.ts';

describe('Rng', () => {
  it('repeats exactly for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('differs between seeds', () => {
    const a = Array.from(
      { length: 8 },
      (
        (r) => () =>
          r.next()
      )(new Rng(1)),
    );
    const b = Array.from(
      { length: 8 },
      (
        (r) => () =>
          r.next()
      )(new Rng(2)),
    );
    expect(a).not.toEqual(b);
  });

  it('stays in range and is roughly uniform', () => {
    const rng = new Rng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
    }
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n * 0.02);
  });

  it('int stays within bounds', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('exponential has the right mean', () => {
    const rng = new Rng(11);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += rng.exponential(0.5);
    expect(sum / n).toBeGreaterThan(1.94);
    expect(sum / n).toBeLessThan(2.06);
  });

  it('derives distinct, stable stream seeds', () => {
    expect(deriveSeed(1, 'map')).toBe(deriveSeed(1, 'map'));
    expect(deriveSeed(1, 'map')).not.toBe(deriveSeed(1, 'demand'));
    expect(deriveSeed(1, 'map')).not.toBe(deriveSeed(2, 'map'));
  });
});

describe('EventQueue', () => {
  it('pops in time order', () => {
    const queue = new EventQueue<number>();
    const rng = new Rng(5);
    const times = Array.from({ length: 500 }, () => rng.int(100));
    times.forEach((t, i) => {
      queue.push(t, i);
    });
    const popped: number[] = [];
    for (let e = queue.pop(); e !== undefined; e = queue.pop()) popped.push(e.time);
    expect(popped).toEqual([...times].sort((a, b) => a - b));
    expect(queue.size).toBe(0);
  });

  it('keeps insertion order for equal times', () => {
    const queue = new EventQueue<string>();
    for (const label of ['a', 'b', 'c', 'd', 'e']) queue.push(1, label);
    queue.push(0, 'first');
    const order: string[] = [];
    for (let e = queue.pop(); e !== undefined; e = queue.pop()) order.push(e.value);
    expect(order).toEqual(['first', 'a', 'b', 'c', 'd', 'e']);
  });

  it('reports the next time, or Infinity when empty', () => {
    const queue = new EventQueue<null>();
    expect(queue.peekTime()).toBe(Infinity);
    queue.push(3, null);
    queue.push(2, null);
    expect(queue.peekTime()).toBe(2);
  });
});
