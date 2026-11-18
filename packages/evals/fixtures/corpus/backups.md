# Backups

## Schedule

A full database dump runs nightly at 02:00 UTC, together with an archive of uploaded files.

## Retention

Daily backups are kept for 14 days and weekly backups for 8 weeks. Dumps are readable only by the owner.

## Restoring

Run scripts/restore.sh with the dump file. It stops the app, recreates the database, restores the dump and starts the app again. A pre-restore dump is taken first.
