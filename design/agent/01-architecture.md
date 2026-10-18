# 01: Architecture

This file is the map. The other files go deeper into each part.

## Components

```mermaid
flowchart TB
  subgraph clients["Clients"]
    webui["Chat UI (browser, ui/)"]
    ask["polyman ask (headless)"]
    evals["Eval runner"]
  end

  subgraph server["src/agent/server"]
    http["HTTP routes"]
    sse["SSE event stream"]
  end

  subgraph core["src/agent/core"]
    session["AgentSession (the loop)"]
    ctx["ContextManager"]
    prompt["PromptBuilder"]
    store["SessionStore"]
    notes["NotesStore"]
  end

  subgraph providers["src/agent/providers"]
    registry["ProviderRegistry"]
    oa["OpenAICompatibleProvider"]
    an["AnthropicProvider"]
    mock["MockProvider"]
    keys["KeyStore"]
  end

  subgraph tools["src/agent/tools"]
    treg["ToolRegistry"]
    perm["PermissionGate"]
    fst["File tools"]
    cfgt["Config tools"]
    clit["CLI tools"]
    remt["Remote tools"]
    skt["Skill + notes tools"]
  end

  subgraph runner["src/agent/runner"]
    cr["CliRunner"]
    kill["killTree()"]
  end

  cli["polyman CLI (child process)"]

  webui <--> http
  webui <--> sse
  http --> session
  sse --> session
  ask --> session
  evals --> ask
  session --> ctx
  session --> prompt
  session --> store
  session --> registry
  session --> treg
  prompt --> notes
  registry --> oa
  registry --> an
  registry --> mock
  registry --> keys
  treg --> perm
  treg --> fst
  treg --> cfgt
  treg --> clit
  treg --> remt
  treg --> skt
  clit --> cr
  remt --> cr
  cr --> kill
  cr --> cli
```

## Layers and import rules

Each layer may only import from the layers under it. This keeps the parts testable on their own.

```mermaid
flowchart TD
  L5["cli.ts commands: chat, ask, ai (dynamic import only)"]
  L4["server + headless renderer"]
  L3["core: AgentSession, ContextManager, PromptBuilder, stores"]
  L2["tools + providers"]
  L1["runner + shared types + small utils"]
  L5 --> L4 --> L3 --> L2 --> L1
```

Rules:

- `src/agent/**` never imports `actions.ts`, `steps.ts` or `helpers/**` that print or exit. It runs the CLI instead (decision D1).
- It may import pure modules that do not print or exit, like `types.d.ts` and the JSON report types.
- `cli.ts` loads the agent with `await import('./agent/index.js')`, so normal commands do not load it.
- Providers know nothing about tools running. Tools know nothing about providers.

## Source layout

```
src/agent/
  index.ts                 startChat(), runAsk(), aiCommands()
  core/
    session.ts             AgentSession: the loop, turns, steps, cancel
    events.ts              AgentEvent union + EventBus
    messages.ts            Message, ContentPart (provider-neutral)
    context.ts             ContextManager: budget, truncation, compaction
    prompt.ts              PromptBuilder: system prompt from parts
    session-store.ts       JSONL sessions on disk
    notes.ts               NotesStore: read/update notes.md
  providers/
    types.ts               Provider, ChatRequest, StreamEvent, ModelInfo
    openai-compatible.ts
    anthropic.ts
    presets.ts             known providers: base URL, env var, models, prices
    capabilities.ts        ModelCapabilities lookup + overrides
    registry.ts            resolve provider + model from settings
    key-store.ts           ~/.polyman/ai.json (0600) + env vars
    retry.ts               backoff, retry-after, error mapping
    sse-parser.ts          parse text/event-stream from fetch()
    mock.ts                scripted provider for tests and evals
  tools/
    types.ts               Tool, ToolContext, ToolOutput, Risk
    registry.ts            register, list specs, validate args, dispatch
    permissions.ts         PermissionGate: policies, session rules, approvals
    schema.ts              small JSON schema validator (subset)
    sandbox.ts             resolve paths inside the problem folder
    fs-tools.ts            list_files, read_file, write_file, edit_file
    config-tools.ts        read_config, update_config
    cli-tools.ts           create_problem, generate, validate, run_solution, test, verify, stress
    remote-tools.ts        remote_pull, remote_push, remote_commit, remote_view, remote_package
    skill-tools.ts         list_skills, load_skill
    notes-tools.ts         read_notes, update_notes
  runner/
    cli-runner.ts          spawn polyman, collect output, timeout, cancel
    kill-tree.ts           kill a process tree on POSIX and Windows
  server/
    http.ts                routes, static files, auth token, Host check
    sse.ts                 event stream with Last-Event-ID replay
    protocol.ts            request/response types shared with ui/
  headless/
    ask.ts                 polyman ask: text or --json renderer
ui/                        web UI source (Vite + React, dev dependencies only)
dist/ui/                   built UI, shipped in the npm package
evals/                     eval cases and runner (not shipped)
```

## Main flows

### A chat turn with one tool call

```mermaid
sequenceDiagram
  autonumber
  participant U as Chat UI
  participant S as Server
  participant A as AgentSession
  participant P as Provider
  participant T as ToolRegistry
  participant R as CliRunner
  participant C as polyman CLI

  U->>S: POST /api/messages {text}
  S->>A: send(text)
  A->>A: PromptBuilder + ContextManager build request
  A->>P: stream(request, signal)
  P-->>A: text_delta ... tool_call(verify)
  A-->>U: events: text_delta, tool_call
  A->>T: run("verify", args)
  T->>T: PermissionGate: risk "run" is allowed
  T->>R: run(["verify", "--json"], cwd = problem folder)
  R->>C: spawn node dist/cli.js verify --json
  C-->>R: stderr lines (progress), stdout JSON, exit code
  R-->>U: events: tool_progress (lines)
  R-->>T: RunResult {exitCode, json, stdoutTail, logPath}
  T-->>A: ToolOutput {content: short digest, data: report}
  A-->>U: event: tool_result
  A->>P: stream(request + tool result)
  P-->>A: text_delta ... done
  A-->>U: events: text_delta, turn_end
```

### A tool call that needs approval

```mermaid
sequenceDiagram
  participant U as Chat UI
  participant A as AgentSession
  participant G as PermissionGate
  participant T as remote_push tool

  A->>G: check(remote_push, args)
  G-->>A: needs approval
  A-->>U: event: approval_needed {id, command, preview}
  Note over U: user reads the exact command and the preview
  U->>A: POST /api/approvals/:id {decision}
  alt allow
    A->>T: run(args)
    T-->>A: ToolOutput
  else deny
    A->>A: tool result = "User denied: <reason>"
  end
  A-->>U: event: tool_result
```

### Cancel

```mermaid
sequenceDiagram
  participant U as Chat UI
  participant A as AgentSession
  participant P as Provider
  participant R as CliRunner

  U->>A: POST /api/cancel (or Esc)
  A->>A: turnController.abort()
  par the model call
    A->>P: fetch is aborted
  and the running tool
    A->>R: signal aborted
    R->>R: killTree(pid): SIGTERM, then SIGKILL after 3s
  end
  A-->>U: event: turn_end {reason: "cancelled"}
```

The session stays alive after a cancel. Only the current turn stops.

## Data on disk

| Path | What | Who writes it |
| --- | --- | --- |
| `~/.polyman/credentials.json` | Polygon key and secret (exists today) | `polyman remote register` |
| `~/.polyman/ai.json` | Provider keys, default provider and model, overrides. Mode `0600`. | `polyman ai login`, settings in the UI |
| `~/.polyman/agent/sessions/` | Sessions that started before a problem folder existed | SessionStore |
| `<problem>/.polyman/agent/notes.md` | Long-term memory of the problem | NotesStore, `update_notes` tool |
| `<problem>/.polyman/agent/sessions/<id>.jsonl` | One file per chat, append-only | SessionStore |
| `<problem>/.polyman/agent/logs/<callId>.log` | Full output of each CLI run | CliRunner |
| `<problem>/.polyman/cache/` | Compile cache (exists today) | CLI |

The agent never reads `credentials.json` or `ai.json` through its tools. The sandbox blocks paths outside the problem folder.

## Error model

```mermaid
flowchart LR
  E["Error happens"] --> Q{"Where?"}
  Q -->|"provider (401, 429, 5xx, network)"| PE["ProviderError: retry if retryable, else show to user, turn ends"]
  Q -->|"tool args invalid"| TA["Tool result with isError = true, model can fix the args"]
  Q -->|"CLI exit code 1 (problem failed)"| C1["Normal tool result: the model reads the report and fixes the problem"]
  Q -->|"CLI exit code 2 or 3 (usage, environment)"| C2["Tool result with isError = true + hint (missing g++, bad Config.json)"]
  Q -->|"tool timeout or cancel"| TO["Tool result: timed out / cancelled"]
  Q -->|"bug in the agent itself"| AB["Event error, turn ends, session saved"]
```

The rule: a failed tool is information for the model, not a crash. Only provider errors that cannot be retried and bugs in the agent end a turn.

## Security model

| Risk | What we do |
| --- | --- |
| Another website talks to the local server | Bind to `127.0.0.1` only, a random token in the URL and in every request, check the `Host` header (blocks DNS rebinding). |
| The model writes outside the problem | All file tools go through `sandbox.ts`: resolve the real path and refuse anything outside the problem folder, and refuse `.polyman/cache`. |
| The model changes Polygon by mistake | Remote tools are risk `remote` and always need approval. The UI shows the exact command. |
| Prompt injection from pulled statements or files | Content from files is data. Dangerous actions still need approval, so injected text cannot push or commit. |
| API keys leak | Keys stay in `ai.json`, are sent only to their own base URL, and are removed from logs, errors and session files. |
| Unreleased problems leak to a provider | Clear notice the first time a provider is used. Ollama works fully offline. |
| Code written by the model runs on the machine | Same as today: polyman already compiles and runs user code. The agent only runs it through the CLI, with the CLI time and memory limits. |

## Testing strategy

| Layer | How we test it |
| --- | --- |
| Providers | Recorded SSE streams as fixtures, fed to the parser and adapters. No network in CI. |
| CliRunner | A tiny fake CLI script that prints, sleeps, exits with codes, or spawns children (to test `killTree`). |
| Tools | Temp problem folders made from `template/`, with the runner mocked or real. |
| AgentSession | `MockProvider` with a script of replies and tool calls. Check the events and the saved session. |
| Server | Start on a random port, call the HTTP API, read SSE. |
| End to end | `polyman ask --provider mock` on a temp copy of the template problem. |
| Quality of the agent | The eval suite with real models, not in CI (see [08-evals-release.md](08-evals-release.md)). |
