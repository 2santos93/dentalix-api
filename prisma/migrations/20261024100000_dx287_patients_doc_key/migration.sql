-- DX-287 (DB-047): clave normalizada del documento, indexable también bajo RLS.
--
-- Por qué: el alta y la edición manual de un paciente y la importación
-- (DX-107/DX-262) buscan el documento con
-- regexp_replace(upper("docNumber"), '[^0-9A-Z]', '', 'g') = … y ni
-- regexp_replace ni upper son LEAKPROOF: bajo RLS FORCE la condición queda en
-- Filter y se recorre toda la clínica (96–130 ms por alta con 60k pacientes,
-- ~400 ms por bloque de 250 filas importadas), con el candado del documento
-- tomado. Un índice de expresión no lo arregla por lo mismo; una COLUMNA
-- comparada con `=` (texteq, LEAKPROOF) sí es condición de índice.
--
-- Cambios (solo esquema; el relleno, el índice y las estadísticas van en
-- ficheros propios, patrón de DX-225):
--   dx_doc_key(text)     la regla de docKey() (src/modules/patients/domain/
--                        doc-key.ts): quita todo lo que no sea [0-9A-Za-z] y
--                        pasa a mayúsculas solo A-Z con translate(). No usa
--                        upper(): no depende de la locale ni del proveedor de
--                        collation de la base (con glibc, upper('ı') = 'I'; con
--                        tr_TR, upper('i') = 'İ'), así que es IMMUTABLE de
--                        verdad y da lo mismo que JS para CUALQUIER texto.
--                        NULL → NULL; '' o solo puntuación → ''.
--   patients."docKey"    la mantiene el trigger patients_doc_key (BEFORE
--                        INSERT OR UPDATE OF "docNumber","docKey"): la calcula
--                        siempre la BD; un valor escrito a mano se sobrescribe.
--                        Deriva del documento: mismo dato, misma tabla, misma
--                        RLS; no se registra en logs.
--
-- Por qué trigger y no GENERATED ALWAYS … STORED: añadir una columna generada
-- almacenada REESCRIBE patients bajo ACCESS EXCLUSIVE (con sus 8 índices,
-- entre ellos el GIN trigram de la búsqueda): bloquea hasta las lecturas
-- durante un tiempo que crece con la tabla (medido en DX-287: ver su
-- informe). Una columna sin DEFAULT solo toca el catálogo, y el relleno por
-- lotes con COMMIT no retiene más que bloqueos de fila (DB-029, DB-048).
--
-- Bloqueo: ADD COLUMN sin DEFAULT y CREATE TRIGGER toman ACCESS EXCLUSIVE /
-- SHARE ROW EXCLUSIVE solo un instante; lock_timeout evita quedar encolado
-- detrás de una transacción larga y bloquear a los demás detrás.
--
-- Compatible hacia atrás: el código anterior no lee ni escribe la columna y
-- sus consultas con la expresión siguen funcionando igual; sus INSERT/UPDATE
-- del documento reciben "docKey" del trigger. Las filas existentes quedan
-- con NULL hasta el relleno (20261024100100).

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public."dx_doc_key"(doc text) RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT pg_catalog.translate(
    pg_catalog.regexp_replace(doc, '[^0-9A-Za-z]', '', 'g'),
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
$$;

ALTER TABLE "patients" ADD COLUMN "docKey" TEXT;

CREATE FUNCTION public."dx_patients_doc_key"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."docKey" := public.dx_doc_key(NEW."docNumber");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patients_doc_key"
  BEFORE INSERT OR UPDATE OF "docNumber", "docKey" ON "patients"
  FOR EACH ROW EXECUTE FUNCTION public."dx_patients_doc_key"();
