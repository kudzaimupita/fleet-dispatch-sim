// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp } from '../src/web/app.ts';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/, '');

let frames: FrameRequestCallback[] = [];
let now = 0;

/** Run `count` animation frames, 16 ms apart. */
function advance(count: number): void {
  for (let i = 0; i < count; i++) {
    now += 16;
    const due = frames;
    frames = [];
    for (const callback of due) callback(now);
  }
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent ?? '';
}

function metric(label: string): string {
  for (const row of document.querySelectorAll('#metrics div')) {
    if (row.querySelector('dt')?.textContent === label) return row.querySelector('dd')!.textContent;
  }
  throw new Error(`no metric called ${label}`);
}

function click(selector: string): void {
  document.querySelector<HTMLElement>(selector)!.click();
}

function change(selector: string, value: string): void {
  const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  control.value = value;
  control.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  document.body.innerHTML = body;
  frames = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // sizes are read directly in the test
      }
    },
  );
  // happy-dom has no canvas; any drawing call is accepted and ignored.
  const recorded: Record<string, unknown> = {};
  const context = new Proxy(recorded, {
    get: (store, name: string) => store[name] ?? (() => undefined),
    set: (store, name: string, value) => {
      store[name] = value;
      return true;
    },
  });
  HTMLCanvasElement.prototype.getContext = (() => context) as never;
  Element.prototype.getBoundingClientRect = () => ({ width: 640, height: 434 }) as DOMRect;
});

describe('browser view', () => {
  it('fills the pickers and starts on the default scenario', () => {
    startApp();
    const options = (id: string): string[] =>
      [...document.querySelectorAll(`#${id} option`)].map((o) => o.textContent);
    expect(options('policy')).toEqual([
      'Nearest idle robot',
      'First-come queue',
      'Queue with chaining',
      'Batch assignment',
    ]);
    expect(options('pattern')).toEqual(['Uniform', 'Lunch peak', 'Hot spots']);
    expect(document.querySelectorAll('#fleet li').length).toBe(6);
    expect(document.querySelectorAll('#speed button').length).toBe(5);
    expect(text('#speed button[aria-pressed="true"]')).toBe('60x');
    expect(metric('Sim time')).toBe('0:00:00 / 4:00:00');
    expect(text('#status')).toBe('Running.');
    expect(text('#play')).toBe('Pause');
  });

  it('advances the clock and the metrics as frames pass', () => {
    startApp();
    click('#speed button:last-child');
    advance(200);
    // 200 frames of 16 ms at 1200x, less the first frame, which only sets the baseline.
    expect(metric('Sim time')).toBe('1:03:40 / 4:00:00');
    expect(Number(metric('Delivered'))).toBeGreaterThan(50);
    expect(metric('Wait p50')).toMatch(/^\d+ s$/);
    expect(metric('On time')).toMatch(/^\d+\.\d %$/);
    expect(text('#fleet li:first-child .battery')).toMatch(/^\d+ %$/);
  });

  it('pauses and resumes', () => {
    startApp();
    advance(30);
    click('#play');
    expect(text('#play')).toBe('Play');
    expect(text('#status')).toBe('Paused.');
    const frozen = metric('Sim time');
    advance(30);
    expect(metric('Sim time')).toBe(frozen);
    click('#play');
    advance(30);
    expect(metric('Sim time')).not.toBe(frozen);
  });

  it('restarts when a picker changes', () => {
    startApp();
    advance(60);
    expect(metric('Sim time')).not.toBe('0:00:00 / 4:00:00');
    change('#robots', '9');
    expect(metric('Sim time')).toBe('0:00:00 / 4:00:00');
    expect(document.querySelectorAll('#fleet li').length).toBe(9);
    const jobs = metric('Jobs released');
    change('#seed', '2');
    expect(metric('Jobs released')).not.toBe(jobs);
    change('#policy', 'chain');
    change('#pattern', 'hotspot');
    advance(20);
    expect(metric('Sim time')).not.toBe('0:00:00 / 4:00:00');
  });

  it('clamps out-of-range inputs', () => {
    startApp();
    change('#robots', '500');
    expect(document.querySelector<HTMLInputElement>('#robots')!.value).toBe('24');
    change('#robots', '');
    expect(document.querySelector<HTMLInputElement>('#robots')!.value).toBe('6');
    change('#seed', '-4');
    expect(document.querySelector<HTMLInputElement>('#seed')!.value).toBe('0');
  });

  it('runs to the end and offers another run', () => {
    startApp();
    change('#rate', '20');
    click('#speed button:last-child');
    advance(1200);
    expect(text('#status')).toBe('Finished: every job was delivered or dropped.');
    expect(metric('Waiting or in transit')).toBe('0');
    expect(text('#play')).toBe('Run again');
    click('#play');
    expect(metric('Sim time')).toBe('0:00:00 / 4:00:00');
    expect(text('#play')).toBe('Pause');
  });
});
