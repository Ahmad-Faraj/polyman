import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, killTree, killUser } from '../src/kill-tree.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('descendants', () => {
  it('walks the whole tree, not just direct children', () => {
    const table = new Map<number, { ppid: number }>([
      [10, { ppid: 1 }],
      [11, { ppid: 10 }],
      [12, { ppid: 11 }],
      [13, { ppid: 10 }],
      [20, { ppid: 1 }],
    ]);
    expect(descendants(10, table).sort()).toEqual([11, 12, 13]);
  });

  it('stops on a loop in the table instead of running forever', () => {
    const table = new Map<number, { ppid: number }>([
      [10, { ppid: 11 }],
      [11, { ppid: 10 }],
    ]);
    expect(descendants(10, table)).toEqual([11]);
  });
});

describe('killTree', () => {
  it('kills a child that started its own process group, as polyman does for solutions', async () => {
    // the parent prints the pid of a grandchild that runs in a new session (its own group)
    const parent = spawn('sh', ['-c', 'setsid sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((done) => parent.stdout.once('data', (d: Buffer) => done(Number(String(d).trim()))));
    expect(alive(grandchild)).toBe(true);

    killTree(parent.pid!);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(parent.pid!)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });
});

describe('killUser', () => {
  it('refuses to kill our own user', () => {
    expect(() => killUser(process.getuid!())).toThrow("own user");
  });

  it('finds nobody for a user with no processes', () => {
    expect(killUser(4242424)).toBe(0);
  });
});
