/**
 * @fileoverview Shell auto-completion for the polyman CLI.
 * Builds bash, zsh and fish completion scripts from the Commander command
 * tree, so the static part (commands and options) always matches `cli.ts`.
 * Values that depend on the problem (testset, group and solution names) are
 * read from `Config.json` through the hidden `polyman __complete` command.
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Shells a completion script can be generated for. */
export const SHELLS = ['bash', 'zsh', 'fish'] as const;

/** A shell supported by {@link generateCompletionScript}. */
export type Shell = (typeof SHELLS)[number];

/** Kinds of names `polyman __complete` can print from `Config.json`. */
export const COMPLETION_KINDS = [
  'testsets',
  'solutions',
  'generators',
  'groups',
] as const;

/** A kind of name read from `Config.json` for dynamic completion. */
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

/**
 * Checks whether a string names a supported shell.
 * @param value - Candidate shell name
 * @returns True for `bash`, `zsh` and `fish`
 */
export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a kind `polyman __complete` understands.
 * @param value - Candidate kind
 * @returns True for `testsets`, `solutions`, `generators` and `groups`
 */
export function isCompletionKind(value: string): value is CompletionKind {
  return (COMPLETION_KINDS as readonly string[]).includes(value);
}

// ============================================================================
// DYNAMIC VALUES FROM Config.json
// ============================================================================

/** Returns the value as a plain object, or undefined for anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the `name` of every object in a list, skipping malformed entries. */
function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const item of list as unknown[]) {
    const name = asRecord(item)?.['name'];
    if (typeof name === 'string' && name !== '' && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Reads names for dynamic completion from `Config.json` in a directory.
 * Never throws: a missing file, invalid JSON or an unexpected shape gives an
 * empty list, so the shell falls back to static completion.
 *
 * @param kind - Which names to read
 * @param testset - Testset whose groups to list (only used for `groups`)
 * @param cwd - Directory holding `Config.json` (default: current directory)
 * @returns Unique names, in the order they appear in the file
 *
 * @example
 * readCompletionNames('solutions'); // ['main', 'wa-solution']
 * readCompletionNames('groups', 'tests'); // ['samples', 'main']
 */
export function readCompletionNames(
  kind: CompletionKind,
  testset?: string,
  cwd: string = process.cwd()
): string[] {
  let config: Record<string, unknown> | undefined;
  try {
    config = asRecord(
      JSON.parse(readFileSync(join(cwd, 'Config.json'), 'utf8')) as unknown
    );
  } catch {
    return [];
  }
  if (!config) return [];

  switch (kind) {
    case 'solutions':
      return namesOf(config['solutions']);
    case 'generators':
      return namesOf(config['generators']);
    case 'testsets':
      return namesOf(config['testsets']);
    case 'groups': {
      if (!testset || !Array.isArray(config['testsets'])) return [];
      const match = (config['testsets'] as unknown[]).find(
        candidate => asRecord(candidate)?.['name'] === testset
      );
      return namesOf(asRecord(match)?.['groups']);
    }
  }
}

// ============================================================================
// COMMAND MODEL
// ============================================================================

/** Option values that are completed from `Config.json`, by long flag. */
const OPTION_KINDS: Readonly<Record<string, CompletionKind>> = {
  '--testset': 'testsets',
  '--group': 'groups',
};

/**
 * What a command's first positional argument completes to, by command path:
 * names read from `Config.json` and/or fixed words.
 */
const POSITIONALS: Readonly<
  Record<string, { kind?: CompletionKind; extra: readonly string[] }>
> = {
  run: { kind: 'solutions', extra: [] },
  test: { kind: 'solutions', extra: ['validator', 'checker'] },
  completion: { extra: SHELLS },
};

interface OptionModel {
  /** Flags that select the option, short first: `['-t', '--testset']`. */
  flags: string[];
  takesValue: boolean;
  description: string;
  kind: CompletionKind | undefined;
}

interface CommandModel {
  /** Space-separated command path; empty for the program itself. */
  path: string;
  subcommands: { name: string; description: string }[];
  options: OptionModel[];
  positional: { kind: CompletionKind | undefined; extra: string[] } | undefined;
}

/** Collapses whitespace so a description fits on one completion line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Walks the Commander tree into a flat list of visible commands. */
function buildModel(program: Command): CommandModel[] {
  const models: CommandModel[] = [];

  const visit = (cmd: Command, path: string): void => {
    const children = cmd
      .createHelp()
      .visibleCommands(cmd)
      .filter(child => child.name() !== 'help');

    const subcommands: CommandModel['subcommands'] = [];
    for (const child of children) {
      for (const name of [child.name(), ...child.aliases()]) {
        subcommands.push({ name, description: oneLine(child.description()) });
      }
    }

    const options = cmd.options
      .filter(option => !option.hidden)
      .map(
        (option): OptionModel => ({
          flags: [option.short, option.long].filter(
            (flag): flag is string => flag !== undefined
          ),
          takesValue: option.required || option.optional,
          description: oneLine(option.description),
          kind: option.long ? OPTION_KINDS[option.long] : undefined,
        })
      );

    const positional = POSITIONALS[path];
    models.push({
      path,
      subcommands,
      options,
      positional: positional
        ? { kind: positional.kind, extra: [...positional.extra] }
        : undefined,
    });

    for (const child of children) {
      visit(child, path === '' ? child.name() : `${path} ${child.name()}`);
    }
  };

  visit(program, '');
  return models;
}

/** The kind of value an option waits for, as the scripts track it. */
function pendingKind(option: OptionModel): 'testset' | 'group' | 'value' {
  if (option.kind === 'testsets') return 'testset';
  if (option.kind === 'groups') return 'group';
  return 'value';
}

/** `command path|flag` keys of every option that takes a value, by kind. */
function valueFlagKeys(
  models: CommandModel[]
): Record<'testset' | 'group' | 'value', string[]> {
  const keys: Record<'testset' | 'group' | 'value', string[]> = {
    testset: [],
    group: [],
    value: [],
  };
  for (const model of models) {
    for (const option of model.options) {
      if (!option.takesValue) continue;
      for (const flag of option.flags) {
        keys[pendingKind(option)].push(`${model.path}|${flag}`);
      }
    }
  }
  return keys;
}

/** `parent path|name` keys of every subcommand. */
function subcommandKeys(models: CommandModel[]): string[] {
  return models.flatMap(model =>
    model.subcommands.map(sub => `${model.path}|${sub.name}`)
  );
}

/** Quotes text for bash and zsh single-quoted strings. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Quotes text for fish single-quoted strings. */
function fishQuote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ============================================================================
// BASH
// ============================================================================

/** Generates the bash completion script. */
function bashScript(models: CommandModel[]): string {
  const keys = valueFlagKeys(models);
  const lines: string[] = [
    '# bash completion for polyman',
    '# Install: eval "$(polyman completion bash)" in ~/.bashrc',
    '_polyman_names() {',
    '  "${COMP_WORDS[0]}" __complete "$@" 2>/dev/null',
    '}',
    '# Removes shell quoting from $1 without evaluating it (no $(...) or globs).',
    '# The result is left in _polyman_unq.',
    '_polyman_unquote() {',
    '  local s="$1" out="" c next q="" i',
    '  for (( i = 0; i < ${#s}; i++ )); do',
    '    c="${s:i:1}"',
    '    if [[ $q == "\'" ]]; then',
    '      if [[ $c == "\'" ]]; then q=""; else out+="$c"; fi',
    '    elif [[ $c == "\\\\" ]]; then',
    '      next="${s:i+1:1}"',
    "      if [[ $q == '\"' ]]; then",
    '        case "$next" in',
    "          '$'|'`'|'\"'|\"\\\\\") out+=\"$next\"; i=$((i + 1)) ;;",
    '          *) out+="$c" ;;',
    '        esac',
    '      else',
    '        out+="$next"; i=$((i + 1))',
    '      fi',
    '    elif [[ -n $q ]]; then',
    '      if [[ $c == "$q" ]]; then q=""; else out+="$c"; fi',
    '    elif [[ $c == "\'" || $c == \'"\' ]]; then',
    '      q="$c"',
    '    else',
    '      out+="$c"',
    '    fi',
    '  done',
    '  _polyman_unq="$out"',
    '  _polyman_q="$q"',
    '}',
    '# Names come from Config.json and are untrusted: each reply is quoted so Tab',
    '# then Enter never runs part of a name as a command. Readline puts a reply',
    '# inside a quote the user already opened (_polyman_q), so then the name is',
    "# escaped for that quote; never with $'...' (its quote would close it).",
    '_polyman_reply_names() {',
    '  local name quoted c i',
    '  _polyman_unquote "$cur"',
    '  while IFS= read -r name; do',
    '    if [[ $name == "$_polyman_unq"* ]]; then',
    '      if [[ -z $_polyman_q ]]; then',
    '        printf -v quoted %q "$name"',
    '      else',
    '        quoted=""',
    '        for (( i = 0; i < ${#name}; i++ )); do',
    '          c="${name:i:1}"',
    '          if [[ $_polyman_q == "\'" ]]; then',
    '            if [[ $c == "\'" ]]; then quoted+="\'\\\\\'\'"; else quoted+="$c"; fi',
    '          else',
    '            case "$c" in',
    "              \"\\\\\"|'\"'|'$'|'`') quoted+=\"\\\\$c\" ;;",
    // an interactive bash expands ! inside double quotes (history), so close
    // the quote, add a single-quoted !, and reopen it
    '              \'!\') quoted+="\\"\'!\'\\"" ;;',
    '              *) quoted+="$c" ;;',
    '            esac',
    '          fi',
    '        done',
    // readline drops a leading open-quote character from the reply and adds
    // no closing quote when the reply ends with one: double them so both stay
    '        [[ ${quoted:0:1} == "$_polyman_q" ]] && quoted="$_polyman_q$quoted"',
    '        [[ ${quoted: -1} == "$_polyman_q" ]] && quoted+="$_polyman_q"',
    '      fi',
    '      COMPREPLY+=("$quoted")',
    '    fi',
    '  done < <(_polyman_names "$@")',
    '}',
    '_polyman_complete() {',
    '  local cur="${COMP_WORDS[COMP_CWORD]}" cmd="" testset="" pending="" npos=0 w i',
    '  local flag val hasval subs="" opts="" dyn="" extra=""',
    '  COMPREPLY=()',
    '  for (( i = 1; i < COMP_CWORD; i++ )); do',
    '    w="${COMP_WORDS[i]}"',
    '    if [[ -n $pending ]]; then',
    '      # bash splits --testset=tests into --testset, = and tests',
    '      [[ $w == = && ${COMP_WORDS[i-1]} == --* ]] && continue',
    '      if [[ $pending == testset ]]; then',
    '        _polyman_unquote "$w"',
    '        testset="$_polyman_unq"',
    '      fi',
    '      pending=""',
    '      continue',
    '    fi',
    '    if [[ $w == -* ]]; then',
  ];

  const pendingCases = (['testset', 'group', 'value'] as const).filter(
    kind => keys[kind].length > 0
  );
  lines.push(
    '      flag="$w" val="" hasval=0',
    '      if [[ $w == --*=* ]]; then flag="${w%%=*}" val="${w#*=}" hasval=1; fi'
  );
  if (pendingCases.length > 0) {
    lines.push('      case "$cmd|$flag" in');
    for (const kind of pendingCases) {
      lines.push(
        `        ${keys[kind].map(shellQuote).join('|')}) pending=${kind} ;;`
      );
    }
    lines.push('      esac');
  } else {
    lines.push('      :');
  }
  lines.push(
    '      if (( hasval )) && [[ -n $pending ]]; then',
    '        if [[ $pending == testset ]]; then',
    '          _polyman_unquote "$val"',
    '          testset="$_polyman_unq"',
    '        fi',
    '        pending=""',
    '      fi'
  );

  lines.push(
    '    else',
    '      case "$cmd|$w" in',
    `        ${subcommandKeys(models).map(shellQuote).join('|')}) cmd="\${cmd:+$cmd }$w" ;;`,
    '        *) npos=$((npos + 1)) ;;',
    '      esac',
    '    fi',
    '  done',
    '  if [[ -n $pending ]]; then',
    '    [[ $cur == = ]] && cur=""',
    '    case $pending in',
    '      testset) _polyman_reply_names testsets ;;',
    '      group) _polyman_reply_names groups -- "$testset" ;;',
    '    esac',
    '    return 0',
    '  fi',
    '  case "$cmd" in'
  );

  for (const model of models) {
    const parts = [
      `subs=${shellQuote(model.subcommands.map(sub => sub.name).join(' '))}`,
      `opts=${shellQuote(model.options.flatMap(option => option.flags).join(' '))}`,
    ];
    if (model.positional?.kind) parts.push(`dyn=${model.positional.kind}`);
    if (model.positional && model.positional.extra.length > 0) {
      parts.push(`extra=${shellQuote(model.positional.extra.join(' '))}`);
    }
    lines.push(`    ${shellQuote(model.path)}) ${parts.join(' ')} ;;`);
  }

  lines.push(
    '  esac',
    '  if [[ $cur == -* ]]; then',
    '    COMPREPLY=($(compgen -W "$opts" -- "$cur"))',
    '    return 0',
    '  fi',
    '  if (( npos == 0 )); then',
    '    COMPREPLY=($(compgen -W "$subs $extra" -- "$cur"))',
    '    [[ -n $dyn ]] && _polyman_reply_names "$dyn"',
    '  fi',
    '  return 0',
    '}',
    '# -o default: fall back to file names when nothing matches',
    'complete -o default -F _polyman_complete polyman',
    ''
  );
  return lines.join('\n');
}

// ============================================================================
// ZSH
// ============================================================================

/**
 * One `name:description` entry for zsh's `_describe`. A `:` in the name
 * would end it early, so it is escaped as `\:`, and a backslash is escaped
 * first so it cannot escape the next character.
 */
export function zshDescribeEntry(name: string, description: string): string {
  return `${name.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}:${description}`;
}

/** Formats `name:description` entries for zsh's `_describe`. */
function zshDescribed(entries: { name: string; description: string }[]) {
  return entries
    .map(entry => shellQuote(zshDescribeEntry(entry.name, entry.description)))
    .join(' ');
}

/** Generates the zsh completion script. */
function zshScript(models: CommandModel[]): string {
  const keys = valueFlagKeys(models);
  const lines: string[] = [
    '#compdef polyman',
    '# zsh completion for polyman',
    '# Install: eval "$(polyman completion zsh)" in ~/.zshrc, after compinit,',
    '# or save the output as _polyman in a directory on your $fpath.',
    '_polyman_names() {',
    '  "${words[1]}" __complete "$@" 2>/dev/null',
    '}',
    '_polyman() {',
    '  local cur="${words[CURRENT]}" cmd="" testset="" pending="" npos=0 w dyn="" files=0 flag val hasval',
    '  local -a opts subs extra names',
    '  for w in "${(@)words[2,CURRENT-1]}"; do',
    '    if [[ -n $pending ]]; then',
    '      [[ $pending == testset ]] && testset="$w"',
    '      pending=""',
    '      continue',
    '    fi',
    '    if [[ $w == -* ]]; then',
  ];

  const pendingCases = (['testset', 'group', 'value'] as const).filter(
    kind => keys[kind].length > 0
  );
  lines.push(
    '      flag="$w" val="" hasval=0',
    '      if [[ $w == --*=* ]]; then flag="${w%%=*}" val="${w#*=}" hasval=1; fi'
  );
  if (pendingCases.length > 0) {
    lines.push('      case "$cmd|$flag" in');
    for (const kind of pendingCases) {
      lines.push(
        `        ${keys[kind].map(shellQuote).join('|')}) pending=${kind} ;;`
      );
    }
    lines.push('      esac');
  } else {
    lines.push('      :');
  }
  lines.push(
    '      if (( hasval )) && [[ -n $pending ]]; then',
    '        [[ $pending == testset ]] && testset="$val"',
    '        pending=""',
    '      fi'
  );

  lines.push(
    '    else',
    '      case "$cmd|$w" in',
    `        ${subcommandKeys(models).map(shellQuote).join('|')}) cmd="\${cmd:+$cmd }$w" ;;`,
    '        *) npos=$((npos + 1)) ;;',
    '      esac',
    '    fi',
    '  done',
    '  case $pending in',
    '    testset) names=(${(f)"$(_polyman_names testsets)"}); compadd -a names; return 0 ;;',
    '    group) names=(${(f)"$(_polyman_names groups -- "$testset")"}); compadd -a names; return 0 ;;',
    '    value) _files; return 0 ;;',
    '  esac',
    '  case "$cmd" in'
  );

  for (const model of models) {
    const optionEntries = model.options.flatMap(option =>
      option.flags.map(flag => ({
        name: flag,
        description: option.description,
      }))
    );
    const parts = [
      `opts=(${zshDescribed(optionEntries)})`,
      `subs=(${zshDescribed(model.subcommands)})`,
    ];
    if (model.positional?.kind) parts.push(`dyn=${model.positional.kind}`);
    if (model.positional && model.positional.extra.length > 0) {
      parts.push(`extra=(${model.positional.extra.map(shellQuote).join(' ')})`);
    }
    if (model.subcommands.length === 0 && !model.positional) {
      parts.push('files=1');
    }
    lines.push(`    ${shellQuote(model.path)}) ${parts.join(' ')} ;;`);
  }

  lines.push(
    '  esac',
    '  if [[ $cur == -* ]]; then',
    "    _describe -t options 'option' opts",
    '    return 0',
    '  fi',
    '  if (( npos == 0 )); then',
    "    (( ${#subs} )) && _describe -t commands 'command' subs",
    '    (( ${#extra} )) && compadd -a extra',
    '    if [[ -n $dyn ]]; then',
    '      names=(${(f)"$(_polyman_names $dyn)"})',
    '      compadd -a names',
    '    fi',
    '  fi',
    '  (( files )) && _files',
    '  return 0',
    '}',
    'if [[ "$funcstack[1]" == _polyman ]]; then',
    '  _polyman "$@"',
    'else',
    '  compdef _polyman polyman',
    'fi',
    ''
  );
  return lines.join('\n');
}

// ============================================================================
// FISH
// ============================================================================

/** Generates the fish completion script. */
function fishScript(models: CommandModel[]): string {
  const keys = valueFlagKeys(models);
  const lines: string[] = [
    '# fish completion for polyman',
    '# Install: polyman completion fish > ~/.config/fish/completions/polyman.fish',
    'function __polyman_names',
    '  command polyman __complete $argv 2>/dev/null',
    'end',
    '# Prints one field of the command line so far: cmd, pending, npos or testset.',
    'function __polyman_scan',
    "  set -l cmd ''",
    "  set -l pending ''",
    "  set -l testset ''",
    '  set -l npos 0',
    '  set -l tokens (commandline -opc)',
    '  set -e tokens[1]',
    '  for w in $tokens',
    '    if test -n "$pending"',
    '      test "$pending" = testset; and set testset $w',
    "      set pending ''",
    '      continue',
    '    end',
    '    switch "$w"',
    "      case '-*'",
  ];

  const pendingCases = (['testset', 'group', 'value'] as const).filter(
    kind => keys[kind].length > 0
  );
  if (pendingCases.length > 0) {
    lines.push(
      '        set -l flag $w',
      "        set -l val ''",
      '        set -l hasval 0',
      "        if string match -q -- '--*=*' $w",
      "          set flag (string replace -r '=.*' '' -- $w)",
      "          set val (string replace -r '^[^=]*=' '' -- $w)",
      '          set hasval 1',
      '        end',
      '        switch "$cmd|$flag"'
    );
    for (const kind of pendingCases) {
      lines.push(
        `          case ${keys[kind].map(fishQuote).join(' ')}`,
        `            set pending ${kind}`
      );
    }
    lines.push(
      '        end',
      '        if test $hasval -eq 1; and test -n "$pending"',
      '          test "$pending" = testset; and set testset $val',
      "          set pending ''",
      '        end'
    );
  }

  lines.push(
    "      case '*'",
    '        switch "$cmd|$w"',
    `          case ${subcommandKeys(models).map(fishQuote).join(' ')}`,
    '            set cmd (string trim -- "$cmd $w")',
    "          case '*'",
    '            set npos (math $npos + 1)',
    '        end',
    '    end',
    '  end',
    '  switch $argv[1]',
    '    case cmd',
    '      echo $cmd',
    '    case pending',
    '      echo $pending',
    '    case npos',
    '      echo $npos',
    '    case testset',
    '      echo $testset',
    '  end',
    'end',
    'function __polyman_in',
    '  set -l c (__polyman_scan cmd)',
    '  test "$c" = "$argv[1]"',
    'end',
    'function __polyman_awaiting',
    '  set -l p (__polyman_scan pending)',
    '  test -n "$p"',
    'end'
  );

  for (const model of models) {
    const inPath = `__polyman_in ${fishQuote(model.path).replace(/'/g, '"')}`;
    const condition = fishQuote(inPath);

    for (const sub of model.subcommands) {
      lines.push(
        `complete -c polyman -f -n ${condition} -a ${fishQuote(sub.name)} -d ${fishQuote(sub.description)}`
      );
    }

    for (const option of model.options) {
      const parts = [`complete -c polyman -n ${condition}`];
      for (const flag of option.flags) {
        parts.push(
          flag.startsWith('--') ? `-l ${flag.slice(2)}` : `-s ${flag.slice(1)}`
        );
      }
      if (option.takesValue) {
        parts.push('-r');
        if (option.kind === 'testsets') {
          parts.push('-f', `-a ${fishQuote('(__polyman_names testsets)')}`);
        } else if (option.kind === 'groups') {
          parts.push(
            '-f',
            `-a ${fishQuote('(__polyman_names groups -- (__polyman_scan testset))')}`
          );
        }
      }
      parts.push(`-d ${fishQuote(option.description)}`);
      lines.push(parts.join(' '));
    }

    if (model.positional) {
      const positionalCondition = fishQuote(
        `${inPath}; and not __polyman_awaiting; and test (__polyman_scan npos) -eq 0`
      );
      if (model.positional.kind) {
        lines.push(
          `complete -c polyman -f -n ${positionalCondition} -a ${fishQuote(`(__polyman_names ${model.positional.kind})`)}`
        );
      }
      if (model.positional.extra.length > 0) {
        lines.push(
          `complete -c polyman -f -n ${positionalCondition} -a ${fishQuote(model.positional.extra.join(' '))}`
        );
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Generates a completion script for a shell from a Commander program.
 * Hidden commands (such as `__complete`) are left out.
 *
 * @param program - The root Commander command (`polyman`)
 * @param shell - `bash`, `zsh` or `fish`
 * @returns The script, ready to be sourced or saved
 * @throws {Error} If the shell is not supported
 *
 * @example
 * process.stdout.write(generateCompletionScript(program, 'bash'));
 */
export function generateCompletionScript(
  program: Command,
  shell: string
): string {
  if (!isShell(shell)) {
    throw new Error(
      `Unsupported shell "${shell}". Supported shells: ${SHELLS.join(', ')}`
    );
  }
  const models = buildModel(program);
  switch (shell) {
    case 'bash':
      return bashScript(models);
    case 'zsh':
      return zshScript(models);
    case 'fish':
      return fishScript(models);
  }
}
