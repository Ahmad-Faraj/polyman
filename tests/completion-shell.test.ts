import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { generateCompletionScript } from '../src/completion';

const hasBash =
  process.platform !== 'win32' &&
  spawnSync('bash', ['-c', 'exit 0']).status === 0;

/** A small program shaped like polyman's real command tree. */
const buildProgram = (): Command => {
  const program = new Command();
  program.name('polyman').description('root');
  program
    .command('generate')
    .description('Generate tests for testsets')
    .option('-a, --all', 'Generate all testsets')
    .option('-t, --testset <name>', 'Generate specific testset')
    .option('-g, --group <name>', 'Generate specific group')
    .option('-i, --index <number>', 'Generate specific test');
  program.command('run <solution-name>').description('Run solution on tests');
  program.command('__complete <kind>', { hidden: true });
  return program;
};

/** Names that would run code if they reached the shell unquoted. */
const NASTY_NAMES = [
  'sol;touch X;x',
  '$(touch Y)',
  'a b',
  "it's",
  '*',
  '`touch Z`',
  'say "hi"',
  'back\\slash',
];

// A fake `polyman` that answers `__complete <kind> [-- ] [testset]` from
// files in $FAKE_NAMES: <kind> for names, groups.<testset> for groups.
const FAKE_POLYMAN = `#!/bin/sh
[ "$1" = "__complete" ] || exit 0
kind="$2"
shift 2
[ "$1" = "--" ] && shift
if [ "$kind" = "groups" ]; then
  cat "$FAKE_NAMES/groups.$1" 2>/dev/null
else
  cat "$FAKE_NAMES/$kind" 2>/dev/null
fi
exit 0
`;

// Runs the completion function for the given words (the last one is the word
// being completed) and prints every reply after eval, NUL-terminated, the way
// the shell would read the line once the user accepts the completion.
const DRIVER = `
source "$GEN"
COMP_WORDS=("$@")
COMP_CWORD=$(( $# - 1 ))
_polyman_complete
for r in "\${COMPREPLY[@]}"; do eval "printf '%s\\\\0' $r"; done
`;

describe.skipIf(!hasBash)('bash completion script (real bash)', () => {
  let root: string;
  let work: string;
  let bin: string;
  let names: string;
  let scriptPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'polyman-shell-'));
    work = join(root, 'work');
    bin = join(root, 'bin');
    names = join(root, 'names');
    for (const dir of [work, bin, names]) mkdirSync(dir);
    writeFileSync(join(bin, 'polyman'), FAKE_POLYMAN);
    chmodSync(join(bin, 'polyman'), 0o755);
    scriptPath = join(root, 'polyman.bash');
    writeFileSync(scriptPath, generateCompletionScript(buildProgram(), 'bash'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const setNames = (file: string, list: string[]) =>
    writeFileSync(join(names, file), list.map(n => `${n}\n`).join(''));

  /** Evaluated replies for the given words. */
  const complete = (...words: string[]): string[] => {
    const result = spawnSync('bash', ['-c', DRIVER, 'bash', ...words], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
        GEN: scriptPath,
        FAKE_NAMES: names,
      },
    });
    expect(result.stderr).toBe('');
    return result.stdout.split('\0').slice(0, -1);
  };

  it('gives back every name after eval and never runs one', () => {
    setNames('solutions', NASTY_NAMES);
    expect(complete('polyman', 'run', '')).toEqual(NASTY_NAMES);
    expect(readdirSync(work)).toEqual([]);
  });

  it('quotes names so they stay one word', () => {
    setNames('solutions', ['sol;touch X;x']);
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$GEN"; COMP_WORDS=(polyman run ""); COMP_CWORD=2; ' +
          '_polyman_complete; printf "%s\\n" "${COMPREPLY[@]}"',
      ],
      {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
          GEN: scriptPath,
          FAKE_NAMES: names,
        },
      }
    );
    expect(result.stdout).toBe('sol\\;touch\\ X\\;x\n');
  });

  it('matches a prefix typed as plain text', () => {
    setNames('solutions', NASTY_NAMES);
    expect(complete('polyman', 'run', 'sol')).toEqual(['sol;touch X;x']);
    expect(complete('polyman', 'run', 'a')).toEqual(['a b']);
    expect(complete('polyman', 'run', 'it')).toEqual(["it's"]);
    expect(complete('polyman', 'run', 'back')).toEqual(['back\\slash']);
    expect(readdirSync(work)).toEqual([]);
  });

  it('matches a prefix the user already typed with quoting', () => {
    setNames('solutions', NASTY_NAMES);
    expect(complete('polyman', 'run', 'sol\\;touch\\ X')).toEqual([
      'sol;touch X;x',
    ]);
    expect(complete('polyman', 'run', "'sol;touch X")).toEqual([
      'sol;touch X;x',
    ]);
    expect(complete('polyman', 'run', '"sol;touch X')).toEqual([
      'sol;touch X;x',
    ]);
    expect(complete('polyman', 'run', 'a\\ ')).toEqual(['a b']);
    expect(complete('polyman', 'run', '"a ')).toEqual(['a b']);
    expect(complete('polyman', 'run', "'it'\\''s")).toEqual(["it's"]);
    expect(complete('polyman', 'run', '"it\'s')).toEqual(["it's"]);
    expect(complete('polyman', 'run', '\\$\\(touch')).toEqual(['$(touch Y)']);
    expect(complete('polyman', 'run', "'$(touch")).toEqual(['$(touch Y)']);
    expect(complete('polyman', 'run', '"say \\"h')).toEqual(['say "hi"']);
    expect(complete('polyman', 'run', 'back\\\\')).toEqual(['back\\slash']);
    expect(readdirSync(work)).toEqual([]);
  });

  it('offers nothing when the typed text matches no name', () => {
    setNames('solutions', NASTY_NAMES);
    expect(complete('polyman', 'run', 'zzz')).toEqual([]);
    expect(complete('polyman', 'run', "'zz")).toEqual([]);
  });

  it('does not treat a typed * or ? as a pattern', () => {
    setNames('solutions', ['main', 'wa']);
    expect(complete('polyman', 'run', '*')).toEqual([]);
    expect(complete('polyman', 'run', 'm?')).toEqual([]);
  });

  it('quotes testset and group names too', () => {
    setNames('testsets', ['t;touch X', 'plain']);
    setNames('groups.t;touch X', ['g;touch Y', '$(touch Z)']);
    expect(complete('polyman', 'generate', '--testset', '')).toEqual([
      't;touch X',
      'plain',
    ]);
    expect(
      complete('polyman', 'generate', '--testset', 't\\;touch\\ X', '-g', '')
    ).toEqual(['g;touch Y', '$(touch Z)']);
    expect(readdirSync(work)).toEqual([]);
  });
});
