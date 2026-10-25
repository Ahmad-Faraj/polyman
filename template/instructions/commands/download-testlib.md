# `polyman download-testlib`

Fetches `testlib.h` from the upstream GitHub repo into the **current** working directory.

```bash
polyman download-testlib
```

`testlib.h` is required to compile generators, validators, and custom checkers — they all `#include "testlib.h"`. polyman won't compile them otherwise.

## Where the file ends up

In the current working directory. For polyman to find it during compilation, run this from the **problem directory**:

```bash
cd my-problem
polyman download-testlib
```

The command also prints platform-specific instructions for installing `testlib.h` system-wide (`/usr/include`, `/usr/local/include`, or the MinGW include dir on Windows). System-wide install is optional — polyman finds `testlib.h` in the problem dir by default.

## When to run it

- Right after `polyman new`, before the first `polyman generate` / `polyman verify`.
- After upgrading polyman to a new major version, in case the bundled testlib is updated.
- If `polyman generate` errors with `testlib.h: No such file or directory`.

## When `testlib.h` already exists

If `testlib.h` is already in the current directory and is different from the upstream one, the command does not replace it and exits 2. A problem pulled with `polyman remote pull` can have Polygon's own `testlib.h` (and other headers) next to `Config.json`; keep it, so the problem builds like it does on Polygon. Delete `testlib.h` first only if you really want the upstream version.

## What NOT to do

- Don't modify `testlib.h` after downloading. polyman expects the upstream version, or the one pulled from Polygon.
- Don't rerun if it's already there and working. It is a no-op for the same file and refuses a different one.
- Don't commit `testlib.h` if your project policy excludes vendored upstream — polyman will re-download on demand.
