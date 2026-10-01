# Bounded store migrations

Generated locally on 1 October 2026 with pinned Drizzle Kit 0.31.11 / ORM 0.45.3. This directory contains no Site ID, database URL, credential or remote-operation command. Its dependencies are tooling only and do not change the app's package lock or runtime.

`db/schema.ts` describes the existing four-column ciphertext table. The generated `0000_demo_objects.sql` supplies its primary key and three checks. `0001_demo_quota.sql` was created with Drizzle's `generate --custom` and filled with the existing quota trigger. Apply it as **one complete SQL statement**; do not split on the semicolon inside `BEGIN`/`END`. Generated snapshots and the journal accompany both migrations.

The original local fixture at `../../migrations/0001_demo_objects.sql` remains intact. New tests compare schema constraints/quotas and run the actual HTTP-store handler against the generated schema. This is local SQLite evidence, not proof of a hosted D1 deployment or the Sites archive pipeline.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Generate an additional migration only after changing the schema, inspect it before use and keep the custom trigger intact. No remote database is configured. Once a migration is applied, its SQL, snapshot and journal entry are immutable. Do not run both the old combined fixture SQL and these migrations against the same database.

The planned target is one new, empty demonstration database. Two slots share that database and operator. Limits remain 16 objects/slot, 2 indexes/slot and 16 MiB total object bytes. These are storage limits, not billing or request-rate guarantees. Platform pricing/access and actual D1 compatibility remain separate checks before publication.

References: [Drizzle generation](https://orm.drizzle.team/docs/drizzle-kit-generate), [custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations). Read 1 October 2026. The previously inspected Sites storage reference requires generated schema SQL/journal/snapshots; its local publishing scripts were unavailable during this block, so no platform validation or publication is claimed.
