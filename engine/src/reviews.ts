/**
 * Finds merge requests whose head pipeline passed a while ago and that still
 * have no review of that head. A reviewer session can end or crash without a
 * note, and nothing else tells a person; this is how doctor notices.
 */

export interface OpenMr {
  iid: number;
  sha: string;
  draft: boolean;
  /** the newest pipeline of the MR, if any */
  pipeline: { sha: string; status: string; finishedAt: string | null } | null;
  /** short or full SHAs that "Review of SHA" notes by the reviewer account cover */
  reviewedShas: string[];
}

/** MRs that should have a review of their head by now and don't. */
export function missingReviews(mrs: OpenMr[], now: Date, runningSince: string[], graceMinutes = 40): OpenMr[] {
  return mrs.filter((mr) => {
    const p = mr.pipeline;
    if (mr.draft || !p || p.sha !== mr.sha || p.status !== 'success' || !p.finishedAt) return false;
    const finished = Date.parse(p.finishedAt);
    if (now.getTime() - finished < graceMinutes * 60_000) return false;
    // a reviewer session started after the pipeline may still be on it
    if (runningSince.some((s) => Date.parse(s) >= finished)) return false;
    return !mr.reviewedShas.some((s) => mr.sha.startsWith(s) || s.startsWith(mr.sha.slice(0, s.length)));
  });
}
