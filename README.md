# agent-review-protocol-vscode

VS Code extension and reference implementation for the Agent Review Protocol.

## Packages

- `packages/vscode-extension` - VS Code client for local diff review workflows
- `packages/pi-adapter` - pi-specific adapter for ARP
- `packages/reference-server` - reference JSON-RPC server for ARP over stdio
- `packages/protocol` - shared protocol types and message helpers

## Goals

- provide a concrete VS Code UX for ARP
- provide a reference local transport and server shape
- provide a pi adapter that can participate in the protocol
- keep the design reusable for other agent vendors

## Status

Local prototype. This repo currently contains:

- package workspace layout
- initial protocol types
- reference server
- VS Code command-driven review scaffold
- pi adapter with stub, fallback, and live-gated modes
- local draft review storage and git diff capture
- automated QA coverage around the risky paths

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

## Quick local test

```bash
pnpm install
pnpm build
export ARP_PI_ADAPTER_DISABLE_LIVE=1
```

Then open `packages/vscode-extension/` in VS Code, press `F5`, and run:

1. `ARP: Start Session`
2. `ARP: Add Draft Comment at Cursor`
3. `ARP: Show Draft Comments`
4. `ARP: Submit Stub Review`

You should get a markdown result document plus raw JSON in the ARP output channel.

## Workspace layout

```text
packages/
  protocol/
  reference-server/
  pi-adapter/
  vscode-extension/
```
