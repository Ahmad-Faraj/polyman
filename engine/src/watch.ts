/**
 * Release watch: compares what production is doing against the signals the
 * reviewers said to watch for this change.
 */

export interface WatchItem {
  route: string;
  signal: 'error_rate' | 'p95_ms';
  max: number;
}

export interface RouteStats {
  count: number;
  errorRate: number;
  p95Ms: number;
}

export interface WatchResult {
  item: WatchItem;
  observed: number | null;
  /** false only when production was measured and broke the limit */
  ok: boolean;
  /** true when the route got no traffic, so nothing could be measured */
  unconfirmed?: boolean;
  source: 'review' | 'default';
}

/** Applied to every route on top of what the reviewers asked for. */
export const DEFAULT_WATCH: Omit<WatchItem, 'route'>[] = [{ signal: 'error_rate', max: 0.05 }];

/**
 * Reads the ```watch code block from a review note. Bad JSON yields no items,
 * and an item is dropped unless its limit is a finite number of zero or more:
 * a negative limit can never be met and would roll back a healthy release.
 */
export function parseWatchPlan(note: string): WatchItem[] {
  const match = note.match(/```watch[^\n]*\n([\s\S]*?)```/);
  if (!match) return [];
  try {
    const items: unknown = JSON.parse(match[1]);
    if (!Array.isArray(items)) return [];
    return (items as (WatchItem | null)[]).filter(
      (i): i is WatchItem =>
        !!i &&
        typeof i.route === 'string' &&
        (i.signal === 'error_rate' || i.signal === 'p95_ms') &&
        typeof i.max === 'number' &&
        Number.isFinite(i.max) &&
        i.max >= 0,
    );
  } catch {
    return [];
  }
}

export function evaluate(plan: WatchItem[], routes: Record<string, RouteStats>): WatchResult[] {
  // A review can only tighten the default limits, never loosen them: an
  // error-rate limit above the default budget is capped at the default.
  const capped = plan.map((item) => {
    const d = DEFAULT_WATCH.find((x) => x.signal === item.signal);
    return d && item.max > d.max ? { ...item, max: d.max } : item;
  });
  const results: WatchResult[] = capped.map((item) => check(item, routes, 'review'));
  for (const route of Object.keys(routes)) {
    for (const d of DEFAULT_WATCH) {
      if (!plan.some((p) => p.route === route && p.signal === d.signal)) results.push(check({ route, ...d }, routes, 'default'));
    }
  }
  return results;
}

function check(item: WatchItem, routes: Record<string, RouteStats>, source: WatchResult['source']): WatchResult {
  const stats = routes[item.route];
  // No traffic means we couldn't measure it, not that production is broken.
  // Report it, but don't fail the release (and roll it back) over it.
  if (!stats || !stats.count) return { item, observed: null, ok: true, unconfirmed: true, source };
  const observed = item.signal === 'error_rate' ? stats.errorRate : stats.p95Ms;
  return { item, observed, ok: observed <= item.max, source };
}

export function describe(r: WatchResult): string {
  const fmt = (v: number) => (r.item.signal === 'error_rate' ? `${(v * 100).toFixed(1)}%` : `${Math.round(v)} ms`);
  const name = r.item.signal === 'error_rate' ? 'error rate' : 'p95';
  if (r.observed === null) return `${r.item.route} ${name}: no traffic seen, can't confirm`;
  return `${r.item.route} ${name} ${fmt(r.observed)} (limit ${fmt(r.item.max)})${r.ok ? '' : ' - over the limit'}`;
}
