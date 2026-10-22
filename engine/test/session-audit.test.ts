import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Ledger, verifyChain } from '../src/ledger.ts';
import {
  type AgentPush,
  type Audit,
  type GuardFacts,
  type GuardLine,
  type GuardRun,
  type SessionNode,
  type ToolCall,
  type TraceLine,
  GRACE_MS,
  callsOf,
  exitCode,
  guardLineFor,
  guardLines,
  judge,
  judgingOrder,
  ledgerRecordFor,
  parseTrace,
  pushedRefs,
  pushesInCommand,
  pushesOf,
  renderAudit,
  redact,
  sessionReport,
  summarize,
  windowStart,
  writePrivileges,
} from '../src/session-audit.ts';

// what GitLab returned for four sessions on Oct 18 (trimmed, nothing credential-like):
// an issue-builder that opened !54, the mr-reviewer whose code_reviewer specialist
// pushed to !51, and two failed sessions (GitLab's code_review/v1 and a builder)
const dir = 'test/fixtures/session-audit';
const read = (name: string) => readFileSync(`${dir}/${name}`, 'utf8');
const nodes = (JSON.parse(read('sessions.json')) as { data: { project: { duoWorkflowWorkflows: { nodes: SessionNode[] } } } }).data.project.duoWorkflowWorkflows.nodes;
const node = (id: number) => nodes.find((n) => n.id.endsWith(`/${id}`))!;
const builderTrace = parseTrace(read('trace-builder.jsonl')).lines;
const reviewerTrace = parseTrace(read('trace-reviewer.jsonl')).lines;
const reviewerCheckpoint = JSON.parse(read('checkpoint-reviewer.json')) as object;
// the go-ahead ledger as Pages published it on Oct 19 (10 records)
const ledger = JSON.parse(read('ledger.json')) as Ledger;
const WEB = 'https://gitlab.com/group/showcase';

const builder = () => sessionReport(node(9647635), WEB, builderTrace, null);
const reviewer = () => sessionReport(node(9647660), WEB, reviewerTrace, reviewerCheckpoint);

describe('what a session did, from its trace and checkpoint', () => {
  it("finds the issue-builder's push in its trace: the branch it created, with the trace's time", () => {
    const s = builder();
    expect(s).toMatchObject({ id: 9647635, flow: 'issue-builder', status: 'FINISHED', issue: 4, mr: null, read: { trace: true, checkpoint: false }, unseen: false });
    expect(s.pushes).toEqual([
      expect.objectContaining({ agent: 'builder', tool: 'run_command', branch: '4-formatter-light-theme', head: null, created: true, landed: true, at: '2026-10-18T06:31:36.820304+00:00' }),
    ]);
  });

  it("finds a specialist's push only in the checkpoint: the trace has the lead's calls alone", () => {
    const traceOnly = sessionReport(node(9647660), WEB, reviewerTrace, null);
    expect(traceOnly.pushes).toEqual([]);
    expect(traceOnly.unseen).toBe(true);
    const s = reviewer();
    expect(s).toMatchObject({ flow: 'mr-reviewer', mr: 51, read: { trace: true, checkpoint: true }, unseen: false });
    expect(s.pushes).toEqual([expect.objectContaining({ agent: 'lead_reviewer__code_reviewer__1', branch: '13-docs-out-of-date', head: '0064ed4', created: false, landed: true, at: null })]);
  });

  it("leaves out what isn't the shape of a call, in the checkpoint and in the trace, and reads the rest", () => {
    const checkpoint = {
      channel_values: {
        conversation_history: {
          odd: 'not a list',
          fixer: [null, 7, { tool_calls: [null, { id: 'c1', name: 'run_command', args: { command: 'git push -q origin fix-1' } }] }, { tool_call_id: 'c1', content: 'Exit code: 0\n' }],
        },
      },
    };
    const trace = [null, 'x', { message_id: 'c2', timestamp: 12, tool_info: { name: 'run_command', args: { command: 'git push -q origin fix-2' } } }] as unknown as TraceLine[];
    const calls = callsOf(trace, checkpoint);
    expect(calls.map((c) => [c.id, c.at])).toEqual([
      ['c1', null],
      ['c2', null],
    ]);
    expect(sessionReport(node(9647635), WEB, trace, checkpoint).pushes.map((p) => p.branch)).toEqual(['fix-1', 'fix-2']);
  });

  it('counts a call that is in both once, with the time from the trace and the agent from the checkpoint', () => {
    const calls = callsOf(reviewerTrace, reviewerCheckpoint);
    expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
    const lead = calls.filter((c) => c.agent === 'lead_reviewer');
    expect(lead.length).toBe(7);
    expect(lead.every((c) => c.at)).toBe(true);
    expect(calls.filter((c) => c.agent.startsWith('lead_reviewer__')).every((c) => c.at === null)).toBe(true);
  });

  it("takes the trace's answer for a call the checkpoint has without one", () => {
    const checkpoint = { channel_values: { conversation_history: { fixer: [{ type: 'AIMessage', tool_calls: [{ id: 'c9', name: 'run_command', args: { command: 'git push origin fix-1' } }] }] } } };
    const trace = [{ message_id: 'c9', timestamp: '2026-10-19T10:00:00Z', status: 'failure', tool_info: { name: 'run_command', args: {}, tool_response: 'fatal: nope' } }];
    expect(callsOf(trace, checkpoint)).toEqual([expect.objectContaining({ id: 'c9', agent: 'fixer', response: 'fatal: nope', ok: false, at: '2026-10-19T10:00:00Z' })]);
    expect(pushesOf(callsOf(trace, checkpoint), { id: 1, flow: 'pipeline-fixer' })).toEqual([expect.objectContaining({ branch: 'fix-1', landed: false })]);
  });

  it("doesn't take a commit message or a prompt that says push for a push", () => {
    const calls = callsOf(reviewerTrace, reviewerCheckpoint);
    // the lead's delegation prompts tell the specialist how to push its fixes
    expect(calls.some((c) => c.name === 'delegate_task' && /push/.test(JSON.stringify(c.args)))).toBe(true);
    expect(pushesOf(calls, { id: 1, flow: 'mr-reviewer' })).toHaveLength(1);
    // the specialist's first commit, "docs: fix remote push example", which it pushed later with the second
    const commit: ToolCall = {
      id: 'c',
      agent: 'x',
      name: 'run_command',
      args: { command: 'git add GUIDE.md && git commit -q -m "docs: fix remote push example"' },
      response: 'Exit code: 0\n',
      ok: true,
      at: null,
    };
    expect(pushesOf([commit], { id: 1, flow: 'mr-reviewer' })).toEqual([]);
  });

  it('reads the MR from the pipeline event that started a session, and failed sessions with nothing in them', () => {
    const goal = { channel: 'goal', value: JSON.stringify({ object_kind: 'pipeline', merge_request: { id: 551218113, iid: 128, title: 'x' } }) };
    expect(sessionReport({ ...node(9647660), mergeRequest: null }, WEB, [goal], null).mr).toBe(128);
    const failed = sessionReport(node(9663778), WEB, [{ channel: 'goal', value: '121' }], null);
    expect(failed).toMatchObject({ flow: 'code_review/v1', status: 'FAILED', mr: 121, calls: 0, pushes: [] });
    expect(sessionReport(node(9653102), WEB, null, null)).toMatchObject({ status: 'FAILED', issue: 27, read: { trace: false, checkpoint: false } });
  });

  it('keeps the lines of a trace that are JSON and counts the rest', () => {
    expect(parseTrace('{"channel":"status","value":"Completed"}\nnot json\n\n')).toEqual({ lines: [{ channel: 'status', value: 'Completed' }], bad: 1 });
  });
});

describe("git push's output and command", () => {
  it('reads each ref a push moved, created or had refused', () => {
    const out = [
      'Exit code: 0',
      'To https://gitlab.com/group/showcase.git',
      '   a1aae58..0064ed4  13-docs-out-of-date -> 13-docs-out-of-date',
      ' * [new branch]      4-formatter-light-theme -> 4-formatter-light-theme',
      ' + 8e378fd...c96eb89 8-shell-completion -> 8-shell-completion (forced update)',
      ' ! [rejected]        main -> main (fetch first)',
      ' = [up to date]      other -> other',
      "branch '4-formatter-light-theme' set up to track 'origin/4-formatter-light-theme'.",
    ].join('\n');
    expect(pushedRefs(out)).toEqual([
      { branch: '13-docs-out-of-date', head: '0064ed4', created: false, landed: true, line: 'a1aae58..0064ed4  13-docs-out-of-date -> 13-docs-out-of-date' },
      { branch: '4-formatter-light-theme', head: null, created: true, landed: true, line: '* [new branch]      4-formatter-light-theme -> 4-formatter-light-theme' },
      { branch: '8-shell-completion', head: 'c96eb89', created: false, landed: true, line: '+ 8e378fd...c96eb89 8-shell-completion -> 8-shell-completion (forced update)' },
      { branch: 'main', head: null, created: false, landed: false, line: '! [rejected]        main -> main (fetch first)' },
    ]);
  });

  it('reads a long run of spaces at once, not over and over', () => {
    // A 50k-space line (over the length cap) and 400 lines of 900 spaces (under it). This code takes
    // 13-16 ms here. With an ambiguous flag (`([+\-*!= ]?)\s*`) and the cap kept, this test's best of
    // three took 8.1 s; without the cap, the ambiguous flag took 210 s on the one 50k-space line. So
    // 2 s, best of three, still catches either regression without failing on a busy machine.
    const ms = (f: () => unknown) =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const t = performance.now();
          f();
          return performance.now() - t;
        }),
      );
    const output = `To x\n${' '.repeat(50_000)}!\n` + `To x\n ${' '.repeat(900)}!\n`.repeat(400);
    expect(pushedRefs(output)).toEqual([]);
    expect(ms(() => pushedRefs(output))).toBeLessThan(2000);
  });

  it("doesn't read a fetch's refs as a push", () => {
    expect(pushedRefs('From https://gitlab.com/group/showcase\n * [new branch]      main -> origin/main')).toEqual([]);
  });

  it('names the branches each git push in a command asks for', () => {
    expect(pushesInCommand('git add . && git commit -q -m "fix: push example" && git push -u origin 27-flags 2>&1 | tail -3')).toEqual(['27-flags']);
    expect(pushesInCommand('git -C repo push -o ci.skip origin HEAD:refs/heads/fix-1 > /dev/null')).toEqual(['fix-1']);
    expect(pushesInCommand('git push --force-with-lease origin +a:b c')).toEqual(['b', 'c']);
    expect(pushesInCommand('git push')).toEqual([null]);
    expect(pushesInCommand('git log --oneline | grep push; echo git push')).toEqual([]);
  });

  it('names the pushes a shell, env, a variable, a subshell or command runs', () => {
    expect(pushesInCommand(`sh -c "cd repo && git push -q origin evil"`)).toEqual(['evil']);
    expect(pushesInCommand(`bash -lc 'git push origin a; git push origin b'`)).toEqual(['a', 'b']);
    expect(pushesInCommand('env GIT_TRACE=1 git push origin a')).toEqual(['a']);
    expect(pushesInCommand('env -u HOME git push origin a')).toEqual(['a']);
    expect(pushesInCommand('GIT_SSH_COMMAND=ssh git push origin a')).toEqual(['a']);
    expect(pushesInCommand('(cd repo && git push origin a)')).toEqual(['a']);
    expect(pushesInCommand('command git push origin a &>/dev/null')).toEqual(['a']);
    expect(pushesInCommand('echo "$(git push -q origin a)"')).toEqual(['a']);
    expect(pushesInCommand('eval "git push origin a"')).toEqual(['a']);
    expect(pushesInCommand('git commit -m "fix: push; then && push" && git push origin a')).toEqual(['a']);
  });

  const call = (over: Partial<ToolCall>): ToolCall => ({ id: 'c1', agent: 'fixer', name: 'run_command', args: {}, response: '', ok: true, at: '2026-10-19T10:00:00Z', ...over });
  const session = { id: 7, flow: 'pipeline-fixer' };

  it('falls back on the command when git printed nothing, and says whether it failed', () => {
    const quiet = pushesOf([call({ args: { command: 'git push -q origin fix-1' }, response: 'Exit code: 0\n' })], session);
    expect(quiet).toEqual([expect.objectContaining({ branch: 'fix-1', head: null, landed: true, evidence: 'git push -q origin fix-1' })]);
    const refused = pushesOf(
      [
        call({
          args: { command: 'git push origin main' },
          response: 'Exit code: 1\nremote: GitLab: You are not allowed to push code to protected branches on this project.\nerror: failed to push some refs',
        }),
      ],
      session,
    );
    expect(refused[0]).toMatchObject({ branch: 'main', landed: false });
    expect(pushesOf([call({ args: { command: 'git push origin fix-1' }, response: 'Exit code: 0\nEverything up-to-date\n' })], session)).toEqual([]);
  });

  it('takes a quiet push as landed when anything but git ran after it, whatever the exit code says', () => {
    for (const [command, response] of [
      ['git push -q origin feat && npm test', 'Exit code: 1\n'],
      ['git push -q origin feat; grep -q zzz f', 'Exit code: 1\n'],
      ['git push -q origin feat; echo "error: x"', 'Exit code: 0\nerror: x\n'],
      ['git push -q origin feat && false', 'Exit code: 1\n'],
    ]) {
      expect(pushesOf([call({ args: { command }, response, ok: false })], session), command).toEqual([expect.objectContaining({ branch: 'feat', landed: true })]);
    }
    // git alone, failing with nothing but an exit code, still counts as landed
    expect(pushesOf([call({ args: { command: 'git push -q origin feat' }, response: 'Exit code: 128\n', ok: false })], session)[0]).toMatchObject({ landed: true });
  });

  it("counts a quiet push next to git's output, and next to output the command printed itself", () => {
    // a ref line or "Everything up-to-date" that printf or echo wrote hides no push
    const forged = 'Exit code: 0\nTo x\n   aaaa111..bbbb222  a -> a\n';
    expect(pushesOf([call({ args: { command: 'git push -q origin evil; printf "To x\\n   aaaa111..bbbb222  a -> a\\n"' }, response: forged })], session).map((p) => p.branch)).toEqual([
      'a',
      'evil',
    ]);
    const upToDate = 'Exit code: 0\nEverything up-to-date\n';
    expect(pushesOf([call({ args: { command: 'git push -q origin evil; echo Everything up-to-date' }, response: upToDate })], session)).toEqual([
      expect.objectContaining({ branch: 'evil', landed: true }),
    ]);
    // nor does one push's output hide another: two pushes, one "Everything up-to-date"
    expect(pushesOf([call({ args: { command: 'git push -q origin evil && git push origin fix-1' }, response: upToDate })], session).map((p) => p.branch)).toEqual(['evil', 'fix-1']);
    // the current branch's push shows as a ref no named push claims, when only git printed
    const out = 'Exit code: 0\nTo https://gitlab.com/group/showcase.git\n   1111111..2222222  fix-1 -> fix-1';
    expect(pushesOf([call({ args: { command: 'git push 2>&1 | tail -3' }, response: out })], session)).toEqual([expect.objectContaining({ branch: 'fix-1', head: '2222222' })]);
    expect(pushesOf([call({ args: { command: 'git push -q; git push origin fix-1' }, response: out })], session).map((p) => p.branch)).toEqual(['fix-1', null]);
    expect(pushesOf([call({ args: { command: 'git push; echo done' }, response: out })], session).map((p) => p.branch)).toEqual(['fix-1', null]);
  });

  it('counts a command with a git push in a form it does not read as a push to no known branch', () => {
    for (const command of [`python3 -c "import os; os.system('git push origin evil')"`, 'xargs git push origin < branches', 'echo git push | sh']) {
      expect(pushesOf([call({ args: { command }, response: 'Exit code: 0\n' })], session)).toEqual([expect.objectContaining({ branch: null, landed: true })]);
    }
    expect(pushesOf([call({ args: { command: 'grep -n "git push" CONTRIBUTING.md' }, response: 'Exit code: 0\n' })], session)).toEqual([]);
  });

  it('takes no git stash push for a push: a builder stashed its fix to see the new test fail on the old code', () => {
    // session 9859568 on Oct 22, the one call as it ran: a heredoc that adds tests, then `git stash push ...; npx vitest ...; git stash pop`
    const calls = callsOf(parseTrace(read('trace-stash.jsonl')).lines, null);
    expect(calls).toEqual([expect.objectContaining({ name: 'run_command', response: expect.stringMatching(/^Exit code: 0\nnpm notice/) })]);
    expect(calls[0].args.command).toContain('git stash push src/helpers/script-parser.ts -q;');
    expect(pushesOf(calls, { id: 9859568, flow: 'issue-builder' })).toEqual([]);
  });

  it('takes no other git subcommand with the word push for a push', () => {
    for (const command of ['git stash push -q', 'git stash push -m wip', 'git remote set-url --push origin x', 'git config push.default current', 'git log --grep push']) {
      expect(pushesOf([call({ args: { command }, response: 'Exit code: 0\n' })], session), command).toEqual([]);
    }
    // in a later command, and behind a prefix, a runner, git's own options or a shell
    for (const command of [
      'cd r && git stash push -q',
      'echo hi; git log --grep push',
      'FOO=1 git stash push',
      'env git stash push -q',
      'git -C r -c a=b stash push',
      '/usr/bin/git stash push',
      'sh -c "git stash push"',
    ]) {
      expect(pushesOf([call({ args: { command }, response: 'Exit code: 0\n' })], session), command).toEqual([]);
    }
  });

  it('still counts a real push next to a stash, a subtree push, and no quoted push', () => {
    expect(pushesInCommand('git push origin feat')).toEqual(['feat']);
    expect(pushesInCommand('git -C repo push -q')).toEqual([null]);
    expect(pushesInCommand('git stash push -q && git push origin fix-1')).toEqual(['fix-1']);
    // git subtree push pushes too: before, it was only caught as an unread push
    expect(pushesInCommand('git subtree push --prefix dist origin gh-pages')).toEqual(['gh-pages']);
    expect(pushesInCommand('git subtree push -P dist -q origin gh-pages')).toEqual(['gh-pages']);
    expect(pushesInCommand('git -C repo subtree push --prefix=dist origin gh-pages')).toEqual(['gh-pages']);
    for (const command of ['echo "git push origin x"', "grep -n 'git push' CONTRIBUTING.md", 'git commit -m "explain git push"']) {
      expect(pushesOf([call({ args: { command }, response: 'Exit code: 0\n' })], session), command).toEqual([]);
    }
  });

  it("reads a push after git's own options with their value as a separate word", () => {
    expect(pushesInCommand('git --git-dir .. push origin a')).toEqual(['a']);
    expect(pushesInCommand('git --work-tree X push')).toEqual([null]);
    expect(pushesInCommand('git --namespace ns push origin a')).toEqual(['a']);
    expect(pushesInCommand('git --git-dir=x push origin a')).toEqual(['a']);
    expect(pushesInCommand('git --config-env foo=BAR push origin a')).toEqual(['a']);
    expect(pushesInCommand('git --attr-source HEAD push origin a')).toEqual(['a']);
    // --exec-path and --list-cmds take their value only after =; on its own --exec-path takes no word after it
    expect(pushesInCommand('git --exec-path=/x push origin a')).toEqual(['a']);
    expect(pushesInCommand('git --list-cmds=main push origin a')).toEqual(['a']);
    expect(pushesInCommand('git --exec-path push origin a')).toEqual(['a']);
    // -P and -m are git subtree's options; plain git push has neither, so nothing after them is skipped
    expect(pushesInCommand('git push -P origin a')).toEqual(['a']);
    // git subtree push's own options with a value: the branch is still the last word
    for (const option of ['--onto abc', '-b br', '--annotate foo']) {
      expect(pushesInCommand(`git subtree push --prefix x ${option} origin main`), option).toEqual(['main']);
    }
    for (const command of ['git subtree push', 'git subtree push --prefix', 'git subtree push origin']) {
      expect(pushesInCommand(command), command).toEqual([null]);
    }
    // git status after git's own options prints nothing a push's output could be taken for, as after -C:
    // the ref line is the first push's, not a second push's
    const out = 'Exit code: 0\nTo https://gitlab.com/group/showcase.git\n   1111111..2222222  fix-1 -> fix-1';
    for (const command of ['git push; git --git-dir x status', 'git push; git --work-tree x status']) {
      expect(pushesOf([call({ args: { command }, response: out })], session), command).toEqual([expect.objectContaining({ branch: 'fix-1', head: '2222222' })]);
    }
  });

  it('still counts a push run through a git subcommand as unread, and none for a subcommand that never pushes', () => {
    const unread = (command: string) => pushesOf([call({ args: { command }, response: 'Exit code: 0\n' })], session);
    for (const command of [
      'git submodule foreach git push',
      'git bisect run git push',
      'git config alias.p push && git p',
      // config keys are case-insensitive
      'git config Alias.p push && git p',
      'git config ALIAS.p push && git p',
    ]) {
      expect(unread(command), command).toEqual([expect.objectContaining({ branch: null })]);
    }
    for (const command of [
      'git commit -m "push"',
      'git grep push',
      'git show HEAD',
      'git diff',
      'git tag push-1',
      'git submodule add "git@github.com:org/push-tool.git" x',
      'git submodule update --init',
      'git bisect run ./push-check.sh',
      'git config alias.pp "log --grep push"',
    ]) {
      expect(unread(command), command).toEqual([]);
    }
    expect(unread('git stash push -q && git submodule foreach git push')).toHaveLength(1);
  });

  it('reads git then push in what an interpreter runs only in that order, as whole words', () => {
    const unread = (command: string) => pushesOf([call({ args: { command }, response: 'Exit code: 0\n' })], session).length;
    expect(unread(`node -e "require('child_process').execSync('git fetch && git push')"`)).toBe(1);
    expect(unread(`perl -e 'system("/usr/bin/git", "push")'`)).toBe(1);
    expect(unread(`python3 -c "print('push before git')"`)).toBe(0);
    expect(unread(`python3 -c "import gitpush; github.pushed()"`)).toBe(0);
    expect(unread(`node -e "console.log('git status; pushover')"`)).toBe(0);
  });

  it('takes any one-dash run of letters with a c in it as the shell flag that comes before the script', () => {
    expect(pushesInCommand(`bash -c 'git push origin a'`)).toEqual(['a']);
    expect(pushesInCommand(`sh -ec 'git push origin a'`)).toEqual(['a']);
    expect(pushesInCommand(`zsh -cx 'git push origin a'`)).toEqual(['a']);
    expect(pushesInCommand(`bash -lic 'git push origin a'`)).toEqual(['a']);
    // no c, a capital letter, a digit or two dashes: not the flag
    expect(pushesInCommand(`bash -x 'git push origin a'`)).toEqual([]);
    expect(pushesInCommand(`bash -C 'git push origin a'`)).toEqual([]);
    expect(pushesInCommand(`bash -c1 'git push origin a'`)).toEqual([]);
    expect(pushesInCommand(`bash --c 'git push origin a'`)).toEqual([]);
  });

  it('reads a long run of gits or a long shell flag in linear time', () => {
    // The best of three runs against a 2 s bound: a loaded machine took 311-525 ms here and failed a
    // 200 ms bound, and each input below is sized so the old quadratic check takes several times 2 s.
    const ms = (f: () => unknown) =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const t = performance.now();
          f();
          return performance.now() - t;
        }),
      );
    // one git after another with no push: the old check scanned to the end once per git (11-20 s on 40k)
    expect(ms(() => pushesOf([call({ args: { command: 'python3 ' + 'git '.repeat(40_000) }, response: 'Exit code: 0\n' })], session))).toBeLessThan(2000);
    // a flag of 100k c's that fails at the last letter: the old check tried every c as the one c.
    // Its regex took 1.5-7 s on 40k c's and 28-29 s on 100k on a loaded machine; time grows with the
    // square of the length, so 100k is about 10 s where 40k took 1.5 s. The new check takes under 1 ms.
    expect(ms(() => pushesInCommand('sh -' + 'c'.repeat(100_000) + 'A'))).toBeLessThan(2000);
  });

  it('takes the credentials out of what a push was read from', () => {
    const token = 'glpat-' + 'x'.repeat(20);
    const [p] = pushesOf([call({ args: { command: `git push -q https://oauth2:${token}@gitlab.com/g/p.git evil` }, response: 'Exit code: 0\n' })], session);
    expect(p).toMatchObject({ branch: 'evil', evidence: 'git push -q https://[redacted]@gitlab.com/g/p.git evil' });
    expect(redact(`git -c http.extraHeader="Authorization: Bearer ${token}" push; echo ${token}; PRIVATE-TOKEN=abc123`)).toBe(
      'git -c http.extraHeader="Authorization: Bearer [redacted]" push; echo glpat-[redacted]; PRIVATE-TOKEN=[redacted]',
    );
  });

  it("counts GitLab's commit API and git tool as pushes", () => {
    const commit = call({ name: 'create_commit', args: { project_id: '1', branch: 'fix-2', start_branch: 'main', commit_message: 'x', actions: [] }, response: '{"id": "' + 'a'.repeat(40) + '"}' });
    const git = call({
      id: 'c2',
      name: 'run_git_command',
      args: { repository_url: 'https://gitlab.com/group/showcase', command: 'push', args: 'origin fix-3' },
      response: 'To https://gitlab.com/group/showcase.git\n   1111111..2222222  fix-3 -> fix-3',
    });
    expect(pushesOf([commit, git], session)).toEqual([
      expect.objectContaining({ tool: 'create_commit', branch: 'fix-2', head: 'a'.repeat(40), created: true, landed: true }),
      expect.objectContaining({ tool: 'run_git_command', branch: 'fix-3', head: '2222222', landed: true }),
    ]);
  });
});

describe('matching a push to the ledger', () => {
  it('uses a ledger that verifies', () => {
    expect(verifyChain(ledger)).toEqual([]);
  });

  it("finds the builder's push by branch, flow and time, and the specialist's by its head", () => {
    const b = builder();
    expect(ledgerRecordFor(b.pushes[0], b, ledger.records, new Set())).toMatchObject({ seq: 5, mr: 54, flow: 'issue-builder' });
    const r = reviewer();
    expect(ledgerRecordFor(r.pushes[0], r, ledger.records, new Set())).toMatchObject({ seq: 4, mr: 51, head: expect.stringMatching(/^0064ed4/) });
  });

  it("matches nothing a record doesn't fit: another time, another head, or a record already used", () => {
    const b = builder();
    const later = { ...b.pushes[0], at: '2026-10-18T07:31:36Z' };
    expect(ledgerRecordFor(later, b, ledger.records, new Set())).toBeUndefined();
    const r = reviewer();
    expect(ledgerRecordFor({ ...r.pushes[0], head: 'deadbee' }, r, ledger.records, new Set())).toBeUndefined();
    expect(ledgerRecordFor(b.pushes[0], b, ledger.records, new Set([5]))).toBeUndefined();
  });

  it('takes a head shorter than 7 characters for no head: it matches by time, not by its first characters', () => {
    const b = builder();
    const short = ledger.records[4].head.slice(0, 4);
    expect(ledgerRecordFor({ ...b.pushes[0], head: short, at: '2026-10-18T07:31:36Z' }, b, ledger.records, new Set())).toBeUndefined();
    expect(ledgerRecordFor({ ...b.pushes[0], head: short }, b, ledger.records, new Set())).toMatchObject({ seq: 5 });
    // nor does git print one that short
    expect(pushedRefs('To x\n   abcd..ef01  a -> a')).toEqual([]);
  });
});

describe("the guard's own verdict on each push, from its job log", () => {
  // autonomy:goahead on !67 (#31): it accepted the builder's push and the
  // reviewer's first, and refused the reviewer's second
  const lines = guardLines(read('guard-failed.log'));

  it('reads one line per push it judged', () => {
    expect(lines.map((l) => [l.at, l.pusher.slice(0, 16), l.shas, l.accepted])).toEqual([
      ['2026-10-18T13:21:29.826Z', 'ai-mr-reviewer-g', ['b7488c7c'], false],
      ['2026-10-18T12:03:14.213Z', 'ai-issue-builder', ['46fb4e00'], true],
      ['2026-10-18T12:37:58.255Z', 'ai-mr-reviewer-g', ['dcd97a5b', 'd7d5967e', 'd327a2a9', '9d304c94'], true],
    ]);
  });

  it('refuses a push it accepted when a commit the push brought breaks a rule', () => {
    const log =
      'push at 2026-10-18T12:00:00Z by @ai-pipeline-fixer-x (abcdef12): go-ahead in note 1 by @a-person\ncommit abcdef12 pushed by @ai-pipeline-fixer-x changes files only people may change: .gitlab-ci.yml';
    expect(guardLines(log)[0]).toMatchObject({ accepted: false, text: expect.stringContaining('.gitlab-ci.yml') });
    expect(guardLines('push at 2026-10-18T12:00:00Z by @ai-x (no new commits, head 1234abcd): go-ahead in note 1 by @p')[0].shas).toEqual(['1234abcd']);
  });

  const push = (over: Partial<AgentPush>): AgentPush => ({
    session: 1,
    flow: 'mr-reviewer',
    agent: 'lead_reviewer__test_reviewer__2',
    tool: 'run_command',
    call: 'c',
    branch: '31-freemarker-expansion',
    head: 'b7488c7',
    created: false,
    landed: true,
    at: null,
    evidence: '',
    ...over,
  });
  const session = { createdAt: '2026-10-18T13:10:00Z', updatedAt: '2026-10-18T13:30:00Z' };

  it('finds the line by head, or by flow and time when git printed no head', () => {
    expect(guardLineFor(push({}), session, lines)?.accepted).toBe(false);
    const created = push({ flow: 'issue-builder', head: null, created: true, at: '2026-10-18T12:03:14.300Z' });
    expect(guardLineFor(created, session, lines)?.accepted).toBe(true);
    // same time, another flow's line: not this push
    expect(guardLineFor({ ...created, flow: 'pipeline-fixer' }, session, lines)).toBeUndefined();
  });

  const now = new Date('2026-10-19T10:00:00Z');
  const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
    mr: { iid: 67, state: 'opened', closedAt: null },
    runs: [{ pipeline: 2960299423, sha: 'b7488c7c', status: 'failed', at: '2026-10-18T13:21:31Z', started: '2026-10-18T13:24:21Z', lines }],
    ...over,
  });

  it("refuses the push the guard's line refuses and accepts the one it accepts, on the same failed run", () => {
    expect(judge(push({}), session, { facts: facts(), now })).toMatchObject({ verdict: 'refused', mr: 67, why: expect.stringContaining('no go-ahead mentioning') });
    expect(judge(push({ head: 'dcd97a5' }), { createdAt: '2026-10-18T12:20:00Z', updatedAt: '2026-10-18T12:40:00Z' }, { facts: facts(), now }).verdict).toBe('guard');
  });

  it('trusts a passed run whose log judges no push only at the push or after it, and never a failed one', () => {
    const blind = (status: string, sha = 'b7488c7c', started: string | null = '2026-10-18T13:22:10Z') => facts({ runs: [{ pipeline: 1, sha, status, at: '2026-10-18T13:22:00Z', started, lines: [] }] });
    // at the push's head
    expect(judge(push({}), session, { facts: blind('success'), now }).verdict).toBe('guard');
    // its job started after the push (a specialist's: after the session)
    expect(judge(push({}), session, { facts: blind('success', 'deadbeef', '2026-10-18T13:31:00Z'), now }).verdict).toBe('guard');
    expect(judge(push({ head: null, at: '2026-10-18T13:15:00Z' }), session, { facts: blind('success', 'deadbeef', '2026-10-18T13:22:10Z'), now }).verdict).toBe('guard');
    expect(judge(push({}), session, { facts: blind('failed'), now }).verdict).toBe('unjudged');
    expect(judge(push({}), session, { facts: blind('running'), now }).verdict).toBe('pending');
  });

  it("doesn't take a passed run for a push its log doesn't name, or one from before the push", () => {
    const named = guardLines('push at 2026-10-18T13:21:00Z by @ai-mr-reviewer-x (11111111): go-ahead in note 1 by @a-person');
    const passed = (over: Partial<GuardRun>) =>
      facts({ runs: [{ pipeline: 1, sha: '11111111', status: 'success', at: '2026-10-18T13:31:00Z', started: '2026-10-18T13:31:10Z', lines: named, ...over }] });
    // its log judges another push
    expect(judge(push({ head: 'deadbeef' }), session, { facts: passed({}), now })).toMatchObject({ verdict: 'unjudged', why: expect.stringContaining("no run's log names this push") });
    // its log judges nothing, but it began at the session's start, before the specialist's push, at another head
    expect(judge(push({ head: 'deadbeef' }), session, { facts: passed({ at: '2026-10-18T13:10:30Z', started: '2026-10-18T13:10:40Z', lines: [] }), now })).toMatchObject({
      verdict: 'unjudged',
      why: expect.stringContaining('started before this one'),
    });
    // a quiet push at 10:08: a pipeline created 20 seconds before it (a person's, or [skip ci]) didn't see it
    const quiet = push({ head: null, at: '2026-10-19T10:08:00Z' });
    const open = (runs: GuardRun[]) => ({ facts: facts({ runs }), now: new Date('2026-10-19T10:30:00Z') });
    const before = { pipeline: 1, sha: '11111111', status: 'success', at: '2026-10-19T10:07:40Z', started: '2026-10-19T10:07:45Z', lines: [] };
    expect(judge(quiet, session, open([before])).verdict).toBe('unjudged');
    expect(judge(quiet, session, open([{ ...before, started: '2026-10-19T10:08:05Z' }])).verdict).toBe('guard');
    expect(judge(quiet, session, open([{ ...before, started: null }])).verdict).toBe('unjudged');
  });

  it('waits for a run newer than the one that passed, while it is still going', () => {
    const quiet = push({ head: null, at: '2026-10-19T10:08:00Z' });
    const passed = { pipeline: 1, sha: '11111111', status: 'success', at: '2026-10-19T10:07:40Z', started: '2026-10-19T10:07:45Z', lines: [] };
    const running = { pipeline: 2, sha: '22222222', status: 'running', at: '2026-10-19T10:08:05Z', started: '2026-10-19T10:08:10Z', lines: null };
    expect(judge(quiet, session, { facts: facts({ runs: [passed, running] }), now: new Date('2026-10-19T10:30:00Z') })).toMatchObject({
      verdict: 'pending',
      why: expect.stringContaining('running on pipeline 2'),
    });
  });

  it('takes the nearest line for a push without a head, a refusal in reach before a go-ahead, and each go-ahead once', () => {
    const builderPush = (at: string) => push({ flow: 'issue-builder', agent: 'builder', head: null, at });
    const log = (...entries: [string, boolean][]) =>
      guardLines(entries.map(([at, ok]) => `push at ${at} by @ai-issue-builder-x (1234abcd): ${ok ? 'go-ahead in note 1 by @a-person' : 'no go-ahead mentioning @ai-issue-builder-x'}`).join('\n'));
    const run = (lines: ReturnType<typeof guardLines>) => facts({ runs: [{ pipeline: 5, sha: 'x', status: 'failed', at: '2026-10-19T10:09:00Z', started: '2026-10-19T10:09:10Z', lines }] });
    const later = { now: new Date('2026-10-19T12:00:00Z') };
    // two quiet pushes to one branch: A (10:02) was accepted, B (10:08) refused
    const ab = run(log(['2026-10-19T10:02:00Z', true], ['2026-10-19T10:08:00Z', false]));
    expect(judge(builderPush('2026-10-19T10:08:00Z'), session, { facts: ab, ...later }).verdict).toBe('refused');
    // the nearest go-ahead when none refuses
    const near = log(['2026-10-19T10:02:00Z', true], ['2026-10-19T10:07:00Z', true]);
    expect(guardLineFor(builderPush('2026-10-19T10:08:00Z'), session, near)?.at).toBe('2026-10-19T10:07:00Z');
    // one go-ahead, two pushes: the second has none
    const used = new Set<string>();
    const one = run(log(['2026-10-19T10:02:00Z', true]));
    expect(judge(builderPush('2026-10-19T10:02:00Z'), session, { facts: one, used, ...later }).verdict).toBe('guard');
    expect(judge(builderPush('2026-10-19T10:04:00Z'), session, { facts: one, used, ...later }).verdict).toBe('unjudged');
    // every run lists the pushes before it again: the same line in two runs' logs is still one go-ahead
    const again = new Set<string>();
    const twoRuns = facts({
      runs: [
        { pipeline: 2, sha: 'y', status: 'failed', at: '2026-10-19T10:06:00Z', started: '2026-10-19T10:06:10Z', lines: log(['2026-10-19T10:02:00Z', true]) },
        { pipeline: 1, sha: 'x', status: 'failed', at: '2026-10-19T10:03:00Z', started: '2026-10-19T10:03:10Z', lines: log(['2026-10-19T10:02:00Z', true]) },
      ],
    });
    expect(judge(builderPush('2026-10-19T10:02:00Z'), session, { facts: twoRuns, used: again, ...later }).verdict).toBe('guard');
    expect(judge(builderPush('2026-10-19T10:02:30Z'), session, { facts: twoRuns, used: again, ...later }).verdict).toBe('unjudged');
  });

  it("doesn't take a head or a refusal from a ref line that echo or printf could have written", () => {
    const session = { id: 7, flow: 'pipeline-fixer' };
    const call = (over: Partial<ToolCall>): ToolCall => ({ id: 'c1', agent: 'fixer', name: 'run_command', args: {}, response: '', ok: true, at: '2026-10-19T10:00:00Z', ...over });
    const forged = 'Exit code: 0\nTo x\n   aaaa111..bbbb222  evil -> evil\n';
    const echoed = pushesOf([call({ args: { command: 'git push -q origin evil; echo "To x"; echo "   aaaa111..bbbb222  evil -> evil"' }, response: forged })], session);
    expect(echoed).toEqual([expect.objectContaining({ branch: 'evil', head: null, landed: true })]);
    const refused = 'Exit code: 0\nTo x\n ! [rejected]        evil -> evil (fetch first)\n';
    expect(pushesOf([call({ args: { command: 'git push -q origin evil; printf "%s" "$X"' }, response: refused })], session)[0]).toMatchObject({ branch: 'evil', landed: true });
    // git's own output, with git log after it, keeps its head
    const real = 'Exit code: 0\nTo x\n   a1aae58..0064ed4  fix -> fix\n';
    expect(pushesOf([call({ args: { command: 'git push origin fix 2>&1 | tail -3; git log --oneline -3' }, response: real })], session)[0]).toMatchObject({ head: '0064ed4' });
  });

  it('reads a push with 150,000 refspecs without running out of stack', () => {
    const many = Array.from({ length: 150_000 }, (_, i) => `b${i}`).join(' ');
    expect(pushesInCommand(`git push origin ${many}`)).toHaveLength(150_000);
  });

  it('judges pushes with a head first, so a headless push cannot take the line that names another push', () => {
    const at = '2026-10-19T10:02:00Z';
    const order = judgingOrder([push({ head: null, at }), push({ head: 'aaaaaaa1111', at }), push({ head: 'abc', at }), push({ head: 'bbbbbbb2222', at })]);
    // a head shorter than 7 counts as none
    expect(order).toEqual([1, 3, 0, 2]);
  });

  it('stops waiting for a newer run that never finishes, and waits for one after a failed run too', () => {
    const quiet = push({ head: null, at: '2026-10-19T10:08:00Z' });
    const passed = { pipeline: 1, sha: '11111111', status: 'success', at: '2026-10-19T10:07:40Z', started: '2026-10-19T10:07:45Z', lines: [] };
    const stuck = { pipeline: 2, sha: '22222222', status: 'created', at: '2026-10-19T10:08:05Z', started: null, lines: null };
    const threeDaysLater = new Date('2026-10-22T10:08:00Z');
    expect(judge(quiet, session, { facts: facts({ runs: [passed, stuck] }), now: threeDaysLater }).verdict).toBe('unjudged');
    expect(judge(quiet, session, { facts: facts({ runs: [passed, stuck] }), now: new Date('2026-10-19T10:30:00Z') }).verdict).toBe('pending');
    const failed = { ...passed, status: 'failed', lines: [] };
    const running = { ...stuck, status: 'running' };
    expect(judge(quiet, session, { facts: facts({ runs: [failed, running] }), now: new Date('2026-10-19T10:30:00Z') })).toMatchObject({
      verdict: 'pending',
      why: expect.stringContaining('newer than the run that failed'),
    });
    expect(GRACE_MS).toBeLessThan(threeDaysLater.getTime() - Date.parse(stuck.at));
  });

  it('reports a branch named like a token redacted, in every verdict', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const named = judge(push({ branch: 'glpat-abcdefghijkl1234', landed: false }), session, { now });
    expect(named.branch).toBe('glpat-[redacted]');
    expect(judge(push({ branch: 'glpat-abcdefghijkl1234' }), session, { now }).branch).toBe('glpat-[redacted]');
    expect(judge(push({ branch: 'fix-1', landed: false }), session, { now }).branch).toBe('fix-1');
  });

  it('redacts the credential shapes a command can carry', () => {
    for (const [text, leaked] of [
      ['GITLAB_TOKEN=abcdef123 git push', 'abcdef123'],
      ['export AUDIT_TOKEN=sekret; git push', 'sekret'],
      ['curl "https://x/api?private_token=abc123&a=1"', 'abc123'],
      ['curl https://x/api?access_token=abc123', 'abc123'],
      ['git push https://oauth2:glpat_0123456789abcdef@gitlab.com/g/p.git', '0123456789abcdef'], // gitleaks:allow
      ['echo ghp_0123456789abcdefghij', '0123456789abcdefghij'],
      ['curl -H "Authorization: \\"Bearer abc123\\""', 'abc123'],
      ['curl -H Bearer abc123', 'abc123'],
      ['git push https://user:pa/ss@host/g/p.git', 'pa/ss'],
      ['git push https://u:p@ss@h/g/p.git', 'ss@h'],
    ]) {
      expect(redact(text), text).not.toContain(leaked);
    }
  });

  it("leaves a push unjudged when a guard's log wasn't readable", () => {
    for (const status of ['success', 'failed']) {
      const unread = facts({ runs: [{ pipeline: 3, sha: 'b7488c7c', status, at: '2026-10-18T13:22:00Z', started: '2026-10-18T13:22:10Z', lines: null }] });
      expect(judge(push({}), session, { facts: unread, now })).toMatchObject({ verdict: 'unjudged', why: expect.stringContaining('log was not readable') });
    }
  });
  it('takes the credentials out of why a push was refused', () => {
    const evidence = 'git push https://oauth2:glpat-abcdefghijklmnopqrst@gitlab.com/g/p.git evil'; // gitleaks:allow
    expect(judge(push({ landed: false, evidence }), session, { now }).why).toBe('the push was refused: git push https://[redacted]@gitlab.com/g/p.git evil');
  });

  it('waits for an open MR only so long, and never for a branch with no MR or an MR that was closed before', () => {
    const at = '2026-10-19T09:00:00Z';
    const open = facts({ runs: [] });
    expect(judge(push({ at }), session, { facts: open, now }).verdict).toBe('pending');
    expect(judge(push({ at }), session, { facts: open, now: new Date(Date.parse(at) + GRACE_MS + 60_000) }).verdict).toBe('unjudged');
    expect(judge(push({ at }), session, { facts: { mr: null, runs: [] }, now })).toMatchObject({ verdict: 'unjudged', why: expect.stringContaining('no merge request') });
    expect(judge(push({ at }), session, { facts: { mr: { iid: 86, state: 'merged', closedAt: '2026-10-19T08:00:00Z' }, runs: [] }, now })).toMatchObject({
      verdict: 'unjudged',
      why: expect.stringContaining('before the push'),
    });
  });

  it('takes the ledger first, lets a refused push through as not landed, and leaves pushes before the guard alone', () => {
    const b = builder();
    const record = ledger.records[4];
    expect(judge(b.pushes[0], b, { record, now })).toMatchObject({ verdict: 'ledger', mr: 54, why: expect.stringContaining('go-ahead in note 4036978417') });
    expect(judge(b.pushes[0], b, { record: { ...record, accepted: false, reasons: ['no go-ahead'] }, now }).verdict).toBe('refused');
    expect(judge(push({ landed: false }), session, { now }).verdict).toBe('not landed');
    expect(judge(push({}), session, { guardSince: '2026-10-18T14:00:00Z', now }).verdict).toBe('before guard');
    // a specialist's push in a session that ends after the guard arrived is judged
    expect(judge(push({}), session, { guardSince: '2026-10-18T13:20:00Z', facts: facts(), now }).verdict).toBe('refused');
  });
});

describe('the audit report', () => {
  const now = new Date('2026-10-19T10:00:00Z');
  const audit = (verdicts: ('ledger' | 'unjudged' | 'pending')[]): Audit => {
    const b = builder();
    return {
      project: 'group/showcase',
      window: { from: '2026-10-18T10:00:00.000Z', to: now.toISOString() },
      ledger: { url: 'ledger.json', records: 10, head: ledger.head },
      ledgerProblem: null,
      sessions: [b, sessionReport(node(9663778), WEB, [], null)],
      pushes: verdicts.map((verdict) => ({ ...b.pushes[0], mr: 54, verdict, why: `it is ${verdict}` })),
      unread: [],
    };
  };

  it('fails only on a push nothing accepted', () => {
    expect(exitCode(summarize(audit(['ledger', 'pending'])))).toBe(0);
    const broken = summarize(audit(['ledger', 'unjudged']));
    expect(exitCode(broken)).toBe(1);
    expect(broken.breaks).toHaveLength(1);
  });

  it("says it couldn't finish when a session wasn't read in full, unless a push already broke the rule", () => {
    const unread = { ...audit(['ledger']), unread: [9653102] };
    expect(exitCode(summarize(unread))).toBe(2);
    expect(exitCode(summarize({ ...unread, pushes: audit(['unjudged']).pushes }))).toBe(1);
    const text = renderAudit(unread);
    expect(text).toContain("**Not finished: 1 session(s) weren't read in full. Every agent push found has a go-ahead on record.**");
    expect(text).toContain("- Not read in full: 1 session(s) whose trace or checkpoint GitLab didn't give (9653102)");
  });

  it('counts failed sessions and write privileges, which are information, not a failure', () => {
    const s = summarize(audit([]));
    expect(s).toMatchObject({ sessions: 2, failed: [9663778], stopped: [], byFlow: { 'issue-builder': 1, 'code_review/v1': 1 } });
    expect(s.writable).toEqual({ sessions: 2, byPrivilege: { read_write_files: 1, read_write_gitlab: 2, run_commands: 2, use_git: 2, run_mcp_tools: 1, start_flows: 1 } });
    // REST names the same privileges: read_only_files isn't a write
    const rest = JSON.parse(read('workflow-rest.json')) as { pre_approved_agent_privileges_names: string[] };
    expect(writePrivileges(rest.pre_approved_agent_privileges_names)).toEqual(['read_write_gitlab', 'run_commands', 'use_git']);
  });

  it('says the verdict first, then every push and every session', () => {
    const text = renderAudit(audit(['unjudged']));
    expect(text).toContain('**Rule broken: 1 agent push(es) without an accepted go-ahead.**');
    expect(text).toContain('| 9647635 | issue-builder | builder | 4-formatter-light-theme (new) |  | 2026-10-18T06:31:36Z | !54 | **unjudged** | it is unjudged |');
    expect(text).toContain('Failed: 1 (9663778)');
    expect(renderAudit(audit(['ledger', 'pending']))).toContain('**Every agent push has a go-ahead on record or is waiting for the guard (1).**');
  });
});

describe('the window', () => {
  const now = new Date('2026-10-19T10:00:00Z');
  it('is the last 24 hours, some hours back, from a date, or from a time', () => {
    expect(windowStart(undefined, now)).toBe('2026-10-18T10:00:00.000Z');
    expect(windowStart('48h', now)).toBe('2026-10-17T10:00:00.000Z');
    expect(windowStart('2026-10-17', now)).toBe('2026-10-17T00:00:00.000Z');
    expect(windowStart('2026-10-17T12:30:00Z', now)).toBe('2026-10-17T12:30:00.000Z');
    expect(() => windowStart('yesterday', now)).toThrow('--since takes');
  });
});
