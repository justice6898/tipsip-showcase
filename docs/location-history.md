# Location-history model

## Evidence stages

1. A provider callback is normalized into one canonical observation.
2. Freshness, future-skew, accuracy, and coordinate validity are assessed.
3. An eligible sample receives an exact capture identity and crosses the durable archive boundary.
4. Pending and recently acknowledged evidence remains account partitioned.
5. Authorized remote rows supersede exact local duplicates during reconciliation.
6. The stay authority derives candidate or confirmed state from canonical evidence.
7. Route and day projection derive movements, stays, and gaps without writing new evidence.

## Observation identity

The self-history reconciliation identity contains:

- account/subject identity,
- the parsed capture instant in epoch milliseconds,
- latitude,
- longitude.

This makes equivalent ISO timestamp spellings stable across local SQLite and PostgreSQL representations. Server-generated row IDs, process generations, locale, translated addresses, and UI instance keys are not equality inputs.

## Durable outbox

The durable interface models `pending`, `inflight`, and `quarantined` rows. Reads are chronological and account scoped. Failed delivery releases inflight rows with bounded backoff. Successful acknowledgement moves the sample into a bounded acknowledgement shadow so read-after-write delay cannot erase recent local truth; remote visibility allows the shadow to be retired later.

The showcase includes this contract and deterministic memory adapter, not the native SQLite implementation.

## Stay continuity

A stay begins as a candidate anchored to its first durable point. Confirmation requires the configured dwell duration plus either sparse same-cluster location evidence or measured stationary motion coverage.

Three times are deliberately distinct:

- original T0,
- latest real corroboration,
- read-time `now` used to display ongoing duration.

Advancing `now` does not create a GPS point. A directly proven current visit does not become finalized merely because the next intentionally sparse stationary archive sample has not arrived. History-only reconstruction remains conservative until an exact current durable callback is observed.

Credible motion can explicitly finalize the confirmed candidate. A real relocation or a long canonical evidence gap starts a new candidate. The system does not merge visits by address text or broad spatial similarity.

## Selected-day projection

`filterPersonLocationHistoryForDay` intersects authorized spans with local calendar-day bounds. `projectLocationHistoryRoute` preserves explicit unavailable boundaries and rejects physically implausible isolated spikes. `projectLocationHistoryDayEventsForRoute` derives movements, stays, records, and gaps.

An ongoing stay is one canonical stay event whose read-time end is extended to `now`; the latest evidence timestamp remains available separately. This keeps the history scrubber tied to real evidence while allowing truthful duration copy.
