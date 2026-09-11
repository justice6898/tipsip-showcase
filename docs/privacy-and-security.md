# Privacy and security

## Data minimization

This repository contains no real location samples. Public tests use synthetic account labels and synthetic coordinates. There are no screenshots, logs, diagnostic dumps, environment files, source maps, service URLs, provider payloads, or user-generated records.

## Account isolation

Account identity is checked at multiple independent boundaries:

- history point validation,
- append/replay normalization,
- durable outbox partitioning,
- acknowledgement and retry operations,
- local/remote composition,
- stay-authority binding,
- authorized repository reads.

Mismatched authority decisions and account substitutions fail closed. Account changes clear process-local stay state rather than rebinding it.

## Evidence integrity

The system distinguishes canonical facts from derived state:

- Provider observations are normalized once.
- Durable capture identities bind timestamp and coordinate.
- Motion evidence has bounded windows and source requirements.
- Presentation clocks cannot synthesize telemetry.
- Remote row IDs cannot alter logical observation equality.
- Locale, address text, and display labels do not define visits.

## Public-export boundary

Excluded material includes all credentials and configuration, concrete production/staging endpoints, database schemas and migrations, native signing state, secure-storage bindings, device metadata, operational scripts, and private documentation.

The showcase has no `.env.example` because it requires no configuration. `.gitignore` rejects common credential, signing, environment, log, build, and dependency artifacts.

## Responsible limitations

The included in-memory outbox is a deterministic implementation of the production interface, not a claim of crash-safe persistence. The private product uses a native SQLite implementation that is intentionally not published here. Similarly, provider and backend interfaces do not imply a live public service.
