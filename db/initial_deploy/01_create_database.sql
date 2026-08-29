-- ============================================================
-- ZyM - 01_create_database.sql
-- Version para DBeaver (sin \gexec, que es solo de psql).
--
-- IMPORTANTE: este script se corre CONECTADO A LA BASE "postgres",
-- no a la base zym (todavia no existe).
-- Requiere un usuario con permiso de crear roles y bases.
-- Ejecutar con Auto-commit encendido.
--
-- El bloque del rol y el GRANT son IDEMPOTENTES.
-- El CREATE DATABASE no lo es: si la base ya existe, ese unico
-- renglon avisa "database zym already exists" y se puede seguir.
-- ============================================================

-- ── Rol de la aplicacion ────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zym') THEN
        CREATE ROLE zym LOGIN PASSWORD 'zym123';
    END IF;
END
$$;

-- ── Base de datos ───────────────────────────────────────────
-- CREATE DATABASE no se puede ejecutar dentro de un bloque DO
-- ni dentro de una transaccion, por eso va suelto.
CREATE DATABASE zym OWNER zym ENCODING 'UTF8';

-- ── Permisos ────────────────────────────────────────────────
GRANT ALL PRIVILEGES ON DATABASE zym TO zym;
