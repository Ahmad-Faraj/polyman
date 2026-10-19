/**
 * Finds merge requests whose head pipeline passed a while ago and that still
 * have no review of that head. Two reasons, told apart: a first review whose
 * session ended or crashed without a note, or a later head that waits for a
 * person's mention (the reviewer reviews an MR once on its own, then only when
 * mentioned). Nothing else tells a person before they merge an unreviewed
 * head; this is how doctor notices.
 */

export interface OpenMr {
  iid: number;
  sha: string;
  draft: boolean;
  /** the newest pipeline of the MR, if any */
  pipeline: { sha: string; status: string; finishedAt: string | null } | null;
  /** short or full SHAs that "Review of SHA" notes by the reviewer account cover, newest first */
  reviewedShas: string[];
}

/** Why the head has no review: no review at all yet, or one of an older head that waits for a mention. */
export const missingBecause = (mr: OpenMr): 'no review yet' | 'waits for a mention' => (mr.reviewedShas.length ? 'waits for a mention' : 'no review yet');

/** MRs that should have a review of their head by now and don't. */
export function missingReviews(mrs: OpenMr[], now: Date, runningSince: string[], graceMinutes = 40): OpenMr[] {
  return mrs.filter((mr) => {
    const p = mr.pipeline;
    if (mr.draft || !p || p.sha !== mr.sha || p.status !== 'success' || !p.finishedAt) return false;
    const finished = Date.parse(p.finishedAt);
    if (now.getTime() - finished < graceMinutes * 60_000) return false;
    // a reviewer session started after the pipeline may still be on it (the
    // session's MR can't be read without its log, so any such session counts)
    if (runningSince.some((s) => Date.parse(s) >= finished)) return false;
    const head = mr.sha.toLowerCase();
    return !mr.reviewedShas.map((s) => s.toLowerCase()).some((s) => head.startsWith(s));
  });
}

/** The SHAs that "Review of SHA" notes by the reviewer account cover (anyone else can type the line). */
export function reviewedShasFrom(notes: { body: string; author: { username: string } }[], reviewer: string | undefined): string[] {
  if (!reviewer) return [];
  return notes
    .filter((n) => n.author.username === reviewer)
    .map((n) => n.body.trim().match(/^\**Review of ([0-9a-f]{7,40})\b/i)?.[1])
    .filter((s): s is string => !!s);
}
