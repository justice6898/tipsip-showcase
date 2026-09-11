# Provenance and sanitization

## What is real production source

Files under `src/features/locationHistory`, `src/lib`, `src/types`, and the two selected `shared/planning` modules are copied from the canonical private application snapshot. They retain the implemented policies, state machines, interfaces, and comments.

## Public-only adaptations

1. `src/lib/geoDistance.ts` imports the included distance implementation directly instead of traversing the private application's broader shared barrel. The distance implementation itself is unchanged.
2. The `GeoCoordinate` type is extracted verbatim into `src/types/location.ts`; four selected modules point to that focused type boundary instead of importing the private application's much broader UI/social type module.
3. The public test file consolidates selected real regression scenarios. Account values, timestamps, and coordinates are replaced with unmistakably synthetic fixtures; assertions and production APIs retain their original semantics.
4. README, documentation, package metadata, TypeScript configuration, and `.gitignore` are authored specifically for this public showcase.

No private adapter was recreated. No omitted feature is represented by fabricated production behavior.

## Excluded source classes

- Secrets, environment variants, linked-project metadata, and deployment configuration
- Native iOS/Android projects, build output, device logs, and signing material
- Backend services, provider credentials/adapters, migrations, and administrative paths
- Concrete native SQLite and secure-storage bindings
- Full application UI, localization dictionaries, assets, screenshots, and private fixtures
- Operational/release documents and generated output
- Original `.git` directory and all private history

The private root's Expo template license was also excluded because it is not an
appropriate license grant for this selected application source. Repository
licensing should be chosen explicitly by the owner before publication.
