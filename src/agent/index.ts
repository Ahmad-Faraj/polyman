/**
 * The `polyman chat` entry point. `cli.ts` loads this file with a dynamic
 * `import()` only when `chat` runs.
 *
 * For now it is a stub, the wiring (W0b) replaces it.
 */

/** Starts the chat in `opts.dir` with `opts.model`. */
export function startChat(_opts: {
  dir?: string;
  model?: string;
}): Promise<void> {
  console.log('polyman chat is not ready yet');
  return Promise.resolve();
}
