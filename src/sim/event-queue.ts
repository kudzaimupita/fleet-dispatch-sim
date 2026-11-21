/**
 * Binary min-heap of timed events. Events at the same time come out in the
 * order they were pushed, which keeps the simulation deterministic.
 */
interface Entry<T> {
  time: number;
  seq: number;
  value: T;
}

export class EventQueue<T> {
  private heap: Entry<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, value: T): void {
    const entry: Entry<T> = { time, seq: this.seq++, value };
    const heap = this.heap;
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(entry, heap[parent]!)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = entry;
  }

  peekTime(): number {
    return this.heap[0]?.time ?? Infinity;
  }

  pop(): { time: number; value: T } | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop()!;
    const n = heap.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && before(heap[child + 1]!, heap[child]!)) child++;
        if (!before(heap[child]!, last)) break;
        heap[i] = heap[child]!;
        i = child;
      }
      heap[i] = last;
    }
    return { time: top.time, value: top.value };
  }
}

function before<T>(a: Entry<T>, b: Entry<T>): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}
