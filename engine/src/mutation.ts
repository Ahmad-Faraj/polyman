/**
 * The mutation score of a Stryker JSON report: the share of planted bugs the
 * tests caught (killed or timed out) among the mutants Stryker could judge
 * (killed, timed out, survived, not covered). Ignored mutants and those that
 * didn't compile or crashed the run aren't judgements of the tests.
 */
export interface MutationScore {
  caught: number;
  judged: number;
  timeouts: number;
  /** caught / judged, in percent */
  score: number;
}

const CAUGHT = new Set(['Killed', 'Timeout']);
const JUDGED = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage']);

/** Throws when the report has no files, or no mutant was judged: a crashed or empty run isn't a score. */
export function scoreOf(report: unknown): MutationScore {
  const files = (report as { files?: Record<string, { mutants?: { status?: string }[] }> } | null)?.files;
  if (!files || typeof files !== 'object') throw new Error('not a Stryker report: no "files"');
  const mutants = Object.values(files).flatMap((f) => (Array.isArray(f?.mutants) ? f.mutants : []));
  const caught = mutants.filter((m) => CAUGHT.has(m.status ?? '')).length;
  const judged = mutants.filter((m) => JUDGED.has(m.status ?? '')).length;
  const timeouts = mutants.filter((m) => m.status === 'Timeout').length;
  if (!judged) throw new Error(`no mutant was judged (${mutants.length} in the report): the run crashed, or the file under test moved`);
  return { caught, judged, timeouts, score: Math.round((1000 * caught) / judged) / 10 };
}
