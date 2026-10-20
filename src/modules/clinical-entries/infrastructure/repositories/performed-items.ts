import type { Prisma } from '@prisma/client';
import { civilDayRange } from '../../../../shared/time/civil-day';
import type { RdaPerformedItem } from '../../domain/rda-readiness';

/**
 * Procedimientos del catálogo hechos en una atención, con su CUPS (DX-212):
 * los registros del odontograma PROCEDURE completados en esta clínica, no
 * anulados, ligados a alguna de las evoluciones `entryIds` o registrados el
 * día civil `day` de la sede (zona `timeZone`). Sin repetir y por orden de
 * registro. Lo usan el RDA de una evolución (`loadRdaFacts`) y las
 * sugerencias de indicaciones postoperatorias de una cita (DX-222). Corre en
 * la transacción del llamador, bajo su RLS.
 */
export async function performedItemsOf(
  tx: Prisma.TransactionClient,
  patientId: string,
  entryIds: readonly string[],
  day: string,
  timeZone: string,
): Promise<RdaPerformedItem[]> {
  const { start, end } = civilDayRange(day, timeZone);
  const records = await tx.toothRecord.findMany({
    where: {
      patientId,
      deletedAt: null,
      kind: 'PROCEDURE',
      status: 'COMPLETED',
      origin: 'THIS_CLINIC',
      voidsRecordId: null,
      catalogItemId: { not: null },
      OR: [
        { clinicalEntryId: { in: [...entryIds] } },
        { recordedAt: { gte: start, lt: end } },
      ],
    },
    orderBy: { recordedAt: 'asc' },
    select: { id: true, catalogItemId: true },
  });
  if (records.length === 0) return [];
  const voided = new Set(
    (
      await tx.toothRecord.findMany({
        where: { voidsRecordId: { in: records.map((r) => r.id) } },
        select: { voidsRecordId: true },
      })
    ).map((v) => v.voidsRecordId),
  );
  const live = records.filter((r) => !voided.has(r.id));
  const catalogIds = [...new Set(live.map((r) => r.catalogItemId as string))];
  const items = await tx.dentalCatalogItem.findMany({
    where: { id: { in: catalogIds } },
    select: { id: true, labelEs: true, cupsCode: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  return catalogIds.flatMap((catalogItemId) => {
    const item = byId.get(catalogItemId);
    return item
      ? [{ catalogItemId, name: item.labelEs, cupsCode: item.cupsCode }]
      : [];
  });
}
