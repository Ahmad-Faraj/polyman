/**
 * Kills a process and everything it started. polyman runs each solution in
 * its own process group (so it can kill a TLE solution's whole tree), which
 * means killing polyman's group alone leaves those solutions running. So the
 * tree is read from /proc first, while the parent links still exist, and then
 * every process and process group in it is killed.
 */
import { readFileSync, readdirSync } from 'node:fs';

/** pid -> [parent pid, process group] for every process we can see. */
function processTable(): Map<number, [number, number]> {
  const table = new Map<number, [number, number]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // the command name (2nd field) may hold spaces and parens, so read after the last ')'
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // state, ppid, pgrp
      table.set(Number(name), [Number(ppid), Number(pgrp)]);
    } catch {
      // the process ended while we were looking
    }
  }
  return table;
}

export function descendants(root: number, table = processTable()): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, [ppid]] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  seen.delete(root);
  return [...seen];
}

export function killTree(root: number): void {
  let table: Map<number, [number, number]>;
  try {
    table = processTable();
  } catch {
    table = new Map(); // no /proc (not Linux): fall back to the root's group
  }
  const pids = [root, ...descendants(root, table)];
  const groups = new Set(pids.map((p) => table.get(p)?.[1] ?? p));
  for (const g of groups) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const p of pids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
