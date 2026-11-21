import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  formatReport,
  formatTable,
  parseOptions,
  runComparison,
  UsageError,
} from '../src/cli/comparison.ts';

describe('parseOptions', () => {
  it('fills in defaults', () => {
    expect(parseOptions([])).toEqual({
      seeds: 20,
      firstSeed: 1,
      robots: 6,
      pattern: 'uniform',
      jobsPerHour: 100,
      hours: 4,
      policies: ['nearest', 'fifo', 'chain', 'batch'],
      batchInterval: 10,
      batchAgeWeight: 0,
      resamples: 2000,
    });
  });

  it('reads the documented flags', () => {
    const options = parseOptions([
      '--seeds',
      '5',
      '--robots',
      '8',
      '--pattern',
      'lunch',
      '--policies',
      'batch, fifo',
      '--rate',
      '150.5',
      '--batch-interval',
      '30',
    ]);
    expect(options).toMatchObject({
      seeds: 5,
      robots: 8,
      pattern: 'lunch',
      policies: ['batch', 'fifo'],
      jobsPerHour: 150.5,
      batchInterval: 30,
    });
  });

  it('returns null for --help', () => {
    expect(parseOptions(['--help'])).toBeNull();
  });

  it.each([
    [['--seeds', '0']],
    [['--seeds', '2.5']],
    [['--robots', 'many']],
    [['--pattern', 'rush']],
    [['--policies', 'fifo,magic']],
    [['--policies', ',']],
    [['--unknown']],
  ])('rejects %j', (argv) => {
    expect(() => parseOptions(argv)).toThrow(UsageError);
  });
});

describe('runComparison', () => {
  const options = parseOptions(['--seeds', '3', '--robots', '4', '--hours', '1', '--rate', '80'])!;
  const comparison = runComparison(options);

  it('summarises every policy over the seeds', () => {
    expect(comparison.rows.map((r) => r.policy)).toEqual(options.policies);
    expect(comparison.jobsPerRun).toBeGreaterThan(40);
    for (const row of comparison.rows) {
      for (const interval of [row.waitP50, row.onTimeRate, row.deadheadShare, row.dropped]) {
        expect(interval.n).toBe(3);
        expect(interval.lo).toBeLessThanOrEqual(interval.mean);
        expect(interval.hi).toBeGreaterThanOrEqual(interval.mean);
      }
      expect(row.onTimeRate.mean).toBeGreaterThanOrEqual(0);
      expect(row.onTimeRate.mean).toBeLessThanOrEqual(100);
    }
  });

  it('is reproducible', () => {
    expect(runComparison(options)).toEqual(comparison);
  });

  it('formats an aligned Markdown table', () => {
    const lines = formatTable(comparison).split('\n');
    expect(lines.length).toBe(2 + options.policies.length);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines[0]).toMatch(/^\| policy +\| wait p50 \(s\)/);
    expect(lines[1]).toMatch(/^\| -+ \|/);
    expect(lines[2]).toMatch(/^\| nearest +\| \d+\.\d \[\d+\.\d, \d+\.\d\]/);
    expect(formatReport(comparison)).toContain(
      'pattern=uniform robots=4 rate=80/h hours=1 seeds=1..3',
    );
  });
});

describe('compare script', () => {
  const script = new URL('../src/cli/compare.ts', import.meta.url).pathname;

  it('runs under plain node and prints a row per policy', () => {
    const out = execFileSync(
      process.execPath,
      [script, '--seeds', '2', '--robots', '3', '--hours', '0.5', '--policies', 'fifo,batch'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('| fifo ');
    expect(out).toContain('| batch ');
    expect(out).not.toContain('| chain ');
  });

  it('exits with status 2 and usage on bad input', () => {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [script, '--pattern', 'rush'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      status = failure.status;
      stderr = failure.stderr;
    }
    expect(status).toBe(2);
    expect(stderr).toContain('--pattern must be one of');
    expect(stderr).toContain('Usage:');
  });
});
