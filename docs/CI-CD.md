# CI/CD

## Pipelines
- **ci** - build, lint, test on every PR and push.
- **image** - build multi-stage image, scan for vulns, push to GHCR on main.
- **staging-deploy** - deploys the pushed image tag to the staging host on main.
- **release** - on a `vX.Y.Z` tag, cuts a GitHub release with generated notes.

### ci jobs

| job               | what fails it                                                           |
|-------------------|-------------------------------------------------------------------------|
| lint              | eslint errors or warnings                                               |
| build             | type errors, nest build                                                 |
| unit tests        | a failing spec or coverage below the thresholds in package.json         |
| e2e tests         | `migration:run` on a fresh Postgres, then the e2e suites                |
| migration drift   | entities and committed migrations disagree, or a migration cannot be reverted |
| contract tests    | forge build, forge test, the testnet profile build                      |

The migration drift job (`scripts/check-migrations.sh`) runs every migration
on an empty database, then asks TypeORM for the SQL the entities would still
need (`migration:generate --check`). Anything there means an entity changed
without a migration; the missing SQL is printed in the job summary, ready to
be turned into one with `npm run migration:generate -- src/migrations/<Name>`.
It then reverts every migration down to an empty schema and applies them
again, so a broken `down()` is caught before a rollback needs it.

Locally, against a database it may wipe:

```bash
npm run build && npm run migration:verify
```

## Secrets
`GHCR_TOKEN`, `STAGING_SSH_KEY`, `POSTGRES_PASSWORD`, chain RPC urls. Stored as
GitHub Actions environment secrets scoped to the `staging` environment.

## Rollback
Redeploy the previous image tag: `IMAGE_TAG=<prev-sha> docker compose -f docker-compose.staging.yml up -d`.
Tags are immutable (sha-pinned), so a rollback is deterministic.
