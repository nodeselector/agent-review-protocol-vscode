# agent-review-protocol-vscode

VS Code extension and reference implementation for the Agent Review Protocol.

## Packages

- `packages/vscode-extension` - VS Code client for local diff review workflows
- `packages/pi-adapter` - pi-backed review execution plus local SQLite bus workers
- `packages/reference-server` - reference JSON-RPC server for ARP over stdio
- `packages/protocol` - shared protocol types and message helpers
- `packages/arp-domain` - datastore-agnostic ARP bus domain contracts
- `packages/arp-store-sqlite` - first concrete durable transport adapter using SQLite

## Goals

- provide a concrete VS Code UX for ARP
- provide a reference local transport and server shape
- provide a pi-backed review worker that can participate in the protocol
- keep the design reusable for other agent vendors

## Status

Local prototype. This repo currently contains:

- package workspace layout
- initial protocol types

- reference server

- VS Code command-driven review scaffold
- bus-backed review submission path via local SQLite as the primary review flow
- local worker paths that consume `review.submit` and emit `revision.proposed`
- VS Code read path that loads the latest `revision.proposed` for the current session
- active review overview sidebar with session, expandable draft comments, separate context references, file, and latest result summary plus quick actions
- automatic hydration of latest review result from the bus on activation/workspace switch
- status bar summary for the active review with one-click jump back into the flow
- changed-files sidebar for the active review with diff opening against HEAD, draft counts, and result status summaries
- latest revision results projected back onto inline draft comment threads
- bounded wait path so bus submit can sync results back into the native review UI when the worker finishes in time
- lazy in-editor worker supervisor that can auto-start the local bus worker loop
- pi-backed review execution with stub, fallback, and live-gated modes
- local draft review storage and git diff capture
- automated QA coverage around the risky paths
- initial ARP bus domain interfaces, invariants, and adapter boundary docs
- first SQLite-backed ARP bus adapter behind repository contracts



## Development

```bash
pnpm install
pnpm build
pnpm dev
```

## QA

```bash
pnpm qa
pnpm qa:manual
```

See [`QA.md`](QA.md) for safe, stub-mode, and live-mode validation tiers.

See [`DEMO.md`](DEMO.md) for a short human demo script.

See [`docs/arp-bus-architecture.md`](docs/arp-bus-architecture.md) for the datastore-agnostic bus model.


## Quick local test

```bash
pnpm install
pnpm build
export ARP_PI_ADAPTER_DISABLE_LIVE=1
```

Then open `packages/vscode-extension/` in VS Code, press `F5`, and run:

1. `ARP: Start Session`
2. `ARP: Add Draft Comment at Cursor`, use `Add ARP draft comment` inline on changed lines, or use native comment affordances anywhere in the workspace after a session starts
3. Check `ARP Review Overview` for active session, expandable draft comments, context references, and review status
4. Use the `ARP Review Overview` action or `ARP Review Files` view to open the next review file diff
5. `ARP: Submit Review`
6. `ARP: Show Latest Bus Revision`

You should see draft comments and result state stay inside the native review UI. Raw JSON still lands in the ARP output channel.

If your binaries are not on `PATH`, use the local wrapper scripts from this repo in VS Code settings:

- `arp.referenceServerCommand` -> `/absolute/path/to/agent-review-protocol-vscode/scripts/arp-reference-server`
- `arp.referenceServerTimeoutMs`
- `arp.busDbPath` - optional override for the local SQLite bus database
- `arp.busWaitTimeoutMs` - how long bus submit waits for a matching result before falling back to enqueue-only confirmation
- `arp.busPollIntervalMs` - poll interval while waiting for a bus result
- `arp.autoStartBusWorkerLoop` - lazily start or reuse a local worker loop on bus submit
- `arp.busWorkerLoopCommand` - optional explicit command for the persistent worker loop
- `arp.busWorkerLoopPollIntervalMs` - polling interval used by the persistent worker loop
- `scripts/arp-bus-worker-loop --db /absolute/path/to/.arp/bus/arp.db` - keep polling and process queued review commands until stopped

## Workspace layout

```text
packages/
  arp-domain/
  arp-store-sqlite/
  protocol/
  reference-server/
  pi-adapter/
  vscode-extension/
```
