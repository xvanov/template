-- ─────────────────────────────────────────────────────────────────────────
-- Collation guard for the CURRENT database. Run before every migration (the
-- `migrate` service) and by scripts/lib/collation.sh (deploy.sh, make up,
-- setup.sh) for every database on the server.
--
-- Text indexes are ordered by the database's collation. With the libc
-- provider that order comes from the C library of the IMAGE, so reopening a
-- data directory under another libc (postgres:17-alpine/musl → a Debian/glibc
-- image) leaves every text index silently wrong: lookups miss rows that exist
-- and unique indexes admit duplicates. Postgres records the collation version
-- a database was created with (datcollversion); when it differs from what
-- the library reports now, every user index is rebuilt here and the new
-- version recorded. Otherwise this is one cheap query.
--
-- One transaction: if a rebuild fails (a unique index already holds rows that
-- are duplicates under the correct order), NOTHING changes, the version is NOT
-- recorded, and the error (naming the index and the key) stops the caller.
-- That needs a person — see docs/guide.md, "collation".
--
-- Why not REINDEX DATABASE: it cannot run in a transaction block, and this
-- runs through `prisma db execute`, which can only send one script. Tables
-- are reindexed one by one (system catalogs excluded: their indexed text is
-- `name`, which sorts bytewise in every libc). The version is written to the
-- catalog directly: ALTER DATABASE ... REFRESH COLLATION VERSION refuses a
-- database created under musl, which recorded no version at all. Superuser
-- only (the deploy connects as `postgres`).
-- ─────────────────────────────────────────────────────────────────────────
DO $collation_guard$
DECLARE
  stored text;
  actual text;
  t record;
  n int := 0;
BEGIN
  SELECT datcollversion, pg_database_collation_actual_version(oid)
    INTO stored, actual
    FROM pg_database WHERE datname = current_database();
  IF stored IS NOT DISTINCT FROM actual THEN
    RETURN;
  END IF;
  RAISE NOTICE 'collation of database % changed (% -> %): rebuilding its indexes',
    current_database(), coalesce(stored, 'none'), coalesce(actual, 'none');
  FOR t IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm')
      AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ns.nspname NOT LIKE 'pg_toast%'
      AND ns.nspname NOT LIKE 'pg_temp%'
      AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid)
  LOOP
    EXECUTE format('REINDEX TABLE %s', t.rel);
    n := n + 1;
  END LOOP;
  UPDATE pg_database SET datcollversion = actual
    WHERE datname = current_database();
  RAISE NOTICE 'collation of database %: % tables reindexed, version % recorded',
    current_database(), n, coalesce(actual, 'none');
END
$collation_guard$;
