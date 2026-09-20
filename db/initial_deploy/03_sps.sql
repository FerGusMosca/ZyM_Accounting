-- ============================================================
-- ZyM - 03_sps.sql
-- SCRIPT IDEMPOTENTE. Se puede correr las veces que haga falta.
-- Se corre CONECTADO A LA BASE "zym".
-- Cada funcion se borra y se vuelve a crear.
-- ============================================================


-- ============================================================
-- upsert_client
-- Busca el cliente por CUIT. Si no existe lo crea.
-- El nombre que llega se guarda siempre como alias; el nombre
-- canonico solo se pisa si el cliente todavia no tenia uno.
-- ============================================================
DROP FUNCTION IF EXISTS upsert_client(VARCHAR, VARCHAR);

CREATE FUNCTION upsert_client(
    p_cuit VARCHAR,
    p_name VARCHAR
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_client_id INT;
BEGIN
    SELECT id INTO v_client_id FROM clients WHERE cuit = p_cuit;

    IF v_client_id IS NULL THEN
        INSERT INTO clients (cuit, name)
        VALUES (p_cuit, COALESCE(p_name, p_cuit))
        RETURNING id INTO v_client_id;
    END IF;

    IF p_name IS NOT NULL AND LENGTH(TRIM(p_name)) > 0 THEN
        INSERT INTO client_name_aliases (client_id, name)
        VALUES (v_client_id, p_name)
        ON CONFLICT (client_id, LOWER(name))
        DO UPDATE SET seen_count = client_name_aliases.seen_count + 1;
    END IF;

    RETURN v_client_id;
END;
$$;


-- ============================================================
-- find_invoice_by_hash
-- Devuelve la factura ya cargada que corresponde a ese PDF.
-- ============================================================
DROP FUNCTION IF EXISTS find_invoice_by_hash(CHAR);

CREATE FUNCTION find_invoice_by_hash(p_file_hash CHAR)
RETURNS TABLE (
    id              INT,
    client_id       INT,
    client_name     VARCHAR,
    client_cuit     VARCHAR,
    invoice_number  VARCHAR,
    issue_date      DATE,
    amount          NUMERIC,
    status          VARCHAR,
    file_name       VARCHAR
)
LANGUAGE sql
AS $$
    SELECT  i.id,
            i.client_id,
            c.name,
            c.cuit,
            i.invoice_number,
            i.issue_date,
            i.amount,
            i.status,
            i.file_name
    FROM invoices i
    JOIN clients  c ON c.id = i.client_id
    WHERE i.file_hash = p_file_hash;
$$;


-- ============================================================
-- find_invoice_by_number
-- Misma factura aunque el archivo PDF sea otro.
-- ============================================================
DROP FUNCTION IF EXISTS find_invoice_by_number(VARCHAR, VARCHAR);

CREATE FUNCTION find_invoice_by_number(
    p_issuer_cuit    VARCHAR,
    p_invoice_number VARCHAR
)
RETURNS TABLE (
    id              INT,
    client_id       INT,
    client_name     VARCHAR,
    client_cuit     VARCHAR,
    invoice_number  VARCHAR,
    issue_date      DATE,
    amount          NUMERIC,
    status          VARCHAR,
    file_name       VARCHAR
)
LANGUAGE sql
AS $$
    SELECT  i.id,
            i.client_id,
            c.name,
            c.cuit,
            i.invoice_number,
            i.issue_date,
            i.amount,
            i.status,
            i.file_name
    FROM invoices i
    JOIN clients  c ON c.id = i.client_id
    WHERE i.issuer_cuit    = p_issuer_cuit
      AND i.invoice_number = p_invoice_number;
$$;


-- ============================================================
-- persist_invoice
-- Guarda la factura. Si el PDF ya estaba cargado, o si ya
-- existe esa numeracion, no duplica: devuelve el id existente.
-- ============================================================
DROP FUNCTION IF EXISTS persist_invoice(VARCHAR, VARCHAR, VARCHAR, VARCHAR, DATE, NUMERIC, TEXT, VARCHAR, CHAR, JSONB);

CREATE FUNCTION persist_invoice(
    p_client_cuit    VARCHAR,
    p_client_name    VARCHAR,
    p_issuer_cuit    VARCHAR,
    p_invoice_number VARCHAR,
    p_issue_date     DATE,
    p_amount         NUMERIC,
    p_description    TEXT,
    p_file_name      VARCHAR,
    p_file_hash      CHAR,
    p_raw_json       JSONB
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_client_id  INT;
    v_invoice_id INT;
BEGIN
    SELECT id INTO v_invoice_id FROM invoices WHERE file_hash = p_file_hash;
    IF v_invoice_id IS NOT NULL THEN
        RETURN v_invoice_id;
    END IF;

    SELECT id INTO v_invoice_id
    FROM invoices
    WHERE issuer_cuit = p_issuer_cuit AND invoice_number = p_invoice_number;
    IF v_invoice_id IS NOT NULL THEN
        RETURN v_invoice_id;
    END IF;

    v_client_id := upsert_client(p_client_cuit, p_client_name);

    INSERT INTO invoices (
        client_id, issuer_cuit, invoice_number, issue_date,
        amount, description, file_name, file_hash, raw_json
    )
    VALUES (
        v_client_id, p_issuer_cuit, p_invoice_number, p_issue_date,
        p_amount, p_description, p_file_name, p_file_hash, p_raw_json
    )
    RETURNING id INTO v_invoice_id;

    RETURN v_invoice_id;
END;
$$;


-- ============================================================
-- persist_payment
-- Mismo criterio: si el PDF ya estaba cargado, no duplica.
-- ============================================================
DROP FUNCTION IF EXISTS persist_payment(VARCHAR, VARCHAR, DATE, NUMERIC, VARCHAR, VARCHAR, VARCHAR, CHAR, JSONB);

CREATE FUNCTION persist_payment(
    p_payer_cuit   VARCHAR,
    p_payer_name   VARCHAR,
    p_payment_date DATE,
    p_amount       NUMERIC,
    p_bank         VARCHAR,
    p_reference    VARCHAR,
    p_file_name    VARCHAR,
    p_file_hash    CHAR,
    p_raw_json     JSONB
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_payment_id INT;
BEGIN
    SELECT id INTO v_payment_id FROM payments WHERE file_hash = p_file_hash;
    IF v_payment_id IS NOT NULL THEN
        RETURN v_payment_id;
    END IF;

    INSERT INTO payments (
        payer_cuit, payer_name, payment_date, amount,
        bank, reference, file_name, file_hash, raw_json
    )
    VALUES (
        p_payer_cuit, p_payer_name, p_payment_date, p_amount,
        p_bank, p_reference, p_file_name, p_file_hash, p_raw_json
    )
    RETURNING id INTO v_payment_id;

    RETURN v_payment_id;
END;
$$;


-- ============================================================
-- persist_match
-- Guarda el cruce factura <-> cobro y deja la factura en paid
-- cuando lo imputado cubre el importe.
-- ============================================================
DROP FUNCTION IF EXISTS persist_match(INT, INT, NUMERIC, VARCHAR, VARCHAR);

CREATE FUNCTION persist_match(
    p_invoice_id   INT,
    p_payment_id   INT,
    p_amount       NUMERIC,
    p_confidence   VARCHAR,
    p_confirmed_by VARCHAR
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_match_id   INT;
    v_total_paid NUMERIC;
    v_amount     NUMERIC;
BEGIN
    INSERT INTO invoice_payments (invoice_id, payment_id, amount, confidence, confirmed_by)
    VALUES (p_invoice_id, p_payment_id, p_amount, p_confidence, p_confirmed_by)
    ON CONFLICT (invoice_id, payment_id)
    DO UPDATE SET amount     = EXCLUDED.amount,
                  confidence = EXCLUDED.confidence
    RETURNING id INTO v_match_id;

    SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
    FROM invoice_payments WHERE invoice_id = p_invoice_id;

    SELECT amount INTO v_amount FROM invoices WHERE id = p_invoice_id;

    UPDATE invoices
    SET status     = CASE WHEN v_total_paid >= v_amount THEN 'paid' ELSE 'pending' END,
        updated_at = NOW()
    WHERE id = p_invoice_id;

    RETURN v_match_id;
END;
$$;


-- ============================================================
-- get_client_account
-- Cuenta corriente por cliente, con el grupo al que pertenece.
-- La pantalla usa group_name para armar las agrupaciones y el
-- subtotal por grupo.
-- ============================================================
DROP FUNCTION IF EXISTS get_client_account();

CREATE FUNCTION get_client_account()
RETURNS TABLE (
    client_id     INT,
    client_cuit   VARCHAR,
    client_name   VARCHAR,
    group_id      INT,
    group_name    VARCHAR,
    invoice_count BIGINT,
    invoiced      NUMERIC,
    payment_count BIGINT,
    collected     NUMERIC,
    balance       NUMERIC
)
LANGUAGE sql
AS $$
    SELECT  c.id,
            c.cuit,
            c.name,
            g.id,
            g.name,
            COUNT(DISTINCT i.id),
            COALESCE(SUM(i.amount), 0),
            COUNT(DISTINCT ip.payment_id),
            COALESCE((
                SELECT SUM(ip2.amount)
                FROM invoice_payments ip2
                JOIN invoices i2 ON i2.id = ip2.invoice_id
                WHERE i2.client_id = c.id
            ), 0),
            COALESCE(SUM(i.amount), 0) - COALESCE((
                SELECT SUM(ip3.amount)
                FROM invoice_payments ip3
                JOIN invoices i3 ON i3.id = ip3.invoice_id
                WHERE i3.client_id = c.id
            ), 0)
    FROM clients c
    LEFT JOIN client_groups   g  ON g.id  = c.group_id
    LEFT JOIN invoices        i  ON i.client_id  = c.id
    LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
    GROUP BY c.id, c.cuit, c.name, g.id, g.name
    ORDER BY g.name NULLS LAST, c.name;
$$;


-- ============================================================
-- upsert_client_group / assign_client_to_group
-- Alta y edicion del nombre del grupo, y asignacion de clientes.
-- ============================================================
DROP FUNCTION IF EXISTS upsert_client_group(INT, VARCHAR);

CREATE FUNCTION upsert_client_group(
    p_group_id INT,
    p_name     VARCHAR
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_group_id INT;
BEGIN
    IF p_group_id IS NULL THEN
        SELECT id INTO v_group_id FROM client_groups WHERE LOWER(name) = LOWER(p_name);
        IF v_group_id IS NULL THEN
            INSERT INTO client_groups (name) VALUES (p_name) RETURNING id INTO v_group_id;
        END IF;
    ELSE
        UPDATE client_groups
        SET name = p_name, updated_at = NOW()
        WHERE id = p_group_id
        RETURNING id INTO v_group_id;
    END IF;

    RETURN v_group_id;
END;
$$;


DROP FUNCTION IF EXISTS assign_client_to_group(INT, INT);

CREATE FUNCTION assign_client_to_group(
    p_client_id INT,
    p_group_id  INT
)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE clients
    SET group_id = p_group_id, updated_at = NOW()
    WHERE id = p_client_id;
$$;


-- ============================================================
-- set_client_name
-- Fija el nombre canonico del cliente. Es lo que resuelve que
-- el mismo CUIT salga con dos nombres distintos en el Excel.
-- ============================================================
DROP FUNCTION IF EXISTS set_client_name(INT, VARCHAR);

CREATE FUNCTION set_client_name(
    p_client_id INT,
    p_name      VARCHAR
)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE clients
    SET name = p_name, updated_at = NOW()
    WHERE id = p_client_id;
$$;


-- ============================================================
-- save_uploaded_file
-- Guarda el archivo tal cual se subio. Si ese mismo archivo ya
-- estaba guardado, no hace nada y no falla.
-- ============================================================
DROP FUNCTION IF EXISTS save_uploaded_file(CHAR, VARCHAR, VARCHAR, BYTEA);

CREATE FUNCTION save_uploaded_file(
    p_file_hash CHAR,
    p_file_name VARCHAR,
    p_mime_type VARCHAR,
    p_content   BYTEA
)
RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO uploaded_files (file_hash, file_name, mime_type, byte_size, content)
    VALUES (p_file_hash, p_file_name, p_mime_type, LENGTH(p_content), p_content)
    ON CONFLICT (file_hash) DO NOTHING;
$$;


-- ============================================================
-- get_uploaded_file
-- Devuelve el archivo guardado para poder abrirlo en pantalla.
-- ============================================================
DROP FUNCTION IF EXISTS get_uploaded_file(CHAR);

CREATE FUNCTION get_uploaded_file(p_file_hash CHAR)
RETURNS TABLE (
    file_name VARCHAR,
    mime_type VARCHAR,
    content   BYTEA
)
LANGUAGE sql
AS $$
    SELECT f.file_name, f.mime_type, f.content
    FROM uploaded_files f
    WHERE f.file_hash = p_file_hash;
$$;


-- ============================================================
-- list_invoices
-- Todas las facturas guardadas, con cuanto se le imputo y si
-- el archivo original quedo guardado.
-- ============================================================
DROP FUNCTION IF EXISTS list_invoices();

CREATE FUNCTION list_invoices()
RETURNS TABLE (
    id             INT,
    client_name    VARCHAR,
    client_cuit    VARCHAR,
    invoice_number VARCHAR,
    issue_date     DATE,
    amount         NUMERIC,
    paid_amount    NUMERIC,
    status         VARCHAR,
    description    TEXT,
    file_name      VARCHAR,
    file_hash      CHAR,
    has_file       BOOLEAN,
    created_at     TIMESTAMP
)
LANGUAGE sql
AS $$
    SELECT  i.id,
            c.name,
            c.cuit,
            i.invoice_number,
            i.issue_date,
            i.amount,
            COALESCE((SELECT SUM(ip.amount)
                      FROM invoice_payments ip
                      WHERE ip.invoice_id = i.id), 0),
            i.status,
            i.description,
            i.file_name,
            i.file_hash,
            EXISTS (SELECT 1 FROM uploaded_files f WHERE f.file_hash = i.file_hash),
            i.created_at
    FROM invoices i
    JOIN clients  c ON c.id = i.client_id
    ORDER BY i.issue_date DESC NULLS LAST, i.id DESC;
$$;


-- ============================================================
-- list_payments
-- Todos los cobros guardados, con cuanto quedo imputado.
-- ============================================================
DROP FUNCTION IF EXISTS list_payments();

CREATE FUNCTION list_payments()
RETURNS TABLE (
    id             INT,
    payer_name     VARCHAR,
    payer_cuit     VARCHAR,
    payment_date   DATE,
    amount         NUMERIC,
    applied_amount NUMERIC,
    bank           VARCHAR,
    reference      VARCHAR,
    file_name      VARCHAR,
    file_hash      CHAR,
    has_file       BOOLEAN,
    created_at     TIMESTAMP
)
LANGUAGE sql
AS $$
    SELECT  p.id,
            p.payer_name,
            p.payer_cuit,
            p.payment_date,
            p.amount,
            COALESCE((SELECT SUM(ip.amount)
                      FROM invoice_payments ip
                      WHERE ip.payment_id = p.id), 0),
            p.bank,
            p.reference,
            p.file_name,
            p.file_hash,
            EXISTS (SELECT 1 FROM uploaded_files f WHERE f.file_hash = p.file_hash),
            p.created_at
    FROM payments p
    ORDER BY p.payment_date DESC NULLS LAST, p.id DESC;
$$;


-- ============================================================
-- list_matches
-- Los cruces guardados, con los datos de las dos puntas.
-- ============================================================
DROP FUNCTION IF EXISTS list_matches();

CREATE FUNCTION list_matches()
RETURNS TABLE (
    id             INT,
    invoice_id     INT,
    invoice_number VARCHAR,
    client_name    VARCHAR,
    issue_date     DATE,
    invoice_amount NUMERIC,
    payment_id     INT,
    payment_date   DATE,
    bank           VARCHAR,
    payer_name     VARCHAR,
    amount         NUMERIC,
    confidence     VARCHAR,
    created_at     TIMESTAMP
)
LANGUAGE sql
AS $$
    SELECT  ip.id,
            i.id,
            i.invoice_number,
            c.name,
            i.issue_date,
            i.amount,
            p.id,
            p.payment_date,
            p.bank,
            p.payer_name,
            ip.amount,
            ip.confidence,
            ip.created_at
    FROM invoice_payments ip
    JOIN invoices i ON i.id = ip.invoice_id
    JOIN clients  c ON c.id = i.client_id
    JOIN payments p ON p.id = ip.payment_id
    ORDER BY ip.created_at DESC, ip.id DESC;
$$;


-- ============================================================
-- persist_manual_payment
-- Alta de un cobro cargado a mano, sin comprobante.
-- La huella se arma con los propios datos del cobro, asi el
-- mismo cobro cargado dos veces no se duplica.
-- ============================================================
DROP FUNCTION IF EXISTS persist_manual_payment(VARCHAR, VARCHAR, DATE, NUMERIC, VARCHAR, VARCHAR);

CREATE FUNCTION persist_manual_payment(
    p_payer_cuit   VARCHAR,
    p_payer_name   VARCHAR,
    p_payment_date DATE,
    p_amount       NUMERIC,
    p_bank         VARCHAR,
    p_reference    VARCHAR
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_hash       CHAR(64);
    v_payment_id INT;
BEGIN
    v_hash := ENCODE(SHA256(CONVERT_TO(
        'manual|' || COALESCE(p_payer_cuit, '') || '|' ||
        COALESCE(LOWER(TRIM(p_payer_name)), '') || '|' ||
        COALESCE(p_payment_date::TEXT, '') || '|' ||
        COALESCE(p_amount::TEXT, '') || '|' ||
        COALESCE(LOWER(TRIM(p_bank)), '') || '|' ||
        COALESCE(LOWER(TRIM(p_reference)), ''), 'UTF8')), 'hex');

    SELECT id INTO v_payment_id FROM payments WHERE file_hash = v_hash;
    IF v_payment_id IS NOT NULL THEN
        RETURN v_payment_id;
    END IF;

    INSERT INTO payments (
        payer_cuit, payer_name, payment_date, amount,
        bank, reference, file_name, file_hash, raw_json
    )
    VALUES (
        p_payer_cuit, p_payer_name, p_payment_date, p_amount,
        p_bank, p_reference, NULL, v_hash,
        JSONB_BUILD_OBJECT('origen', 'manual')
    )
    RETURNING id INTO v_payment_id;

    RETURN v_payment_id;
END;
$$;


-- ============================================================
-- delete_payment
-- Baja de un cobro. Los cruces que tenia se borran solos y las
-- facturas que quedaban cubiertas por ese cobro vuelven a
-- quedar pendientes.
-- ============================================================
DROP FUNCTION IF EXISTS delete_payment(INT);

CREATE FUNCTION delete_payment(p_payment_id INT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_invoice_ids INT[];
BEGIN
    SELECT ARRAY_AGG(DISTINCT invoice_id) INTO v_invoice_ids
    FROM invoice_payments WHERE payment_id = p_payment_id;

    DELETE FROM payments WHERE id = p_payment_id;

    PERFORM refresh_invoice_status(v_invoice_ids);
END;
$$;


-- ============================================================
-- refresh_invoice_status
-- Deja cada factura en pagada o pendiente segun lo que tenga
-- imputado en ese momento.
-- ============================================================
DROP FUNCTION IF EXISTS refresh_invoice_status(INT[]);

CREATE FUNCTION refresh_invoice_status(p_invoice_ids INT[])
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE invoices i
    SET status = CASE
            WHEN COALESCE((SELECT SUM(ip.amount)
                           FROM invoice_payments ip
                           WHERE ip.invoice_id = i.id), 0) >= i.amount
            THEN 'paid' ELSE 'pending' END,
        updated_at = NOW()
    WHERE p_invoice_ids IS NOT NULL
      AND i.id = ANY (p_invoice_ids);
$$;


-- ============================================================
-- list_clients
-- Clientes con su nombre actual, para poder corregirlo desde
-- la pantalla.
-- ============================================================
DROP FUNCTION IF EXISTS list_clients();

CREATE FUNCTION list_clients()
RETURNS TABLE (
    id            INT,
    cuit          VARCHAR,
    name          VARCHAR,
    group_name    VARCHAR,
    invoice_count BIGINT,
    invoiced      NUMERIC
)
LANGUAGE sql
AS $$
    SELECT  c.id,
            c.cuit,
            c.name,
            g.name,
            COUNT(i.id),
            COALESCE(SUM(i.amount), 0)
    FROM clients c
    LEFT JOIN client_groups g ON g.id = c.group_id
    LEFT JOIN invoices      i ON i.client_id = c.id
    GROUP BY c.id, c.cuit, c.name, g.name
    ORDER BY c.name;
$$;


-- ============================================================
-- reset_cobranzas
-- Deja la base limpia: borra facturas, cobros, cruces y los
-- archivos guardados. Los clientes y los grupos se borran solo
-- si se pide expresamente.
-- ============================================================
DROP FUNCTION IF EXISTS reset_cobranzas(BOOLEAN);

CREATE FUNCTION reset_cobranzas(p_incluir_clientes BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_facturas INT;
    v_cobros   INT;
BEGIN
    SELECT COUNT(*) INTO v_facturas FROM invoices;
    SELECT COUNT(*) INTO v_cobros   FROM payments;

    DELETE FROM invoice_payments;
    DELETE FROM invoices;
    DELETE FROM payments;
    DELETE FROM uploaded_files;

    IF p_incluir_clientes THEN
        DELETE FROM client_name_aliases;
        DELETE FROM clients;
        DELETE FROM client_groups;
    END IF;

    RETURN 'Se borraron ' || v_facturas || ' factura(s) y ' || v_cobros || ' cobro(s).';
END;
$$;


-- ============================================================
-- delete_match
-- Saca UN cruce puntual, el que se elige en pantalla. Es la
-- unica forma de deshacer una imputacion: guardar nunca borra.
-- ============================================================
DROP FUNCTION IF EXISTS delete_match(INT);

CREATE FUNCTION delete_match(p_match_id INT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_invoice_id INT;
BEGIN
    SELECT invoice_id INTO v_invoice_id
    FROM invoice_payments WHERE id = p_match_id;

    DELETE FROM invoice_payments WHERE id = p_match_id;

    PERFORM refresh_invoice_status(ARRAY[v_invoice_id]);
END;
$$;


-- ============================================================
-- set_payment_file
-- Le engancha el comprobante a un cobro que se habia cargado a
-- mano. No pisa nada mas del cobro.
-- ============================================================
DROP FUNCTION IF EXISTS set_payment_file(INT, CHAR, VARCHAR);

CREATE FUNCTION set_payment_file(
    p_payment_id INT,
    p_file_hash  CHAR,
    p_file_name  VARCHAR
)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE payments
    SET file_hash  = p_file_hash,
        file_name  = p_file_name,
        updated_at = NOW()
    WHERE id = p_payment_id;
$$;


-- ============================================================
-- get_invoices_between / get_payments_between
-- Traen lo YA GUARDADO en un rango de fechas, para poder
-- llevarlo a la pantalla de Conciliacion y cruzarlo contra lo
-- que se esta subiendo ahora.
-- ============================================================
DROP FUNCTION IF EXISTS get_invoices_between(DATE, DATE);

CREATE FUNCTION get_invoices_between(
    p_desde DATE,
    p_hasta DATE
)
RETURNS TABLE (
    id             INT,
    client_id      INT,
    client_name    VARCHAR,
    client_cuit    VARCHAR,
    issuer_cuit    VARCHAR,
    invoice_number VARCHAR,
    issue_date     DATE,
    amount         NUMERIC,
    status         VARCHAR,
    description    TEXT,
    file_name      VARCHAR,
    file_hash      CHAR
)
LANGUAGE sql
AS $$
    SELECT  i.id, i.client_id, c.name, c.cuit, i.issuer_cuit,
            i.invoice_number, i.issue_date, i.amount, i.status,
            i.description, i.file_name, i.file_hash
    FROM invoices i
    JOIN clients  c ON c.id = i.client_id
    WHERE (p_desde IS NULL OR i.issue_date >= p_desde)
      AND (p_hasta IS NULL OR i.issue_date <= p_hasta)
    ORDER BY i.issue_date, i.id;
$$;


DROP FUNCTION IF EXISTS get_payments_between(DATE, DATE);

CREATE FUNCTION get_payments_between(
    p_desde DATE,
    p_hasta DATE
)
RETURNS TABLE (
    id           INT,
    payer_cuit   VARCHAR,
    payer_name   VARCHAR,
    payment_date DATE,
    amount       NUMERIC,
    bank         VARCHAR,
    reference    VARCHAR,
    file_name    VARCHAR,
    file_hash    CHAR
)
LANGUAGE sql
AS $$
    SELECT  p.id, p.payer_cuit, p.payer_name, p.payment_date, p.amount,
            p.bank, p.reference, p.file_name, p.file_hash
    FROM payments p
    WHERE (p_desde IS NULL OR p.payment_date >= p_desde)
      AND (p_hasta IS NULL OR p.payment_date <= p_hasta)
    ORDER BY p.payment_date, p.id;
$$;


-- ============================================================
-- clear_matches QUEDA ELIMINADA A PROPOSITO.
-- Borraba de una todos los cruces de las facturas y los cobros
-- que estuvieran en pantalla. Ninguna funcion del sistema puede
-- volver a borrar cruces en tanda: se borra de a uno, desde la
-- pantalla, con delete_match.
-- ============================================================
DROP FUNCTION IF EXISTS clear_matches(INT[], INT[]);


-- ============================================================
-- get_saved_matches
-- Los cruces YA GUARDADOS de las facturas y los cobros que estan
-- en la pantalla de Conciliacion. Se buscan por la huella del
-- archivo, que es lo que identifica a cada uno en pantalla.
-- Trae los datos de las dos puntas, porque una de ellas puede no
-- estar en pantalla (por ejemplo, un cobro de otra fecha).
-- Solo lee: no cambia nada.
-- ============================================================
DROP FUNCTION IF EXISTS get_saved_matches(TEXT[], TEXT[]);

CREATE FUNCTION get_saved_matches(
    p_invoice_hashes TEXT[],
    p_payment_hashes TEXT[]
)
RETURNS TABLE (
    id             INT,
    amount         NUMERIC,
    confidence     VARCHAR,
    invoice_hash   TEXT,
    invoice_number VARCHAR,
    client_name    VARCHAR,
    client_cuit    VARCHAR,
    issue_date     DATE,
    invoice_amount NUMERIC,
    description    TEXT,
    payment_hash   TEXT,
    payer_name     VARCHAR,
    payer_cuit     VARCHAR,
    payment_date   DATE,
    payment_amount NUMERIC,
    bank           VARCHAR,
    reference      VARCHAR
)
LANGUAGE sql
AS $$
    SELECT  ip.id,
            ip.amount,
            ip.confidence,
            TRIM(i.file_hash),
            i.invoice_number,
            c.name,
            c.cuit,
            i.issue_date,
            i.amount,
            i.description,
            TRIM(p.file_hash),
            p.payer_name,
            p.payer_cuit,
            p.payment_date,
            p.amount,
            p.bank,
            p.reference
    FROM invoice_payments ip
    JOIN invoices i ON i.id = ip.invoice_id
    JOIN clients  c ON c.id = i.client_id
    JOIN payments p ON p.id = ip.payment_id
    WHERE TRIM(i.file_hash) = ANY (COALESCE(p_invoice_hashes, ARRAY[]::TEXT[]))
       OR TRIM(p.file_hash) = ANY (COALESCE(p_payment_hashes, ARRAY[]::TEXT[]))
    ORDER BY ip.id;
$$;
