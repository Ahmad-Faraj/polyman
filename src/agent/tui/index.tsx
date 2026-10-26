/**
 * The terminal UI of `polyman chat`. `src/agent/index.ts` loads this file
 * with `await import('./tui/index.js')`, so Ink loads only for the chat.
 */

import { render } from 'ink';
import type { EventBus } from '../core/events.js';
import type { AgentSessionApi } from '../core/session-types.js';
import { App, type TuiInfo } from './App.js';

export type { TuiInfo } from './App.js';

/**
 * Draws the chat and resolves when the user exits. Prints `Bye.` after.
 * After ctrl+z the process exits right away, so a stuck tool or request
 * cannot keep it alive.
 */
export async function startTui(
  session: AgentSessionApi,
  bus: EventBus,
  info: TuiInfo
): Promise<void> {
  let forced = false;
  const instance = render(
    <App
      session={session}
      bus={bus}
      info={info}
      onForceExit={() => {
        forced = true;
      }}
    />,
    { exitOnCtrlC: false }
  );
  try {
    await instance.waitUntilExit();
  } finally {
    instance.cleanup();
    console.log('Bye.');
  }
  if (forced) process.exit(130);
}
