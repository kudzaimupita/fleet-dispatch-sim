# fleet-dispatch-sim

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

A deterministic discrete-event simulator for dispatching a small fleet of delivery robots on a
city grid. It exists to answer one kind of question: on the same day, with the same jobs, how much
does the dispatch policy change waiting time, lateness and wasted driving?

Four policies are included behind one interface, with a command-line comparison across seeds and a
browser view to watch a run.

Everything is plain TypeScript with no runtime dependencies. The simulator core has no DOM code and
runs the same in Node and in the browser.

## Quick start

Requires Node 24 or newer.

```sh
npm ci
npm test                 # 147 tests
npm run compare -- --seeds 20 --robots 6 --pattern lunch
npm run dev              # browser view at the address Vite prints
```

`npm run check` runs lint, format check, tests and the production build in one go.

## What is simulated

- **City.** A grid of cells. Streets run along every third row and column; a seeded generator
  opens a few blocks into squares and closes a few street cells, then blocks anything cut off from
  the main network. Robots move between adjacent free cells. Shortest paths are breadth-first
  distance fields, one per target cell, cached on first use.
- **Robots.** Constant speed, one parcel at a time, and a battery measured in cells of range that
  drains by one per cell driven. Robots start at random cells with 60-100% charge.
- **Chargers.** A few stations spread over the map, each with a fixed number of bays and a
  first-come queue.
- **Jobs.** Pickup cell, drop-off cell, release time and deadline. Arrivals are a Poisson process
  sampled by thinning. A job not picked up within the patience window (10 minutes by default) is
  dropped. Three demand patterns, all with the same mean rate:
  - `uniform`: constant rate, uniform locations.
  - `lunch`: a bell-shaped peak in the middle of the run, about four times the base rate.
  - `hotspot`: constant rate, 70% of pickups within four cells of two random centres.
- **Units.** Distance in cells, time in seconds. Defaults: 28x19 grid, 0.25 cells/s, 600 cells of
  range, 100 jobs/hour for 4 hours, 15 s to load and 15 s to unload. All of it is in
  [`SimConfig`](src/sim/scenario.ts).

## Policies

| name      | rule                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nearest` | Commit the closest (idle robot, waiting job) pair, repeatedly. A freed robot takes the nearest job, however long others have waited.                                                              |
| `fifo`    | Oldest job first; it gets the nearest idle robot.                                                                                                                                                 |
| `chain`   | Oldest job first, but robots already carrying a parcel are candidates too, measured from their drop-off. The job goes to the candidate with the least empty travel. One chained job per robot.    |
| `batch`   | Every 10 s, take back every job not yet picked up and solve one robot-to-job assignment (Hungarian algorithm) minimising total time-to-pickup. Robots mid-delivery take part from their drop-off. |

A policy is an object with a `dispatch(ctx)` method. It reads the fleet and the waiting jobs
through the context and issues `assign` / `unassign` commands; it owns no simulation state
([interface](src/policies/types.ts)). Adding a policy is one file.

**The charging rule is the engine's, not the policy's**, so every policy plays under the same
constraint:

1. A robot may only take a job if, after delivering it, it can still reach the nearest charger
   with a reserve to spare. `canAssign` answers this and `assign` enforces it.
2. A robot that becomes idle below 25% goes to the nearest charger and charges to full.
3. An idle robot also goes to charge if a waiting job is out of its range now but would not be on
   a full battery.

Rule 1 plus the triangle inequality is what guarantees a battery never goes below zero, including
when a robot is pulled off a job half way to the pickup. The engine throws if it ever does, and the
tests check it after every event.

## Results

Measured with the command shown, on the defaults: 6 robots, 100 jobs/hour, 4 hours, seeds 1-20.
Each cell is the mean across seeds with a percentile-bootstrap 95% interval (2000 resamples). The
output is deterministic, so running the command again prints the same table.

```sh
npm run compare -- --seeds 20 --robots 6 --pattern lunch
```

Lunch peak (394.8 jobs per run):

| policy  | wait p50 (s)         | wait p95 (s)         | on time (%)       | deadhead (%)      | utilisation (%)   | dropped (jobs)    |
| ------- | -------------------- | -------------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| nearest | 79.6 [77.0, 82.5]    | 429.9 [414.1, 447.1] | 74.2 [72.0, 76.3] | 36.3 [35.5, 37.1] | 57.4 [56.2, 58.6] | 31.2 [26.4, 36.3] |
| fifo    | 226.2 [190.5, 264.8] | 584.9 [581.4, 587.8] | 40.6 [38.4, 42.9] | 49.4 [49.0, 49.8] | 59.7 [58.5, 60.9] | 78.7 [70.6, 86.7] |
| chain   | 190.1 [163.6, 220.9] | 576.3 [571.8, 580.2] | 44.0 [41.5, 46.2] | 45.6 [44.9, 46.2] | 58.3 [57.0, 59.6] | 68.0 [59.8, 76.1] |
| batch   | 73.8 [70.4, 77.9]    | 418.1 [397.6, 439.1] | 75.9 [73.5, 78.2] | 33.1 [32.4, 33.9] | 55.8 [54.6, 57.1] | 27.3 [23.0, 31.7] |

Uniform, `--pattern uniform` (400.7 jobs per run):

| policy  | wait p50 (s)         | wait p95 (s)         | on time (%)       | deadhead (%)      | utilisation (%)   | dropped (jobs) |
| ------- | -------------------- | -------------------- | ----------------- | ----------------- | ----------------- | -------------- |
| nearest | 69.9 [66.5, 74.1]    | 253.1 [228.9, 282.0] | 91.9 [89.9, 93.6] | 43.2 [42.5, 43.9] | 68.1 [66.2, 69.9] | 2.5 [1.4, 3.6] |
| fifo    | 147.2 [118.1, 181.6] | 424.0 [376.5, 471.5] | 67.9 [60.4, 75.0] | 48.6 [48.0, 49.2] | 73.1 [70.9, 75.4] | 5.2 [2.2, 9.4] |
| chain   | 104.4 [90.4, 121.1]  | 331.8 [290.3, 375.4] | 81.7 [76.5, 86.3] | 42.6 [41.7, 43.4] | 67.9 [65.6, 70.3] | 1.4 [0.1, 3.2] |
| batch   | 57.4 [55.4, 59.9]    | 186.8 [169.1, 207.4] | 96.4 [95.3, 97.4] | 38.1 [37.7, 38.6] | 64.2 [62.4, 65.9] | 0.5 [0.1, 0.8] |

Hot spots, `--pattern hotspot` (391.7 jobs per run):

| policy  | wait p50 (s)         | wait p95 (s)         | on time (%)       | deadhead (%)      | utilisation (%)   | dropped (jobs) |
| ------- | -------------------- | -------------------- | ----------------- | ----------------- | ----------------- | -------------- |
| nearest | 72.8 [68.4, 77.8]    | 243.8 [219.0, 269.2] | 92.3 [90.5, 94.0] | 45.3 [44.7, 45.9] | 67.7 [65.3, 70.1] | 2.4 [0.8, 4.5] |
| fifo    | 129.4 [104.6, 157.5] | 373.6 [324.8, 422.9] | 74.1 [66.9, 80.9] | 49.0 [48.6, 49.4] | 71.3 [68.4, 74.0] | 2.1 [0.5, 4.0] |
| chain   | 104.0 [91.6, 119.6]  | 317.5 [275.3, 362.7] | 83.6 [77.8, 88.3] | 45.1 [44.1, 45.9] | 67.5 [64.7, 70.2] | 1.4 [0.4, 2.5] |
| batch   | 66.0 [62.4, 70.1]    | 209.5 [189.6, 230.9] | 94.6 [92.9, 96.1] | 41.4 [40.6, 42.0] | 64.2 [61.9, 66.5] | 2.0 [0.7, 3.5] |

How to read the columns:

- **wait** is release to the robot reaching the pickup, over jobs that were picked up. Dropped jobs
  are not in it, so when many jobs are dropped the percentiles understate the pain; `fifo`'s p95
  sitting just under the 600 s patience limit is that ceiling showing.
- **on time** is jobs delivered by their deadline as a share of all jobs, so a dropped job counts
  against it.
- **deadhead** is distance driven without a parcel (to pickups and to chargers) over all distance.
- **utilisation** is the share of fleet time spent on jobs, including the drive to the pickup. A
  lower figure for the same deliveries means less wasted driving, not idleness.

What the tables say, and no more than that:

- Strict oldest-first is the worst rule here on every pattern. Under the lunch overload it sends
  robots across the map for jobs that are about to expire and drops two and a half times as many
  as `nearest`.
- Chaining recovers part of that: less empty driving than `fifo` on every pattern, and better
  on-time rates when the fleet is not overloaded. It is still an oldest-first rule and collapses
  the same way at the peak.
- Batch assignment is ahead on wait, on-time rate and deadhead on the uniform pattern. On the
  lunch peak its lead over `nearest` on on-time rate and drops is inside the intervals; the
  deadhead gap is not.
- The intervals are computed per policy. Every policy sees the same 20 scenarios, so differences
  between policies are less uncertain than overlapping intervals suggest; a paired analysis would
  be the next step.

Two batch parameters were tried on the lunch pattern (`--policies batch` plus the flag shown):

| variant                   | wait p50 (s)         | on time (%)       | dropped (jobs)    |
| ------------------------- | -------------------- | ----------------- | ----------------- |
| default (10 s, no credit) | 73.8 [70.4, 77.9]    | 75.9 [73.5, 78.2] | 27.3 [23.0, 31.7] |
| `--batch-interval 60`     | 98.7 [95.4, 102.3]   | 73.6 [71.4, 75.7] | 29.7 [25.3, 34.5] |
| `--batch-age-weight 0.5`  | 130.4 [110.1, 156.0] | 57.2 [53.4, 61.2] | 30.7 [24.9, 36.8] |

Giving old jobs a credit in the cost function, which is the obvious fairness fix, made things
worse under overload for the same reason `fifo` does badly. The default is therefore no credit.

## Browser view

`npm run dev` opens a live map: robots, their planned routes, waiting and assigned pickups,
drop-offs and chargers, with pickers for policy, demand pattern, seed, fleet size and arrival rate,
a speed control from 1x to 1200x, live metrics and a per-robot status list. Changing a picker
restarts the run; the same seed always replays the same day.

The page uses the simulator directly: each animation frame advances the clock and calls
`sim.runUntil(t)`, and robot positions are interpolated along the road segment being driven. A test
checks that advancing in uneven slices gives exactly the same run as `sim.run()`.

## Design notes

- **Discrete events, one road segment at a time.** The event queue holds job releases, patience
  expiries, segment arrivals, load/unload completions, charge completions and policy ticks. A
  robot is always at a cell or on exactly one segment, so a plan can change at any cell boundary
  without cancelling events. This costs more events than one event per trip (about 14,000 for a
  default run) and buys simple, exact re-routing and battery accounting.
- **Determinism.** One seeded generator (mulberry32) with separate derived streams for the map,
  the fleet and the demand. Policies draw no random numbers and every tie is broken by a fixed
  order (event insertion order, oldest job, lowest robot id, fixed neighbour order in path
  finding). A scenario is built once and shared by all policies, so comparisons are paired.
- **Drain, do not truncate.** Arrivals stop at the horizon and the run continues until every job
  is delivered or dropped, so no job is left uncounted at the end.
- **Hungarian algorithm.** [`solveAssignment`](src/policies/hungarian.ts) is the shortest
  augmenting path form with potentials, O(n^2 m), for rectangular matrices with forbidden pairs
  and negative costs. It is tested against exhaustive search on about 1,200 random small matrices.
- **Node runs the TypeScript directly.** The source sticks to erasable syntax, so `npm run compare`
  is `node src/cli/compare.ts` with no build step or loader.

## Project layout

```
src/sim/        road map, demand, scenario, engine, metrics (no DOM)
src/policies/   policy interface, four policies, Hungarian solver
src/stats/      bootstrap interval
src/cli/        compare command
src/web/        canvas renderer and page logic
tests/          vitest suites
```

## Limitations

- Robots do not block each other. There is no congestion, no lane capacity and no collision
  model; two robots can occupy the same cell.
- Travel times are deterministic and known exactly to the dispatcher. Real ETAs are noisy, which
  matters most for the chaining and batch policies because they plan around predicted finish times.
- Speed is constant, energy use depends only on distance, and charging is linear and always runs
  to full. There is no opportunistic top-up while idle.
- One parcel per robot. No pooling, no multi-stop routes.
- The dispatcher has no forecast: it never pre-positions idle robots ahead of the lunch peak or
  near hot spots, which is where a real system would look for the next gain.
- The cost a job imposes when dropped is not modelled beyond the count.
- The default parameters are round numbers chosen to give a busy but workable fleet. They are not
  calibrated to any real vehicle or city, so the absolute figures mean little; the comparison
  between policies on identical scenarios is the point.
- The browser view is covered by a DOM smoke test with a stub canvas. It has not been checked
  across browsers.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
