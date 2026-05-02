# QA Process

This repo has two QA loops right now:

- automated smoke tests for the reference server and pi adapter
- manual validation for the VS Code extension scaffold

## Automated loop

Run this from repo root:

```bash
pnpm qa
```

Current `qa` includes:

1. `pnpm build`
2. `pnpm typecheck`
3. `pnpm test`

## Manual VS Code checklist

### Prerequisites

- `pnpm install`
- `pnpm build`
- `PATH` includes the repo root `node_modules/.bin`

### Launch extension host

1. Open `packages/vscode-extension/` in VS Code.
2. Press `F5` to open an Extension Development Host.
3. In the new window, open any workspace folder and file.

### Validate `ARP: Start Session`

1. Run `ARP: Start Session` from the command palette.
2. Confirm you get an information message with a JSON-RPC session payload.
3. Failure modes to note:
   - no workspace open
   - `arp-reference-server` not found on PATH
   - invalid JSON-RPC output

### Validate `ARP: Submit Stub Review`

1. Place the cursor on any line in the active editor.
2. Run `ARP: Submit Stub Review` from the command palette.
3. Confirm you get an information message containing:
   - `adapter: "pi"`
   - the current file path
   - the selected line number
4. Failure modes to note:
   - no workspace open
   - no active editor
   - `arp-pi-adapter` not found on PATH

## What this does not cover yet

Not covered in this first QA pass:

- real git diff capture
- inline comment UI
- batch review state storage
- invoking pi end-to-end
- VS Code integration tests in CI

## Exit criteria for this stage

This stage is healthy if all of the following are true:

- `pnpm qa` passes locally
- both extension commands execute in an Extension Development Host
- command failures are understandable and actionable
