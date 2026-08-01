import { Prisma } from '@prisma/client';

/**
 * Sede por defecto del tenant en contexto: la primera sede activa.
 *
 * ANDAMIO DE LA FASE 1 (docs/plans/2026-08-01-multi-sede.md). Hoy cada clínica
 * tiene exactamente una sede ("Sede principal", creada por la migración), así
 * que resolver "la sede" aquí deja el comportamiento EXACTAMENTE igual que
 * antes de existir el concepto. En la FASE 2 la sede pasa a venir del request
 * (cabecera `X-Location-Id`, validada contra el tenant) y estas llamadas se
 * sustituyen por ese valor; entonces esta función desaparece.
 *
 * Corre dentro de la transacción tenant-scoped (`runWithTenant`), así que el
 * RLS ya garantiza que solo puede devolver una sede del tenant en contexto.
 */
export async function resolveDefaultLocationId(
  tx: Prisma.TransactionClient,
): Promise<string> {
  const location = await tx.location.findFirst({
    where: { deletedAt: null, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!location) {
    // No debería ocurrir: la migración crea una sede por clínica. Fallar
    // ruidoso es mejor que escribir una fila huérfana.
    throw new Error('No active location for the current tenant');
  }
  return location.id;
}
