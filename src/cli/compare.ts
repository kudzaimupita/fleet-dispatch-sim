import { formatReport, parseOptions, runComparison, USAGE, UsageError } from './comparison.ts';

try {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) console.log(USAGE);
  else console.log(formatReport(runComparison(options)));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`${error.message}\n\n${USAGE}`);
  process.exitCode = 2;
}
