# CI/CD

## Pipelines
- **ci** - build, lint, test on every PR and push.
- **image** - build multi-stage image, scan for vulns, push to GHCR on main.
- **staging-deploy** - deploys the pushed image tag to the staging host on main.
- **release** - on a `vX.Y.Z` tag, cuts a GitHub release with generated notes.

## Secrets
`GHCR_TOKEN`, `STAGING_SSH_KEY`, `POSTGRES_PASSWORD`, chain RPC urls. Stored as
GitHub Actions environment secrets scoped to the `staging` environment.

## Rollback
Redeploy the previous image tag: `IMAGE_TAG=<prev-sha> docker compose -f docker-compose.staging.yml up -d`.
Tags are immutable (sha-pinned), so a rollback is deterministic.
