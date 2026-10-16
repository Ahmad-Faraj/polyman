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
 * the tree (a double fork, a daemon in a new session, a fork loop).
 *
 * removeFilesOf: what that user left in the shared temp folders, so nothing
 * carries over to the next visitor.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

interface Proc {
  ppid: number;
  pgrp: number;
  uid: number;
  /** already dead, waiting for its parent to collect it: it can't do anything */
  zombie: boolean;
}

function processTable(): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // the command name (2nd field) may hold spaces and parens, so read after the last ')'
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const [state, ppid, pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`, 'utf8'))?.[1];
      table.set(Number(name), { ppid: Number(ppid), pgrp: Number(pgrp), uid: Number(uid ?? -1), zombie: state === 'Z' });
    } catch {
      // the process ended while we were looking
    }
  }
  return table;
}

const safeTable = () => {
  try {
    return processTable();
  } catch (err) {
    // no /proc means not Linux (a developer's machine); anything else is a real problem
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map<number, Proc>();
    throw err;
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err; // ESRCH: already gone
  }
};

export function killTree(root: number): void {
  const table = safeTable();
  const pids = [root, ...descendants(root, table)];
  for (const g of new Set(pids.map((p) => table.get(p)?.pgrp ?? p))) kill(-g);
  for (const p of pids) kill(p);
}

const pidsOf = (uid: number) =>
  [...safeTable()].filter(([, p]) => p.uid === uid && !p.zombie).map(([pid]) => pid);

/**
 * Kills every process owned by `uid`; never our own user. First from inside
 * that user with kill(-1), which the kernel applies to all of the user's
 * processes at once, so a fork loop can't slip past it; then from outside
 * until none are left. Returns how many the outside passes still found.
 */
export function killUser(uid: number, gid = uid): number {
  if (uid === process.getuid?.()) throw new Error("refusing to kill the service's own user");
  spawnSync('kill', ['-9', '--', '-1'], { uid, gid, stdio: 'ignore', timeout: 5000 });
  let found = 0;
  for (let pass = 0; pass < 5; pass++) {
    const pids = pidsOf(uid);
    if (!pids.length) return found;
    found += pids.length;
    for (const p of pids) kill(p);
  }
  if (pidsOf(uid).length) throw new Error(`processes of uid ${uid} survived five kill passes`);
  return found;
}

/** Removes everything owned by `uid` directly inside these folders. */
export function removeFilesOf(uid: number, dirs: string[]): void {
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // the folder doesn't exist here
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (lstatSync(path).uid === uid) rmSync(path, { recursive: true, force: true });
      } catch {
        // gone already
      }
    }
  }
}
