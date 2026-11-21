import { parseArgs } from 'node:util';
import { createPolicy, isPolicyName, POLICY_NAMES, type PolicyName } from '../policies/index.ts';
import { DEMAND_PATTERNS, type DemandPattern } from '../sim/demand.ts';
import { Simulation } from '../sim/engine.ts';
import { computeMetrics, type Metrics } from '../sim/metrics.ts';
import { buildScenario, DEFAULT_CONFIG } from '../sim/scenario.ts';
import { bootstrapMean, type Interval } from '../stats/bootstrap.ts';

export interface CompareOptions {
  seeds: number;
  firstSeed: number;
  robots: number;
  pattern: DemandPattern;
  jobsPerHour: number;
  hours: number;
  policies: PolicyName[];
  batchInterval: number;
  batchAgeWeight: number;
  resamples: number;
}

export const USAGE = `Usage: npm run compare -- [options]

Runs every policy on the same seeded scenarios and prints the mean and a
bootstrap 95% interval across seeds for each metric.

  --seeds <n>             number of seeds to run (default 20)
  --first-seed <n>        first seed; seeds are consecutive (default 1)
  --robots <n>            fleet size (default ${DEFAULT_CONFIG.robots})
  --pattern <name>        ${DEMAND_PATTERNS.join(' | ')} (default uniform)
  --rate <jobs/hour>      mean arrival rate (default ${DEFAULT_CONFIG.jobsPerHour})
  --hours <h>             length of the arrival window (default ${DEFAULT_CONFIG.horizon / 3600})
  --policies <a,b,...>    subset of ${POLICY_NAMES.join(',')} (default all)
  --batch-interval <s>    seconds between batch re-solves (default 10)
  --batch-age-weight <w>  batch credit per second a job has waited (default 0)
  --resamples <n>         bootstrap resamples (default 2000)
  --help                  show this text`;

export class UsageError extends Error {}

function number(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new UsageError(`--${name} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

function integer(name: string, raw: string | undefined, fallback: number, min: number): number {
  const value = number(name, raw, fallback, min);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} must be a whole number`);
  return value;
}

/** Parse command-line arguments. Returns null when help was asked for. */
export function parseOptions(argv: readonly string[]): CompareOptions | null {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        seeds: { type: 'string' },
        'first-seed': { type: 'string' },
        robots: { type: 'string' },
        pattern: { type: 'string' },
        rate: { type: 'string' },
        hours: { type: 'string' },
        policies: { type: 'string' },
        'batch-interval': { type: 'string' },
        'batch-age-weight': { type: 'string' },
        resamples: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help === true) return null;

  const pattern = values.pattern ?? 'uniform';
  if (!(DEMAND_PATTERNS as readonly string[]).includes(pattern)) {
    throw new UsageError(`--pattern must be one of ${DEMAND_PATTERNS.join(', ')}`);
  }
  const policies = (values.policies ?? POLICY_NAMES.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of policies) {
    if (!isPolicyName(name)) {
      throw new UsageError(`unknown policy "${name}"; choose from ${POLICY_NAMES.join(', ')}`);
    }
  }
  if (policies.length === 0) throw new UsageError('--policies must name at least one policy');

  return {
    seeds: integer('seeds', values.seeds, 20, 1),
    firstSeed: integer('first-seed', values['first-seed'], 1, 0),
    robots: integer('robots', values.robots, DEFAULT_CONFIG.robots, 1),
    pattern: pattern as DemandPattern,
    jobsPerHour: number('rate', values.rate, DEFAULT_CONFIG.jobsPerHour, 0),
    hours: number('hours', values.hours, DEFAULT_CONFIG.horizon / 3600, 0.01),
    policies: policies as PolicyName[],
    batchInterval: number('batch-interval', values['batch-interval'], 10, 0.1),
    batchAgeWeight: number('batch-age-weight', values['batch-age-weight'], 0, 0),
    resamples: integer('resamples', values.resamples, 2000, 1),
  };
}

export interface PolicySummary {
  policy: PolicyName;
  waitP50: Interval;
  waitP95: Interval;
  onTimeRate: Interval;
  deadheadShare: Interval;
  utilisation: Interval;
  dropped: Interval;
}

export interface Comparison {
  options: CompareOptions;
  /** Mean number of jobs per seed. The same for every policy. */
  jobsPerRun: number;
  rows: PolicySummary[];
}

/** Run every policy on every seed. Each seed's scenario is shared by all policies. */
export function runComparison(options: CompareOptions): Comparison {
  const perPolicy = new Map<PolicyName, Metrics[]>(options.policies.map((name) => [name, []]));
  let jobs = 0;
  for (let i = 0; i < options.seeds; i++) {
    const scenario = buildScenario({
      seed: options.firstSeed + i,
      robots: options.robots,
      pattern: options.pattern,
      jobsPerHour: options.jobsPerHour,
      horizon: options.hours * 3600,
    });
    jobs += scenario.jobs.length;
    for (const name of options.policies) {
      const policy = createPolicy(name, {
        batch: { interval: options.batchInterval, ageWeight: options.batchAgeWeight },
      });
      perPolicy.get(name)!.push(computeMetrics(new Simulation(scenario, policy).run()));
    }
  }
  const rows = options.policies.map((policy): PolicySummary => {
    const runs = perPolicy.get(policy)!;
    const summarise = (pick: (m: Metrics) => number): Interval =>
      bootstrapMean(runs.map(pick), { resamples: options.resamples, seed: 1 });
    return {
      policy,
      waitP50: summarise((m) => m.waitP50),
      waitP95: summarise((m) => m.waitP95),
      onTimeRate: summarise((m) => m.onTimeRate * 100),
      deadheadShare: summarise((m) => m.deadheadShare * 100),
      utilisation: summarise((m) => m.utilisation * 100),
      dropped: summarise((m) => m.dropped),
    };
  });
  return { options, jobsPerRun: jobs / options.seeds, rows };
}

function cell(interval: Interval): string {
  if (!Number.isFinite(interval.mean)) return 'n/a';
  return `${interval.mean.toFixed(1)} [${interval.lo.toFixed(1)}, ${interval.hi.toFixed(1)}]`;
}

/** Render the comparison as a Markdown table with aligned columns. */
export function formatTable(comparison: Comparison): string {
  const header = [
    'policy',
    'wait p50 (s)',
    'wait p95 (s)',
    'on time (%)',
    'deadhead (%)',
    'utilisation (%)',
    'dropped (jobs)',
  ];
  const body = comparison.rows.map((row) => [
    row.policy,
    cell(row.waitP50),
    cell(row.waitP95),
    cell(row.onTimeRate),
    cell(row.deadheadShare),
    cell(row.utilisation),
    cell(row.dropped),
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...body.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((text, i) => text.padEnd(widths[i]!)).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...body.map(line),
  ].join('\n');
}

export function formatReport(comparison: Comparison): string {
  const o = comparison.options;
  const lastSeed = o.firstSeed + o.seeds - 1;
  return [
    `pattern=${o.pattern} robots=${o.robots} rate=${o.jobsPerHour}/h hours=${o.hours} ` +
      `seeds=${o.firstSeed}..${lastSeed} (${comparison.jobsPerRun.toFixed(1)} jobs per run)`,
    `mean [bootstrap 95% interval] across seeds, ${o.resamples} resamples`,
    '',
    formatTable(comparison),
  ].join('\n');
}
