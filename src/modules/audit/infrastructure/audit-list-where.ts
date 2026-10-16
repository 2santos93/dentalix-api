import type { Prisma } from '@prisma/client';
import type { AuditEventFilter } from '../domain/audit-event';
import type { AuditCursor } from '../domain/audit-cursor';

/**
 * `where` del listado (orden `occurredAt DESC, id DESC`). Con cursor, además
 * del desempate `OR`, va `occurredAt <= cursor`: es lo que el planner usa como
 * condición del índice `(tenantId, occurredAt DESC, id DESC)` (y para podar
 * particiones). Sin ella el `OR` solo filtra y una página profunda recorre
 * todo lo más reciente (DB-021: 318 ms → <1 ms a 6 meses).
 */
export function auditListWhere(
  tenantId: string,
  filter: AuditEventFilter,
  cursor: AuditCursor | null,
): Prisma.AuditEventWhereInput {
  const and: Prisma.AuditEventWhereInput[] = [
    { occurredAt: { gte: filter.from, lt: filter.to } },
  ];
  if (cursor) {
    and.push(
      { occurredAt: { lte: cursor.occurredAt } },
      {
        OR: [
          { occurredAt: { lt: cursor.occurredAt } },
          { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
        ],
      },
    );
  }
  return {
    tenantId,
    ...(filter.patientId ? { patientId: filter.patientId } : {}),
    ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.resourceType ? { resourceType: filter.resourceType } : {}),
    AND: and,
  };
}
