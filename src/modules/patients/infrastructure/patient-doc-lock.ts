import { Prisma } from '@prisma/client';
import { docKey } from '../domain/doc-key';

/**
 * Candado por (clínica, documento normalizado) para el alta de pacientes
 * (DX-107). El índice único `patients_tenant_doc_key` compara el texto tal
 * cual: «1.111.111» y «1111111» no chocan ahí. Quien da de alta (a mano o la
 * importación) toma antes este candado de transacción y busca por la clave
 * normalizada (columna "docKey", DX-287): dos altas del mismo documento con
 * distinto formato se serializan y la segunda ve a la primera. El índice de
 * "docKey" no es único porque hay duplicados ambiguos anteriores a DX-107.
 */
export function patientDocLockKey(tenantId: string, key: string): string {
  return `patient-doc:${tenantId}:${key}`;
}

/** Toma los candados de esos documentos, en orden (sin interbloqueos). */
export async function lockPatientDocs(
  tx: Prisma.TransactionClient,
  tenantId: string,
  docNumbers: readonly string[],
): Promise<void> {
  const keys = [...new Set(docNumbers.map(docKey).filter((k) => k !== ''))]
    .sort()
    .map((k) => patientDocLockKey(tenantId, k));
  if (keys.length === 0) return;
  // El subselect ordenado fija el orden en que se toman.
  await tx.$queryRaw`
    SELECT count(*)::int AS n FROM (
      SELECT pg_advisory_xact_lock(hashtextextended(s.k, 0))
        FROM (SELECT k FROM unnest(${keys}::text[]) AS u(k) ORDER BY k) s
    ) locked`;
}

/**
 * SQL de `livePatientWithDoc` (exportado para explicarlo en los tests).
 * Compara la columna "docKey" (texteq, LEAKPROOF) con el predicado del índice
 * parcial patients_tenant_doc_key_live_idx: bajo RLS FORCE es un Index Scan
 * de ese índice, no un recorrido de toda la clínica (DX-287, DB-047).
 */
export function livePatientWithDocSql(
  tenantId: string,
  key: string,
  exceptId?: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "patients"
     WHERE "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL
       AND "docNumber" IS NOT NULL
       AND "docKey" = ${key}
       AND (${exceptId ?? null}::uuid IS NULL OR "id" <> ${exceptId ?? null}::uuid)
     LIMIT 1`;
}

/**
 * Otro paciente vivo de la clínica con el mismo documento normalizado (sin
 * contar `exceptId`), o null. Llamar con el candado tomado.
 */
export async function livePatientWithDoc(
  tx: Prisma.TransactionClient,
  tenantId: string,
  docNumber: string,
  exceptId?: string,
): Promise<string | null> {
  const key = docKey(docNumber);
  if (key === '') return null;
  const rows = await tx.$queryRaw<{ id: string }[]>(
    livePatientWithDocSql(tenantId, key, exceptId),
  );
  return rows[0]?.id ?? null;
}
