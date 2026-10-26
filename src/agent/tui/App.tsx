import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { ApprovalDecision, EventBus } from '../core/events.js';
import type { AgentSessionApi } from '../core/session-types.js';
import type { PermissionMode } from '../tools/types.js';
import { initialState, reduce, type ApprovalView } from './store.js';
import { EMPTY_EDITOR, History, type EditorState } from './editor.js';
import {
  appKeyOf,
  AUTO_EDIT_NOTICE,
  BUSY_HINT,
  CTRL_C_HINT,
  CTRL_C_WINDOW_MS,
  CtrlCTracker,
  HELP_TEXT,
  nextMode,
  parseCommand,
} from './keybindings.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { Composer } from './components/Composer.js';
import { LiveArea } from './components/LiveArea.js';
import { StatusLine } from './components/StatusLine.js';
import { Transcript } from './components/Transcript.js';
import { fg } from './theme.js';

/** What the chat shows about itself in the header and the status line. */
export interface TuiInfo {
  /** The problem folder name, or null for a new problem. */
  problem: string | null;
  /** The model id, like `google/gemma-4-31b-it`. */
  model: string;
  /** The permission mode at start, `ask` by default. */
  mode?: PermissionMode;
  /** Called when the user switches the mode (shift+tab). */
  setMode?: (mode: PermissionMode) => void;
}

export interface AppProps {
  session: AgentSessionApi;
  bus: EventBus;
  info: TuiInfo;
}

/** The text of a plan, for the plan approval box. */
function planPreview(plan: { tasks: { id: string; title: string }[] }) {
  return plan.tasks.map(t => `${t.id}  ${t.title}`).join('\n');
}

/** The chat: transcript, live area, approval, input and status line. */
export function App({ session, bus, info }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reduce, info, initialState);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [hint, setHint] = useState<string | null>(null);
  const history = useRef(new History()).current;
  const ctrlC = useRef(new CtrlCTracker()).current;
  // Keys can come faster than React renders: handlers read the newest state.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => bus.on(e => dispatch(e)), [bus]);

  // The ctrl+c hint is true for one second only.
  useEffect(() => {
    if (hint !== CTRL_C_HINT) return;
    const timer = setTimeout(() => setHint(null), CTRL_C_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  const changeEditor = (next: EditorState) => {
    setHint(null);
    setEditor(next);
  };

  const submit = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    const command = parseCommand(text);
    if (command) {
      setEditor(EMPTY_EDITOR);
      history.add(raw);
      if (command.name === 'help') {
        dispatch({ type: 'notice', text: HELP_TEXT });
      } else {
        dispatch({
          type: 'notice',
          level: 'warn',
          text: `Unknown command /${command.name}. Type /help for the commands.`,
        });
      }
      return;
    }
    if (stateRef.current.status.busy) {
      setHint(BUSY_HINT);
      return;
    }
    setEditor(EMPTY_EDITOR);
    setHint(null);
    history.add(raw);
    // Mark busy now, so a second enter cannot send before turn_start.
    stateRef.current = reduce(stateRef.current, { type: 'user_message', text });
    dispatch({ type: 'user_message', text });
    void session
      .send(text)
      .catch((err: unknown) => {
        dispatch({
          type: 'notice',
          level: 'error',
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => dispatch({ type: 'turn_settled' }));
  };

  const switchMode = () => {
    const mode = nextMode(stateRef.current.status.mode);
    stateRef.current = reduce(stateRef.current, { type: 'set_mode', mode });
    dispatch({ type: 'set_mode', mode });
    info.setMode?.(mode);
    if (mode === 'auto-edit') {
      dispatch({ type: 'notice', level: 'warn', text: AUTO_EDIT_NOTICE });
    }
  };

  const interrupt = () => {
    if (stateRef.current.status.busy) session.cancel();
  };

  useInput((input, key) => {
    const action = appKeyOf(input, key);
    if (action === 'ctrl_c') {
      if (ctrlC.press(Date.now()) === 'exit') {
        if (stateRef.current.status.busy) session.cancel();
        exit();
        return;
      }
      setEditor(EMPTY_EDITOR);
      setHint(CTRL_C_HINT);
    } else if (action === 'toggle_mode') {
      switchMode();
    } else if (action === 'interrupt') {
      // With an approval box open, the box handles esc.
      if (!stateRef.current.approval && !stateRef.current.planApproval) {
        interrupt();
      }
    }
  });

  const answer = (approvalId: string, decision: ApprovalDecision) => {
    session.resolveApproval(approvalId, decision);
    dispatch({ type: 'approval_answered', approvalId });
  };

  let prompt: ReactNode = null;
  if (state.approval) {
    prompt = (
      <ApprovalPrompt
        key={state.approval.approvalId}
        approval={state.approval}
        resolveApproval={answer}
        onCancel={interrupt}
      />
    );
  } else if (state.planApproval) {
    const view: ApprovalView = {
      approvalId: state.planApproval.approvalId,
      callId: '',
      toolName: 'start_workflow',
      title: `Run this plan? (${state.planApproval.plan.recipe}, ${state.planApproval.plan.tasks.length} tasks)`,
      preview: planPreview(state.planApproval.plan),
    };
    prompt = (
      <ApprovalPrompt
        key={view.approvalId}
        approval={view}
        variant="plan"
        resolveApproval={answer}
        onCancel={interrupt}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Transcript
        items={state.finished}
        problem={info.problem}
        model={info.model}
      />
      <LiveArea live={state.live} busy={state.status.busy} />
      {prompt}
      {prompt === null && (
        <Composer
          value={editor}
          onChange={changeEditor}
          onSubmit={submit}
          history={history}
        />
      )}
      {hint === BUSY_HINT && <Text {...fg('warn')}> {hint}</Text>}
      <StatusLine
        status={state.status}
        hint={hint === CTRL_C_HINT ? hint : null}
      />
    </Box>
  );
}
