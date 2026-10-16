/**
 * Kills what a verification started.
 *
 * killTree: a process and everything below it. polyman runs each solution in
 * its own process group (so it can kill a TLE solution's whole tree), which
 * means killing polyman's group alone leaves those solutions running. So the
 * tree is read from /proc first, while the parent links still exist, and then
 * every process and process group in it is killed.
 *
 * killUser: every process of one user. In the image, uploaded code runs as a
 * user of its own, so after each run this also catches anything that escaped
 * the tree (a double fork, a daemon in a new session).
 */
import { readFileSync, readdirSync } from 'node:fs';

interface Proc {
  ppid: number;
  pgrp: number;
  uid: number;
}

function processTable(): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // the command name (2nd field) may hold spaces and parens, so read after the last ')'
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // state, ppid, pgrp
      const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`, 'utf8'))?.[1];
      table.set(Number(name), { ppid: Number(ppid), pgrp: Number(pgrp), uid: Number(uid ?? -1) });
    } catch {
      // the process ended while we were looking
    }
  }
  return table;
}

const safeTable = () => {
  try {
    return processTable();
  } catch {
    return new Map<number, Proc>(); // no /proc (not Linux)
  }
};

export function descendants(root: number, table: Map<number, Pick<Proc, 'ppid'>> = safeTable()): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
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

const kill = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
};

export function killTree(root: number): void {
  const table = safeTable();
  const pids = [root, ...descendants(root, table)];
  for (const g of new Set(pids.map((p) => table.get(p)?.pgrp ?? p))) kill(-g);
  for (const p of pids) kill(p);
}

/** Kills every process owned by `uid`; never our own user. Returns how many it found. */
export function killUser(uid: number): number {
  if (uid === process.getuid?.()) throw new Error("refusing to kill the service's own user");
  const pids = [...safeTable()].filter(([, p]) => p.uid === uid).map(([pid]) => pid);
  for (const p of pids) kill(p);
  return pids.length;
}
