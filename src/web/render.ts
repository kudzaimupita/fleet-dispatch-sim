import type { Simulation } from '../sim/engine.ts';
import type { Cell } from '../sim/road-map.ts';
import type { RobotState } from '../sim/state.ts';

export const THEME = {
  background: '#0a0c0b',
  building: '#141917',
  text: '#d9dedb',
  muted: '#7f8a85',
  accent: '#3ddc84',
} as const;

export interface Viewport {
  /** Size of the drawing area in CSS pixels. */
  width: number;
  height: number;
}

interface Layout {
  size: number;
  x0: number;
  y0: number;
}

function layoutFor(sim: Simulation, view: Viewport): Layout {
  const size = Math.min(view.width / sim.map.width, view.height / sim.map.height);
  return {
    size,
    x0: (view.width - size * sim.map.width) / 2,
    y0: (view.height - size * sim.map.height) / 2,
  };
}

/** Where a robot is at `time`, in fractional grid coordinates. */
export function robotPosition(
  sim: Simulation,
  robot: Readonly<RobotState>,
  time: number,
): { x: number; y: number } {
  const map = sim.map;
  const edge = robot.moving;
  if (edge === null) return { x: map.x(robot.cell), y: map.y(robot.cell) };
  const span = edge.arriveAt - edge.departAt;
  const f = span <= 0 ? 1 : Math.min(1, Math.max(0, (time - edge.departAt) / span));
  return {
    x: map.x(edge.from) + (map.x(edge.to) - map.x(edge.from)) * f,
    y: map.y(edge.from) + (map.y(edge.to) - map.y(edge.from)) * f,
  };
}

/** Draw the whole scene. The context must already be scaled to CSS pixels. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  sim: Simulation,
  time: number,
  view: Viewport,
): void {
  const map = sim.map;
  const layout = layoutFor(sim, view);
  const { size, x0, y0 } = layout;
  const centre = (cell: Cell): [number, number] => [
    x0 + (map.x(cell) + 0.5) * size,
    y0 + (map.y(cell) + 0.5) * size,
  ];

  ctx.fillStyle = THEME.background;
  ctx.fillRect(0, 0, view.width, view.height);

  // Buildings: blocked cells, slightly inset so streets read as a network.
  ctx.fillStyle = THEME.building;
  const gap = size > 10 ? 1 : 0;
  for (let cell = 0; cell < map.blocked.length; cell++) {
    if (map.blocked[cell] === 0) continue;
    ctx.fillRect(
      x0 + map.x(cell) * size + gap,
      y0 + map.y(cell) * size + gap,
      size - 2 * gap,
      size - 2 * gap,
    );
  }

  // Chargers: an outlined square with a plus.
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = THEME.muted;
  for (const station of sim.stations) {
    const [cx, cy] = centre(station.cell);
    const half = size * 0.36;
    ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
    ctx.beginPath();
    ctx.moveTo(cx - half * 0.5, cy);
    ctx.lineTo(cx + half * 0.5, cy);
    ctx.moveTo(cx, cy - half * 0.5);
    ctx.lineTo(cx, cy + half * 0.5);
    ctx.stroke();
  }

  // Planned routes, under the markers.
  for (const robot of sim.robots) {
    if (robot.target === null) continue;
    const from = robot.moving?.to ?? robot.cell;
    const here = robotPosition(sim, robot, time);
    const loaded = robot.phase === 'to_dropoff';
    ctx.beginPath();
    ctx.moveTo(x0 + (here.x + 0.5) * size, y0 + (here.y + 0.5) * size);
    for (const cell of map.path(from, robot.target)) {
      const [px, py] = centre(cell);
      ctx.lineTo(px, py);
    }
    ctx.setLineDash(loaded ? [] : [3, 4]);
    ctx.globalAlpha = loaded ? 0.6 : 0.45;
    ctx.strokeStyle = robot.phase === 'to_charger' ? THEME.muted : THEME.accent;
    ctx.lineWidth = loaded ? 1.5 : 1;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Jobs: a square at the pickup while waiting, a diamond at the drop-off once carried.
  ctx.lineWidth = 1.5;
  for (const job of sim.jobs) {
    if (job.status === 'pending' || job.status === 'assigned') {
      const [cx, cy] = centre(job.pickup);
      const half = size * 0.22;
      ctx.strokeStyle = job.status === 'assigned' ? THEME.accent : THEME.text;
      ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
    } else if (job.status === 'carried') {
      const [cx, cy] = centre(job.dropoff);
      const half = size * 0.26;
      ctx.strokeStyle = THEME.accent;
      ctx.beginPath();
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + half, cy);
      ctx.lineTo(cx, cy + half);
      ctx.lineTo(cx - half, cy);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Robots, with a battery bar underneath.
  const radius = size * 0.32;
  for (const robot of sim.robots) {
    const here = robotPosition(sim, robot, time);
    const cx = x0 + (here.x + 0.5) * size;
    const cy = y0 + (here.y + 0.5) * size;
    const charging =
      robot.phase === 'to_charger' || robot.phase === 'queued' || robot.phase === 'charging';
    const carrying =
      robot.phase === 'loading' || robot.phase === 'to_dropoff' || robot.phase === 'unloading';

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = robot.phase === 'to_pickup' || carrying ? THEME.accent : THEME.background;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = charging ? THEME.muted : THEME.accent;
    ctx.stroke();
    if (carrying) {
      const half = radius * 0.42;
      ctx.fillStyle = THEME.background;
      ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    }

    const level = Math.min(1, Math.max(0, sim.batteryOf(robot) / sim.config.batteryRange));
    const barWidth = size * 0.7;
    const barY = cy + radius + 3;
    ctx.fillStyle = THEME.building;
    ctx.fillRect(cx - barWidth / 2, barY, barWidth, 2);
    ctx.fillStyle = level < sim.config.lowBattery ? THEME.text : THEME.muted;
    ctx.fillRect(cx - barWidth / 2, barY, barWidth * level, 2);
  }
}
