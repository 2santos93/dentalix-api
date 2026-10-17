import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { CollectionsRepository } from '../domain/ports/collections-repository.port';
import type { OpenPromise, PatientPayment } from '../domain/collections.entity';
import { SettlePaymentPromises } from './settle-payment-promises';

const BOGOTA = 'America/Bogota';

function promise(id: string, patientId: string): OpenPromise {
  return {
    id,
    patientId,
    amount: 200_000,
    currency: 'COP',
    dueDate: '2026-11-15',
    createdAt: new Date('2026-11-01T15:00:00.000Z'),
    timeZone: BOGOTA,
  };
}

class FakeRepo {
  open = new Map<string, OpenPromise[]>([
    [
      't1',
      [promise('kept', 'p1'), promise('broken', 'p2'), promise('open', 'p3')],
    ],
  ]);
  payments: PatientPayment[] = [
    {
      patientId: 'p1',
      amount: 200_000,
      currency: 'COP',
      paidAt: new Date('2026-11-10T15:00:00.000Z'),
      createdAt: new Date('2026-11-10T15:00:00.000Z'),
    },
  ];
  closed: { id: string; status: string }[] = [];
  paymentQueries = 0;

  tenantIds = () => Promise.resolve([...this.open.keys()]);
  openPromises = (tenantId: string, patientId?: string) =>
    Promise.resolve(
      (this.open.get(tenantId) ?? []).filter(
        (p) =>
          !this.closed.some((c) => c.id === p.id) &&
          (!patientId || p.patientId === patientId),
      ),
    );
  paymentsSince = (_t: string, ids: readonly string[]) => {
    this.paymentQueries += 1;
    return Promise.resolve(
      this.payments.filter((p) => ids.includes(p.patientId)),
    );
  };
  closePromise = (_t: string, id: string, status: string) => {
    if (this.closed.some((c) => c.id === id)) return Promise.resolve(false);
    this.closed.push({ id, status });
    return Promise.resolve(true);
  };
}

describe('SettlePaymentPromises (DX-150)', () => {
  let repo: FakeRepo;
  let events: AuditEventDraft[];
  let now: Date;
  let settle: SettlePaymentPromises;

  beforeEach(() => {
    repo = new FakeRepo();
    events = [];
    now = new Date('2026-11-16T05:30:00.000Z'); // 00:30 del 16 en Bogotá
    const audit = {
      record: (draft: AuditEventDraft) => {
        events.push(draft);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase;
    settle = new SettlePaymentPromises(
      repo as unknown as CollectionsRepository,
      audit,
      () => now,
    );
  });

  it('el barrido cierra cumplidos e incumplidos con un evento por cambio, sin usuario ni importes', async () => {
    await expect(settle.run()).resolves.toEqual({ kept: 1, broken: 2 });
    expect(repo.closed).toEqual([
      { id: 'kept', status: 'KEPT' },
      { id: 'broken', status: 'BROKEN' },
      { id: 'open', status: 'BROKEN' },
    ]);
    // Una sola consulta de abonos por clínica (sin N+1).
    expect(repo.paymentQueries).toBe(1);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      tenantId: 't1',
      actor: { kind: 'system' },
      action: 'UPDATE',
      resourceType: 'PAYMENT_PROMISE',
      resourceId: 'kept',
      patient: { kind: 'patient', id: 'p1' },
      metadata: { reason: 'PROMISE_KEPT', origin: 'JOB' },
    });
    expect(JSON.stringify(events)).not.toContain('200000');
  });

  it('es idempotente: un segundo barrido no cambia ni audita nada', async () => {
    await settle.run();
    events = [];
    await expect(settle.run()).resolves.toEqual({ kept: 0, broken: 0 });
    expect(events).toEqual([]);
  });

  it('antes del día siguiente en la sede, lo no cubierto sigue abierto', async () => {
    now = new Date('2026-11-16T04:59:00.000Z'); // 23:59 del 15 en Bogotá
    await expect(settle.run()).resolves.toEqual({ kept: 1, broken: 0 });
  });

  it('tras un abono: solo el paciente, auditado con el usuario que lo registró', async () => {
    now = new Date('2026-11-10T16:00:00.000Z');
    await settle.afterPayment('p1', {
      tenantId: 't1',
      locationId: 'loc-1',
      actor: { userId: 'u-recepcion', role: 'RECEPTION' },
      requestId: 'req-1',
      ip: null,
      userAgent: null,
    });
    expect(repo.closed).toEqual([{ id: 'kept', status: 'KEPT' }]);
    expect(events[0]).toMatchObject({
      actor: { kind: 'user', userId: 'u-recepcion', role: 'RECEPTION' },
      metadata: { reason: 'PROMISE_KEPT' },
      requestId: 'req-1',
    });
    expect(events[0].metadata).not.toHaveProperty('origin');
  });

  it('tras un abono nunca lanza: el fallo queda en el log', async () => {
    repo.openPromises = () => Promise.reject(new Error('BD caída'));
    await expect(
      settle.afterPayment('p1', {
        tenantId: 't1',
        locationId: null,
        actor: { userId: 'u', role: 'ADMIN' },
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    ).resolves.toBeUndefined();
  });
});
