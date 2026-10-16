#!/usr/bin/env node
/**
 * Upstream drift watcher. polyman depends on two things it doesn't control:
 * Polygon's API (documented in codeforces/polygon-misc) and testlib.h. This
 * compares the latest upstream commit of each with the one pinned in
 * corpus/upstream.json and fails, listing what changed, when either moved.
 * Run from a pipeline schedule; a failure is picked up like any other.
 *
 * Usage: node corpus/upstream.mjs [--update]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'upstream.json'
);

async function github(url) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${url}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${url}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const update = process.argv.includes('--update');
  const pins = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let moved = 0;
  for (const [name, pin] of Object.entries(pins)) {
    const query = pin.path ? `&path=${encodeURIComponent(pin.path)}` : '';
    const commits = await github(
      `/repos/${pin.repo}/commits?per_page=20${query}`
    );
    const index = commits.findIndex(c => c.sha === pin.seen);
    const fresh = index === -1 ? commits : commits.slice(0, index);
    if (!fresh.length) {
      console.log(`ok   ${name}: still at ${pin.seen.slice(0, 10)}`);
      continue;
    }
    moved++;
    console.log(
      `MOVED ${name} (${pin.repo}${pin.path ? `/${pin.path}` : ''}): ${pin.why}`
    );
    for (const c of fresh) {
      const title = c.commit.message.split('\n')[0];
      console.log(
        `  ${c.commit.committer.date.slice(0, 10)} ${title} ${c.html_url}`
      );
    }
    if (index === -1)
      console.log(`  (the pinned commit is not in the last 20; more changed)`);
    if (update) pin.seen = commits[0].sha;
  }
  if (update) fs.writeFileSync(FILE, `${JSON.stringify(pins, null, 2)}\n`);
  if (moved && !update) {
    console.log(
      'Upstream changed. Check polyman against it (for testlib: update corpus/vendor/testlib.h and keep every pinned verdict), then run with --update.'
    );
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
