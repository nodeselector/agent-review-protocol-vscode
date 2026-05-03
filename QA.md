# QA Process

This repo now has three QA tiers:

- safe automated QA
- manual stub-mode QA
- live-mode QA

## 1. Safe automated QA

Run this from repo root:

```bash
pnpm qa
```

Current `qa` includes:

1. `pnpm typecheck`
2. `pnpm test`

Current automated coverage includes:

- protocol/server smoke tests
- VS Code RPC client tests
- git diff artifact tests
- review store tests
- bus enqueue tests for `review.submit`
- local worker tests for `review.submit` -> `revision.proposed`
- VS Code bus read tests for latest session revision lookup
- pi adapter prompt + normalization tests
- pi adapter stub-mode smoke test
- pi adapter fallback-mode smoke test when `pi` is unavailable

## 2. Manual stub-mode QA

This is the default manual path.

### Prerequisites

- `pnpm install`
- `pnpm build`
- build local wrappers:

```bash
chmod +x scripts/arp-reference-server scripts/arp-pi-adapter
```

- configure VS Code settings to point at:
  - `/absolute/path/to/agent-review-protocol-vscode/scripts/arp-reference-server`
  - `/absolute/path/to/agent-review-protocol-vscode/scripts/arp-pi-adapter`
- export safe adapter mode:

```bash
export ARP_PI_ADAPTER_DISABLE_LIVE=1
```

### Launch extension host

1. Open `packages/vscode-extension/` in VS Code.
2. Press `F5` to open an Extension Development Host.
3. In the new window, open any git workspace folder and file.

### Validate `ARP: Start Session`

1. Run `ARP: Start Session` from the command palette.
2. Confirm you get an information message with a local session id and JSON-RPC payload.

### Validate draft comment workflow

1. Put the cursor on a line in an open file.
2. Run `ARP: Add Draft Comment at Cursor`.
3. Enter comment text.
4. Pick a category.
5. Run `ARP: Show Draft Comments`.
6. Confirm the generated document lists your comment.
7. Run `ARP: Clear Draft Comments`.
8. Run `ARP: Show Draft Comments` again and confirm it says `No draft comments.`

### Validate stub review submit

1. Add one draft comment again.
2. Ensure the repo has a non-empty `git diff`.
3. Run `ARP: Submit Stub Review`.
4. Confirm the opened JSON result contains:
   - `adapter: "pi"`
   - `mode: "stub"`
   - `revision`
   - the current diff in the prompt body

### Validate bus review submit

1. Add one draft comment again.
2. Ensure the repo has a non-empty `git diff`.
3. Run `ARP: Submit Review to Bus`.
4. Confirm the opened document contains:
   - command ID
   - session ID
   - workspace ID
   - DB path
5. Confirm the SQLite DB exists at `.arp/bus/arp.db` unless `arp.busDbPath` is set.

### Validate one-shot local worker

1. Enqueue a review with `ARP: Submit Review to Bus`.
2. Run:

```bash
scripts/arp-bus-worker --db /absolute/path/to/workspace/.arp/bus/arp.db
```

3. Confirm the command reports `kind: "processed"`.
4. Confirm a `revision.proposed` event exists in the SQLite bus.

### Validate bus revision read path

1. After the worker runs, return to the Extension Development Host.
2. Run `ARP: Show Latest Bus Revision`.
3. Confirm a markdown review result opens.
4. Confirm it reflects the latest `revision.proposed` event for the current session.

## 3. Live-mode QA

This is opt-in and may be slow or disruptive.

### Extra guardrails

Set a timeout first:

```bash
export ARP_PI_TIMEOUT_MS=45000
```

Optionally force a faster model/provider:

```bash
export ARP_PI_PROVIDER=github-copilot
export ARP_PI_MODEL='*sonnet*'
```

Unset stub mode:

```bash
unset ARP_PI_ADAPTER_DISABLE_LIVE
```

### Recommended order

1. Validate live adapter from CLI first.
2. Only after that, validate from the Extension Development Host.

### CLI live check

Use a small diff payload and confirm the adapter returns either:

- `mode: "live"` with `normalized: true|false`, or
- `mode: "fallback"` with a clear failure note

A fallback result is acceptable for QA at this stage. A hang is not.

### Extension live check

1. Open the Extension Development Host.
2. Add one draft comment.
3. Run `ARP: Submit Stub Review`.
4. Confirm it returns JSON and the editor remains responsive.

## Failure modes to watch

- no workspace open
- no active editor
- empty git diff
- wrapper script path is wrong or not executable
- `node` is unavailable to the wrapper script
- live adapter timeout
- JSON result opens, but `mode: "fallback"`

## Exit criteria for current MVP stage

This stage is healthy if all of the following are true:

- `pnpm qa` passes locally
- stub-mode manual flow works end-to-end
- live mode returns either a bounded live result or a bounded fallback result
- no command leaves the editor stuck indefinitely
