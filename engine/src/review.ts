import { loadConfig } from './config.ts';

/**
 * How the engine recognises notes the Duo flows leave on an MR. A note only
 * counts if the flow's own service account wrote it. The accounts are matched
 * by exact username: a prefix could be claimed by anyone who registers a
 * look-alike account on a public instance.
 */

interface Note {
  body: string;
  author?: { username: string };
}

/** Service accounts GitLab created when the flows were enabled, from .autonomy.yml. */
const { reviewerAccount: DEFAULT_REVIEWER, fixerAccount: DEFAULT_FIXER } = loadConfig().agents;

// Comma-separated exact usernames. A blank value (or one with no names, like
// " " or ",") keeps the default rather than trusting nobody, or everybody.
const parse = (value: string | undefined) => new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const accounts = (value: string | undefined, fallback: string) => {
  const set = parse(value);
  return set.size ? set : parse(fallback);
};

const env = process.env;
const REVIEWERS = accounts(env.AUTONOMY_REVIEWER_ACCOUNT, DEFAULT_REVIEWER);
const FIXERS = accounts(env.AUTONOMY_FIXER_ACCOUNT, DEFAULT_FIXER);

const by = (note: Note, allowed: Set<string>) => !!note.author && allowed.has(note.author.username);

/** The reviewer's note starts with "Review of <sha>:" and is written by the mr-reviewer flow. */
export const isReviewNote = (note: Note) => by(note, REVIEWERS) && /^\**Review of [0-9a-f]{7,40}\b/i.test(note.body.trim());

/** The pipeline fixer's notes start with "Pipeline fix:" and are written by the pipeline-fixer flow. */
export const isPipelineFixNote = (note: Note) => by(note, FIXERS) && /^\**Pipeline fix:/i.test(note.body.trim());
