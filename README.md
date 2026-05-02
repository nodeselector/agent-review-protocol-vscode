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

Scaffold only. This repo currently contains:

- package workspace layout
- initial protocol types
- reference server skeleton
- VS Code extension skeleton
- pi adapter skeleton

## Development

```bash
pnpm install
pnpm build
pnpm dev
```

## QA

```bash
pnpm qa
```

See [`QA.md`](QA.md) for the current automated and manual validation loop.

## Workspace layout

```text
packages/
  protocol/
  reference-server/
  pi-adapter/
  vscode-extension/
```
