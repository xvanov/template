# Deploying the app

## Shipping a release

Merge to main, wait for CI to pass, then run scripts/deploy.sh deploy on the production host. The script builds images, migrates the database and swaps containers behind a health check.

## Rollback

If a release misbehaves, run scripts/deploy.sh rollback. It swaps back to the previous image tag within a minute. The database schema is not rolled back, so migrations must stay compatible with the previous release.

## Destructive migrations

The deploy script refuses migrations that drop or rename columns unless you pass --allow-destructive.
