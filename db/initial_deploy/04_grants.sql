-- ============================================================
-- ZyM - 04_grants.sql
-- SCRIPT IDEMPOTENTE. Se puede correr las veces que haga falta.
-- Se corre CONECTADO A LA BASE "zym".
--
-- Hace falta cuando el 02 y el 03 se corrieron con el usuario
-- postgres: las tablas quedan con ese dueno y el usuario zym,
-- que es el que usa la app, no puede ni leerlas.
--
-- Da permisos sobre lo que ya existe y deja fijado que lo que
-- se cree mas adelante tambien quede accesible.
-- ============================================================

-- ── Acceso a la base y al esquema ───────────────────────────
GRANT CONNECT ON DATABASE zym TO zym;
GRANT USAGE, CREATE ON SCHEMA public TO zym;

-- ── Lo que ya existe ────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO zym;

GRANT USAGE, SELECT, UPDATE
    ON ALL SEQUENCES IN SCHEMA public TO zym;

GRANT EXECUTE
    ON ALL FUNCTIONS IN SCHEMA public TO zym;

-- ── Lo que se cree de aca en adelante ───────────────────────
-- Se fija para el usuario que corre este script, que es el que
-- crea los objetos.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zym;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO zym;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO zym;
