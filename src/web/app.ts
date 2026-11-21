import { createPolicy, POLICY_LABELS, POLICY_NAMES, type PolicyName } from '../policies/index.ts';
import { DEMAND_PATTERNS, type DemandPattern } from '../sim/demand.ts';
import { Simulation } from '../sim/engine.ts';
import { computeMetrics } from '../sim/metrics.ts';
import { buildScenario, DEFAULT_CONFIG } from '../sim/scenario.ts';
import type { RobotPhase } from '../sim/state.ts';
import { drawScene } from './render.ts';

const PATTERN_LABELS: Record<DemandPattern, string> = {
  uniform: 'Uniform',
  lunch: 'Lunch peak',
  hotspot: 'Hot spots',
};

const PHASE_LABELS: Record<RobotPhase, string> = {
  idle: 'idle',
  to_pickup: 'to pickup',
  loading: 'loading',
  to_dropoff: 'carrying',
  unloading: 'unloading',
  to_charger: 'to charger',
  queued: 'waiting for bay',
  charging: 'charging',
};

/** Simulated seconds per real second. */
const SPEEDS = [1, 10, 60, 300, 1200];
const PANEL_INTERVAL_MS = 150;

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`missing element #${id}`);
  return element;
}

/** Wire the page up and start the animation loop. Expects the markup in index.html. */
export function startApp(): void {
  const canvas = byId('map', HTMLCanvasElement);
  const frame = byId('map-frame', HTMLDivElement);
  const policySelect = byId('policy', HTMLSelectElement);
  const patternSelect = byId('pattern', HTMLSelectElement);
  const seedInput = byId('seed', HTMLInputElement);
  const robotsInput = byId('robots', HTMLInputElement);
  const rateInput = byId('rate', HTMLInputElement);
  const speedGroup = byId('speed', HTMLDivElement);
  const playButton = byId('play', HTMLButtonElement);
  const restartButton = byId('restart', HTMLButtonElement);
  const statusLine = byId('status', HTMLParagraphElement);
  const metricsList = byId('metrics', HTMLDListElement);
  const fleetList = byId('fleet', HTMLOListElement);

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2D canvas is not available');
  const ctx = context;

  let sim!: Simulation;
  let clock = 0;
  let speed = 60;
  let playing = true;
  let lastFrame: number | null = null;
  let lastPanel = 0;
  const view = { width: 0, height: 0 };

  // ---- controls ---------------------------------------------------------------

  function fillSelect<T extends string>(
    select: HTMLSelectElement,
    values: readonly T[],
    labels: Record<T, string>,
  ): void {
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = labels[value];
      select.append(option);
    }
  }

  function readNumber(input: HTMLInputElement, fallback: number, min: number, max: number): number {
    const parsed = Number(input.value);
    const value = Number.isFinite(parsed) && input.value !== '' ? parsed : fallback;
    const clamped = Math.min(max, Math.max(min, Math.round(value)));
    input.value = String(clamped);
    return clamped;
  }

  function reset(): void {
    const scenario = buildScenario({
      seed: readNumber(seedInput, 1, 0, 2 ** 31 - 1),
      robots: readNumber(robotsInput, DEFAULT_CONFIG.robots, 1, 24),
      jobsPerHour: readNumber(rateInput, DEFAULT_CONFIG.jobsPerHour, 0, 600),
      pattern: patternSelect.value as DemandPattern,
    });
    sim = new Simulation(scenario, createPolicy(policySelect.value as PolicyName));
    clock = 0;
    lastFrame = null;
    frame.style.aspectRatio = `${scenario.config.width} / ${scenario.config.height}`;
    buildFleetRows();
    updatePanels();
    draw();
  }

  function finished(): boolean {
    return sim.done;
  }

  function setPlaying(next: boolean): void {
    playing = next;
    lastFrame = null;
    updateStatus();
  }

  function buildSpeedButtons(): void {
    for (const value of SPEEDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${value}x`;
      button.setAttribute('aria-pressed', String(value === speed));
      button.addEventListener('click', () => {
        speed = value;
        for (const other of speedGroup.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
      });
      speedGroup.append(button);
    }
  }

  // ---- panels -----------------------------------------------------------------

  const metricCells = new Map<string, HTMLElement>();

  function buildMetricRows(): void {
    const rows: [string, string][] = [
      ['time', 'Sim time'],
      ['released', 'Jobs released'],
      ['open', 'Waiting or in transit'],
      ['delivered', 'Delivered'],
      ['dropped', 'Dropped'],
      ['waitP50', 'Wait p50'],
      ['waitP95', 'Wait p95'],
      ['onTime', 'On time'],
      ['deadhead', 'Empty distance'],
      ['utilisation', 'Utilisation'],
    ];
    for (const [key, label] of rows) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const value = document.createElement('dd');
      if (key === 'onTime') value.className = 'accent';
      row.append(term, value);
      metricsList.append(row);
      metricCells.set(key, value);
    }
  }

  function buildFleetRows(): void {
    fleetList.replaceChildren(
      ...sim.robots.map((robot) => {
        const row = document.createElement('li');
        for (const name of ['id', 'phase', 'battery']) {
          const span = document.createElement('span');
          span.className = name;
          row.append(span);
        }
        row.firstElementChild!.textContent = `R${robot.id}`;
        return row;
      }),
    );
  }

  function clockText(seconds: number): string {
    const s = Math.floor(seconds);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  function seconds(value: number): string {
    return Number.isFinite(value) ? `${value.toFixed(0)} s` : '-';
  }

  function percent(value: number): string {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
  }

  function setText(element: Element | null | undefined, text: string): void {
    if (element != null && element.textContent !== text) element.textContent = text;
  }

  function updatePanels(): void {
    const m = computeMetrics(sim);
    const released = m.delivered + m.dropped + m.open;
    const values: Record<string, string> = {
      time: `${clockText(sim.now)} / ${clockText(sim.config.horizon)}`,
      released: `${released} / ${m.jobs}`,
      open: String(m.open),
      delivered: String(m.delivered),
      dropped: String(m.dropped),
      waitP50: seconds(m.waitP50),
      waitP95: seconds(m.waitP95),
      onTime: percent(m.onTimeRate),
      deadhead: percent(m.deadheadShare),
      utilisation: percent(m.utilisation),
    };
    for (const [key, text] of Object.entries(values)) setText(metricCells.get(key), text);

    sim.robots.forEach((robot, i) => {
      const row = fleetList.children[i];
      if (row === undefined) return;
      row.classList.toggle('busy', robot.jobId !== null);
      setText(row.children[1], PHASE_LABELS[robot.phase]);
      const level = (sim.batteryOf(robot) / sim.config.batteryRange) * 100;
      setText(row.children[2], `${level.toFixed(0)} %`);
    });
    updateStatus();
  }

  function updateStatus(): void {
    const done = finished();
    setText(playButton, done ? 'Run again' : playing ? 'Pause' : 'Play');
    setText(
      statusLine,
      done ? 'Finished: every job was delivered or dropped.' : playing ? 'Running.' : 'Paused.',
    );
  }

  // ---- drawing ----------------------------------------------------------------

  function resize(): void {
    const rect = frame.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    view.width = Math.max(1, rect.width);
    view.height = Math.max(1, rect.height);
    canvas.width = Math.round(view.width * ratio);
    canvas.height = Math.round(view.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  function draw(): void {
    if (view.width === 0) return;
    drawScene(ctx, sim, sim.now, view);
  }

  function tick(timestamp: number): void {
    if (playing && !sim.done) {
      // Cap the step so a background tab does not jump ahead when it returns.
      const elapsed = lastFrame === null ? 0 : Math.min(100, timestamp - lastFrame);
      lastFrame = timestamp;
      clock += (elapsed / 1000) * speed;
      sim.runUntil(clock);
      draw();
      if (finished() || timestamp - lastPanel >= PANEL_INTERVAL_MS) {
        lastPanel = timestamp;
        updatePanels();
      }
    }
    requestAnimationFrame(tick);
  }

  // ---- start ------------------------------------------------------------------

  fillSelect(policySelect, POLICY_NAMES, POLICY_LABELS);
  fillSelect(patternSelect, DEMAND_PATTERNS, PATTERN_LABELS);
  policySelect.value = 'batch';
  robotsInput.value = String(DEFAULT_CONFIG.robots);
  rateInput.value = String(DEFAULT_CONFIG.jobsPerHour);
  buildSpeedButtons();
  buildMetricRows();

  for (const control of [policySelect, patternSelect, seedInput, robotsInput, rateInput]) {
    control.addEventListener('change', reset);
  }
  restartButton.addEventListener('click', () => {
    reset();
    setPlaying(true);
  });
  playButton.addEventListener('click', () => {
    if (finished()) {
      reset();
      setPlaying(true);
    } else {
      setPlaying(!playing);
    }
  });

  reset();
  new ResizeObserver(resize).observe(frame);
  resize();
  requestAnimationFrame(tick);
}
