# Testing strategy

## Failure-first method

The canonical project uses regression tests to capture the earliest violated invariant before changing production behavior:

1. Convert an observed failure into a deterministic source-equivalent fixture.
2. Demonstrate the failure before the repair.
3. Locate the first broken acquisition, durability, identity, authority, or projection boundary.
4. Apply the smallest domain repair.
5. Rerun focused and inherited suites.

The public suite contains the sanitized, post-repair invariants. It does not include personal evidence or claim to reproduce a physical device.

## Included coverage

- Native timestamp normalization and acceptance
- Exactly one lifecycle acquisition authority
- Durable chronological reads, retry recovery, acknowledgement shadow, and account partitioning
- Equivalent local/server timestamp identity
- Local/remote exact deduplication
- Ongoing stay continuity across intentionally sparse archive cadence
- Conservative process reconstruction
- Credible movement and long-gap separation
- Selected-day stay projection from real evidence only

## Synthetic fixtures

Fixtures use `account-alpha` / `account-beta`, fixed UTC dates, and generic synthetic coordinates. Replacing private fixture values does not alter assertions, policy thresholds, or production calls.

## Commands

```bash
npm test
npm run typecheck
npm run check
```

Tests run entirely in process and require no provider credentials, device, simulator, database, or network service.
