# Demo Script

## Goal

Show the local queue-based ARP review loop in VS Code:

1. draft comment
2. queue review
3. auto-start worker
4. receive revision result
5. reopen latest result from the bus

## Setup

```bash
pnpm install
pnpm build
export ARP_PI_ADAPTER_DISABLE_LIVE=1
```

## VS Code settings

Point `arp.referenceServerCommand` at:

- `/absolute/path/to/agent-review-protocol-vscode/scripts/arp-reference-server`

Optional useful settings:

- `arp.autoStartBusWorkerLoop = true`
- `arp.busWaitTimeoutMs = 15000`
- `arp.busPollIntervalMs = 500`

## Demo flow

1. Open `packages/vscode-extension/` in VS Code.
2. Press `F5`.
3. In the Extension Development Host, open any git workspace with a small diff.
4. Run `ARP: Start Session`.
5. Add one draft comment with `ARP: Add Draft Comment at Cursor`.
6. Run `ARP: Show Draft Comments`.
7. Run `ARP: Submit Review`.

Expected:

- a notification shows ARP review progress
- the worker loop starts automatically if needed
- the ARP output channel shows queue and worker activity
- a markdown review result opens automatically when ready

8. Run `ARP: Show Latest Bus Revision`.

Expected:

- the same latest session result is available from the bus

## Fallback story

If the result does not arrive before the wait timeout:

- a bounded enqueue confirmation opens
- no hang occurs
- you can still run `ARP: Show Latest Bus Revision` later

## What to point out

- queue-first architecture
- durable SQLite transport
- separate worker execution from editor UX
- result recovery from the bus, not just in-memory callback flow
