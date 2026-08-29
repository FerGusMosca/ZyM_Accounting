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
