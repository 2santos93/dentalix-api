import { Prisma } from '@prisma/client';

/**
 * Búsquedas de pacientes por documento normalizado de la importación
 * (DX-107) y de la hoja de saldos (DX-262). Exportadas para que los tests
 * expliquen exactamente el SQL que ejecuta el repositorio.
 *
 * DX-287 (DB-047): todas comparan la columna `patients."docKey"` (la mantiene
 * el trigger patients_doc_key con `public.dx_doc_key`, la regla de
 * `docKey()`) con `= ANY(claves)`, y llevan el predicado del índice parcial
 * patients_tenant_doc_key_live_idx (`"deletedAt" IS NULL AND "docNumber" IS
 * NOT NULL`). `texteq` es LEAKPROOF, así que bajo RLS FORCE la comparación es
 * condición de índice; la expresión regular por fila recorría la clínica
 * entera en cada bloque.
 */

/** Pacientes vivos de la clínica con alguna de esas claves (dry-run). */
export function existingDocsSql(tenantId: string, keys: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "docType", "docKey",
           ("partially_suppressed_at" IS NOT NULL) AS "partiallySuppressed"
      FROM "patients"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "deletedAt" IS NULL
       AND "docNumber" IS NOT NULL
       AND "docKey" = ANY(${keys}::text[])`;
}

/** Cuántos pacientes vivos tiene cada clave (hoja de saldos: FOUND/AMBIGUOUS). */
export function knownDocsPatientsSql(
  tenantId: string,
  keys: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT "docKey", count(*)::int AS "n"
      FROM "patients"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "deletedAt" IS NULL
       AND "docNumber" IS NOT NULL
       AND "docKey" = ANY(${keys}::text[])
     GROUP BY "docKey"`;
}

/**
 * Claves de las filas PENDIENTES del archivo de pacientes del lote. El
 * documento va en el JSON de la fila (sin columna): misma regla que el
 * trigger con `public.dx_doc_key`. Solo recorre las filas del lote.
 */
export function knownDocsInFileSql(
  tenantId: string,
  batchId: string,
  keys: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT public.dx_doc_key("data"->>'docNumber') AS "docKey"
      FROM "patient_import_rows"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "batchId" = ${batchId}::uuid
       AND "outcome" = 'PENDING'
       AND "data" IS NOT NULL
       AND public.dx_doc_key("data"->>'docNumber') = ANY(${keys}::text[])`;
}

/**
 * Saldos migrados VIVOS de otros lotes de los pacientes con esas claves, del
 * más antiguo al más reciente, con el día civil de la importación en
 * `timeZone`.
 */
export function existingBalancesByDocSql(
  tenantId: string,
  batchId: string,
  keys: string[],
  timeZone: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT p."docKey",
           o."currency",
           (o."amount" * 100)::bigint::float8 AS "cents",
           o."asOfDate",
           b."fileName",
           to_char(timezone(${timeZone}, o."createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "importedOn"
      FROM "opening_balances" o
      JOIN "patients" p
        ON p."tenantId" = o."tenantId" AND p."id" = o."patientId"
      JOIN "patient_import_batches" b
        ON b."tenantId" = o."tenantId" AND b."id" = o."importBatchId"
     WHERE o."tenantId" = ${tenantId}::uuid
       AND o."voidedAt" IS NULL
       AND o."importBatchId" <> ${batchId}::uuid
       AND p."deletedAt" IS NULL
       AND p."docNumber" IS NOT NULL
       AND p."docKey" = ANY(${keys}::text[])
     ORDER BY o."createdAt", o."id"`;
}

/**
 * Paciente de cada clave al importar un bloque de saldos: el menor id y
 * cuántos vivos hay (con más de uno no se adivina: ambiguo).
 */
export function balancePatientsByDocSql(
  tenantId: string,
  keys: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT min("id"::text)::uuid AS "id", "docKey", count(*)::int AS "n"
      FROM "patients"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "deletedAt" IS NULL
       AND "docNumber" IS NOT NULL
       AND "docKey" = ANY(${keys}::text[])
     GROUP BY "docKey"`;
}

/**
 * Pacientes que YA existen con las claves de un bloque de importación, con
 * lo que «actualizar vacíos» puede rellenar, bloqueados en orden de id
 * (rellenar no compite con una edición a la vez y no hay interbloqueos).
 */
export function patientsToFillByDocSql(
  tenantId: string,
  keys: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "docType", "birthDate", "sex", "phone", "email", "address",
           "occupation", "emergencyContactName", "emergencyContactPhone", "notes",
           "partially_suppressed_at" AS "partiallySuppressedAt",
           "docKey"
      FROM "patients"
     WHERE "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL AND "docNumber" IS NOT NULL
       AND "docKey" = ANY(${keys}::text[])
     ORDER BY "id"
     FOR UPDATE`;
}
