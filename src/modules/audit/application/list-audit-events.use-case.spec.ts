import { BadRequestException } from '@nestjs/common';
import { ListAuditEventsUseCase } from './list-audit-events.use-case';
import type { AuditEventRepository } from '../domain/ports/audit-event-repository.port';
import type { AuditEventView } from '../domain/audit-event';
import { encodeAuditCursor } from '../domain/audit-cursor';

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-16T15:00:00.000Z');
const DAY = 86_400_000;

function event(i: number): AuditEventView {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    occurredAt: new Date(NOW.getTime() - i * 1000),
    action: 'VIEW',
    resourceType: 'PATIENT',
    resourceId: null,
    locationId: null,
    timeZone: 'America/Bogota',
    actor: null,
    patient: null,
    requestId: null,
    ip: null,
    userAgent: null,
    metadata: {},
  };
}

function setup(rows: AuditEventView[] = []) {
  const list = jest
    .fn<
      ReturnType<AuditEventRepository['list']>,
      Parameters<AuditEventRepository['list']>
    >()
    .mockResolvedValue(rows);
  const clinicTimeZone = jest.fn().mockResolvedValue('America/Bogota');
  const repo: AuditEventRepository = {
    insert: jest.fn(),
    list,
    clinicTimeZone,
  };
  const useCase = new ListAuditEventsUseCase(repo, () => NOW);
  return { repo: { list, clinicTimeZone }, useCase };
}

describe('ListAuditEventsUseCase (DX-009)', () => {
  it('sin fechas: los últimos 30 días hasta ahora, 50 por página', async () => {
    const { repo, useCase } = setup();
    const out = await useCase.execute({ tenantId: TENANT });
    expect(repo.list).toHaveBeenCalledWith(
      TENANT,
      { from: new Date(NOW.getTime() - 30 * DAY), to: NOW },
      null,
      51,
    );
    expect(out).toEqual({
      items: [],
      nextCursor: null,
      timeZone: 'America/Bogota',
    });
  });

  it('pide una fila de más para saber si hay otra página, y no la devuelve', async () => {
    const rows = [event(1), event(2), event(3)];
    const { useCase } = setup(rows);
    const out = await useCase.execute({ tenantId: TENANT, limit: 2 });
    expect(out.items).toEqual(rows.slice(0, 2));
    expect(out.nextCursor).toBe(
      encodeAuditCursor({ occurredAt: rows[1].occurredAt, id: rows[1].id }),
    );
  });

  it('última página: sin cursor siguiente', async () => {
    const { useCase } = setup([event(1)]);
    const out = await useCase.execute({ tenantId: TENANT, limit: 2 });
    expect(out.nextCursor).toBeNull();
  });

  it('pasa los filtros y el cursor al repositorio', async () => {
    const { repo, useCase } = setup();
    const cursor = {
      occurredAt: new Date('2026-10-10T00:00:00.000Z'),
      id: event(9).id,
    };
    await useCase.execute({
      tenantId: TENANT,
      patientId: event(7).id,
      actorUserId: event(8).id,
      action: 'SIGN',
      resourceType: 'CONSENT',
      from: '2026-10-01T05:00:00.000Z',
      to: '2026-10-15T05:00:00.000Z',
      cursor: encodeAuditCursor(cursor),
      limit: 10,
    });
    expect(repo.list).toHaveBeenCalledWith(
      TENANT,
      {
        patientId: event(7).id,
        actorUserId: event(8).id,
        action: 'SIGN',
        resourceType: 'CONSENT',
        from: new Date('2026-10-01T05:00:00.000Z'),
        to: new Date('2026-10-15T05:00:00.000Z'),
      },
      cursor,
      11,
    );
  });

  it('el límite tiene tope (100)', async () => {
    const { repo, useCase } = setup();
    await useCase.execute({ tenantId: TENANT, limit: 5000 });
    expect(repo.list.mock.calls[0][3]).toBe(101);
  });

  it('solo `from`: hasta 30 días después (sin pasar de ahora)', async () => {
    const { repo, useCase } = setup();
    await useCase.execute({
      tenantId: TENANT,
      from: '2026-01-01T00:00:00.000Z',
    });
    expect(repo.list.mock.calls[0][1]).toEqual({
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-01-31T00:00:00.000Z'),
    });
  });

  it.each([
    [
      'from después de to',
      { from: '2026-10-10T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    ],
    [
      'rango de más de 366 días',
      { from: '2025-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    ],
    ['cursor manipulado', { cursor: 'no-es-un-cursor' }],
  ])('400: %s', async (_name, input) => {
    const { repo, useCase } = setup();
    await expect(
      useCase.execute({ tenantId: TENANT, ...input }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('la zona de referencia es la de la sede activa', async () => {
    const { repo, useCase } = setup();
    await useCase.execute({ tenantId: TENANT, locationId: event(5).id });
    expect(repo.clinicTimeZone).toHaveBeenCalledWith(TENANT, event(5).id);
  });
});
