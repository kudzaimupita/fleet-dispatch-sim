import { describe, expect, it } from 'vitest';
import { createPolicy } from '../src/policies/index.ts';
import { Simulation } from '../src/sim/engine.ts';
import { buildScenario, customScenario } from '../src/sim/scenario.ts';
import { drawScene, robotPosition } from '../src/web/render.ts';

/** A stand-in 2D context that records which drawing calls were made. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(store, name: string) {
      if (name in store) return store[name];
      return (...args: unknown[]) => {
        for (const arg of args) {
          if (typeof arg === 'number' && !Number.isFinite(arg)) {
            throw new Error(`${name} was called with a non-finite number`);
          }
        }
        calls.set(name, (calls.get(name) ?? 0) + 1);
      };
    },
    set(store, name: string, value) {
      store[name] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('drawScene', () => {
  it('draws every frame of a run without bad coordinates', () => {
    const scenario = buildScenario({ seed: 2, pattern: 'lunch', horizon: 1800, batteryRange: 150 });
    const sim = new Simulation(scenario, createPolicy('batch'));
    const { ctx, calls } = recordingContext();
    for (let t = 0; !sim.done; t += 13) {
      sim.runUntil(t);
      drawScene(ctx, sim, sim.now, { width: 640, height: 434 });
    }
    drawScene(ctx, sim, sim.now, { width: 320, height: 500 });
    expect(calls.get('arc')).toBeGreaterThan(scenario.robots.length);
    expect(calls.get('strokeRect')).toBeGreaterThan(0);
    expect(calls.get('lineTo')).toBeGreaterThan(0);
  });
});

describe('robotPosition', () => {
  it('interpolates along the segment being driven', () => {
    const scenario = customScenario({
      width: 6,
      height: 1,
      chargers: [[0, 0]],
      robots: [{ at: [0, 0] }],
      jobs: [{ pickup: [5, 0], dropoff: [4, 0], release: 0 }],
      config: { speed: 0.25 },
    });
    const sim = new Simulation(scenario, createPolicy('nearest'));
    sim.runUntil(5);
    const robot = sim.robots[0]!;
    expect(robotPosition(sim, robot, 5)).toEqual({ x: 1.25, y: 0 });
    expect(robotPosition(sim, robot, 6)).toEqual({ x: 1.5, y: 0 });
    // Clamped to the segment if asked about a time outside it.
    expect(robotPosition(sim, robot, 99)).toEqual({ x: 2, y: 0 });
    expect(robotPosition(sim, robot, 0)).toEqual({ x: 1, y: 0 });
  });
});
