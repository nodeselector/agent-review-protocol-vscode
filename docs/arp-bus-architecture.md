# ARP Bus Architecture

## Intent

ARP bus is a local message-passing substrate with delivery durability.

It exists to move typed review and revision signals between clients like VS Code and workers like pi.

It is not intended to be a permanent system of record.

## Core split

### Commands

Single-consumer work items.

Examples:

- `review.submit`
- `revision.apply.request`

### Events

Append-only fan-out notifications.

Examples:

- `session.created`
- `draft.comment.added`
- `review.submitted`
- `revision.proposed`
- `revision.failed`

## Domain-first rule

Everything above the storage adapter depends on domain contracts, not SQLite details.

The implementation should preserve these layers:

1. domain model and invariants
2. repository interfaces
3. service contracts
4. storage adapter

## Invariants

See `@arp/domain` exports:

- `ARP_INVARIANTS`
- `SQLITE_ADAPTER_BOUNDARY`

The important point is that invariants are defined in a store-agnostic way so SQLite can be replaced later.

## Repository contracts

The first repository interfaces are defined in `packages/arp-domain/src/index.ts`:

- `CommandRepository`
- `EventRepository`
- `SubscriptionRepository`
- `SessionRepository`
- `BusService`

These contracts define the semantics required from any datastore adapter.

## SQLite boundary

SQLite is the first adapter, not the architecture.

The adapter must provide:

- atomic claim
- atomic complete + emitted events
- atomic fail + emitted events
- append-only event sequencing
- forward-only checkpoint updates
- lease expiry and reclaim

A future Postgres or other adapter should satisfy the same contracts.

## Retention

The bus may retain messages and events only as long as needed for delivery and recovery.

Long-term persistence should be handled by hook consumers, not the bus itself.

## Current implementation status

A first concrete SQLite adapter now exists in `packages/arp-store-sqlite`.

It currently implements:

- workspace/session persistence
- command enqueue/claim/requeue
- event append/read
- checkpoint advancement
- bus-level atomic complete/fail with emitted events

The VS Code side can now enqueue `review.submit` commands, and a tiny local worker can claim one command and emit `revision.proposed`.

What is still missing:

- event consumption back into the editor UI
- long-running worker loop / daemon behavior
- subscription-driven projection or read model for review state

## Next implementation step

Teach the VS Code extension to read `revision.proposed` events from the bus and render results without the direct RPC path.
