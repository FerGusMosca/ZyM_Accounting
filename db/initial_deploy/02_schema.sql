-- ============================================================
-- ZyM - 02_schema.sql
-- SCRIPT IDEMPOTENTE. Se puede correr las veces que haga falta.
-- Se corre CONECTADO A LA BASE "zym".
-- ============================================================

-- ============================================================
-- GRUPOS DE CLIENTES
-- Nivel de arriba, con nombre libre y editable.
-- Hoy son administraciones de consorcios, manana puede ser
-- cualquier otra cosa.
-- ============================================================
CREATE TABLE IF NOT EXISTS client_groups (
    id          SERIAL       PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_groups_name
    ON client_groups (LOWER(name));


-- ============================================================
-- CLIENTES
-- Un cliente = un CUIT. El name es el nombre canonico:
-- si el LLM lee el nombre distinto en dos facturas del mismo
-- CUIT, en pantalla y en el Excel siempre se muestra este.
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
    id          SERIAL       PRIMARY KEY,
    cuit        VARCHAR(20)  NOT NULL,
    name        VARCHAR(300) NOT NULL,
    group_id    INT          NULL REFERENCES client_groups (id) ON DELETE SET NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_cuit ON clients (cuit);
CREATE INDEX        IF NOT EXISTS ix_clients_group ON clients (group_id);


-- ============================================================
-- NOMBRES ALTERNATIVOS DE CLIENTE
-- Cada variante que aparecio en un PDF, para poder rastrear
-- de donde salio y ofrecer cambiar el nombre canonico.
-- ============================================================
CREATE TABLE IF NOT EXISTS client_name_aliases (
    id          SERIAL       PRIMARY KEY,
    client_id   INT          NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    name        VARCHAR(300) NOT NULL,
    seen_count  INT          NOT NULL DEFAULT 1,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_name_aliases
    ON client_name_aliases (client_id, LOWER(name));


-- ============================================================
-- FACTURAS EMITIDAS
-- file_hash: huella del PDF, para detectar que se sube dos
-- veces el MISMO archivo.
-- (issuer_cuit, invoice_number): la misma factura aunque el
-- PDF sea otro archivo.
-- status: pending / paid
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
    id              SERIAL         PRIMARY KEY,
    client_id       INT            NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
    issuer_cuit     VARCHAR(20)    NOT NULL,
    invoice_number  VARCHAR(50)    NOT NULL,
    issue_date      DATE           NULL,
    amount          NUMERIC(18, 2) NOT NULL,
    currency        VARCHAR(10)    NOT NULL DEFAULT 'ARS',
    description     TEXT           NULL,
    status          VARCHAR(20)    NOT NULL DEFAULT 'pending',
    file_name       VARCHAR(400)   NULL,
    file_hash       CHAR(64)       NOT NULL,
    raw_json        JSONB          NULL,
    created_at      TIMESTAMP      NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_file_hash
    ON invoices (file_hash);

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_number
    ON invoices (issuer_cuit, invoice_number);

CREATE INDEX IF NOT EXISTS ix_invoices_client ON invoices (client_id);
CREATE INDEX IF NOT EXISTS ix_invoices_status ON invoices (status);


-- ============================================================
-- COBROS RECIBIDOS
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
    id              SERIAL         PRIMARY KEY,
    payer_cuit      VARCHAR(20)    NULL,
    payer_name      VARCHAR(300)   NULL,
    payment_date    DATE           NULL,
    amount          NUMERIC(18, 2) NOT NULL,
    currency        VARCHAR(10)    NOT NULL DEFAULT 'ARS',
    bank            VARCHAR(200)   NULL,
    reference       VARCHAR(200)   NULL,
    file_name       VARCHAR(400)   NULL,
    file_hash       CHAR(64)       NOT NULL,
    raw_json        JSONB          NULL,
    created_at      TIMESTAMP      NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_file_hash
    ON payments (file_hash);

CREATE INDEX IF NOT EXISTS ix_payments_cuit ON payments (payer_cuit);


-- ============================================================
-- CRUCES FACTURA <-> COBRO
-- Una factura puede recibir mas de un pago y un pago puede
-- cubrir mas de una factura, por eso la tabla es intermedia.
-- confidence: alta / media / revisar
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_payments (
    id           SERIAL         PRIMARY KEY,
    invoice_id   INT            NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    payment_id   INT            NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
    amount       NUMERIC(18, 2) NOT NULL,
    confidence   VARCHAR(20)    NOT NULL,
    confirmed_by VARCHAR(100)   NULL,
    created_at   TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_payments
    ON invoice_payments (invoice_id, payment_id);

CREATE INDEX IF NOT EXISTS ix_invoice_payments_invoice ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS ix_invoice_payments_payment ON invoice_payments (payment_id);


-- ============================================================
-- ARCHIVOS SUBIDOS
-- Guarda el archivo tal cual se subio (PDF de factura o de
-- comprobante de pago), para poder abrirlo despues desde la
-- pantalla de Registros.
-- La huella es la misma que ya llevan invoices y payments, asi
-- el mismo archivo no se guarda dos veces.
-- ============================================================
CREATE TABLE IF NOT EXISTS uploaded_files (
    file_hash   CHAR(64)     PRIMARY KEY,
    file_name   VARCHAR(400) NULL,
    mime_type   VARCHAR(120) NULL,
    byte_size   INT          NULL,
    content     BYTEA        NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_uploaded_files_created
    ON uploaded_files (created_at DESC);
