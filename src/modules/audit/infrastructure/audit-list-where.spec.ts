import { auditListWhere } from './audit-list-where';

const from = new Date('2026-01-01T00:00:00.000Z');
const to = new Date('2026-10-01T00:00:00.000Z');
const tenantId = '11111111-1111-4111-8111-111111111111';

describe('auditListWhere (DX-102, DB-021)', () => {
  it('sin cursor acota solo por tenant y rango', () => {
    expect(auditListWhere(tenantId, { from, to }, null)).toEqual({
      tenantId,
      AND: [{ occurredAt: { gte: from, lt: to } }],
    });
  });

  it('con cursor añade occurredAt <= cursor (condición de índice) además del desempate por id', () => {
    const c = {
      occurredAt: new Date('2026-04-01T10:00:00.000Z'),
      id: '01890000-0000-7000-8000-000000000000',
    };
    expect(auditListWhere(tenantId, { from, to }, c)).toEqual({
      tenantId,
      AND: [
        { occurredAt: { gte: from, lt: to } },
        { occurredAt: { lte: c.occurredAt } },
        {
          OR: [
            { occurredAt: { lt: c.occurredAt } },
            { occurredAt: c.occurredAt, id: { lt: c.id } },
          ],
        },
      ],
    });
  });

  it('pasa los filtros de paciente, actor, acción y recurso', () => {
    const where = auditListWhere(
      tenantId,
      {
        from,
        to,
        patientId: 'p',
        actorUserId: 'u',
        action: 'VOID',
        resourceType: 'PAYMENT',
      },
      null,
    );
    expect(where).toMatchObject({
      patientId: 'p',
      actorUserId: 'u',
      action: 'VOID',
      resourceType: 'PAYMENT',
    });
  });
});
