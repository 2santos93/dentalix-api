import { ClinicRole } from '@prisma/client';
import {
  APPOINTMENT_ROLES,
  CLINICAL_ROLES,
  CLOSING_QUEUE_ROLES,
  INVENTORY_ROLES,
  RECEIVABLES_ROLES,
  TREATMENT_PLAN_FOLLOW_UP_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import {
  WORK_QUEUE_KEYS,
  WORK_QUEUE_ROLES,
  workQueuesFor,
  type WorkQueueKey,
} from '../domain/work-queues';
import { overdueOf } from './work-queue-sources';
import {
  GetWorkQueuesSummaryUseCase,
  type WorkQueueSources,
} from './work-queues-summary.use-case';

const NOW = new Date('2026-11-01T12:00:00.000Z');

function sources(
  overrides: Partial<WorkQueueSources> = {},
): WorkQueueSources & Record<WorkQueueKey, jest.Mock> {
  const all = Object.fromEntries(
    WORK_QUEUE_KEYS.map((key, i) => [
      key,
      jest.fn().mockResolvedValue({ count: i + 1 }),
    ]),
  ) as Record<WorkQueueKey, jest.Mock>;
  for (const [key, fn] of Object.entries(overrides)) {
    all[key as WorkQueueKey] = fn as jest.Mock;
  }
  return all;
}

describe('WORK_QUEUE_ROLES (DX-503)', () => {
  // Nunca amplía el @Roles del endpoint de la lista: quien no puede abrirla no
  // la cuenta.
  const ENDPOINT_ROLES: Record<WorkQueueKey, readonly ClinicRole[]> = {
    CLOSING_QUEUE: CLOSING_QUEUE_ROLES,
    ANAMNESIS_REVIEW: CLINICAL_ROLES,
    QUOTE_FOLLOW_UP: TREATMENT_PLAN_FOLLOW_UP_ROLES,
    ACCEPTED_UNSCHEDULED: APPOINTMENT_ROLES,
    WAITLIST: APPOINTMENT_ROLES,
    RECEIVABLES: RECEIVABLES_ROLES,
    LOW_STOCK: INVENTORY_ROLES,
  };

  it.each(WORK_QUEUE_KEYS)('%s está dentro del @Roles de su lista', (key) => {
    for (const role of WORK_QUEUE_ROLES[key]) {
      expect(ENDPOINT_ROLES[key]).toContain(role);
    }
  });

  it('reparte las listas por rol, en el orden de la bandeja', () => {
    expect(workQueuesFor(ClinicRole.ADMIN)).toEqual([...WORK_QUEUE_KEYS]);
    expect(workQueuesFor(ClinicRole.DENTIST)).toEqual([
      'CLOSING_QUEUE',
      'ANAMNESIS_REVIEW',
    ]);
    expect(workQueuesFor(ClinicRole.RECEPTION)).toEqual([
      'CLOSING_QUEUE',
      'QUOTE_FOLLOW_UP',
      'ACCEPTED_UNSCHEDULED',
      'WAITLIST',
      'RECEIVABLES',
    ]);
    expect(workQueuesFor(ClinicRole.ASSISTANT)).toEqual([
      'ANAMNESIS_REVIEW',
      'LOW_STOCK',
    ]);
  });
});

describe('GetWorkQueuesSummaryUseCase (DX-503)', () => {
  const actor = (role: ClinicRole) => ({ userId: 'u-1', role });

  it.each([
    ClinicRole.ADMIN,
    ClinicRole.DENTIST,
    ClinicRole.RECEPTION,
    ClinicRole.ASSISTANT,
  ])('%s: solo pide y devuelve sus listas', async (role) => {
    const src = sources();
    const result = await new GetWorkQueuesSummaryUseCase(
      src,
      () => NOW,
    ).execute(actor(role));
    const mine = workQueuesFor(role);
    expect(result.items.map((i) => i.key)).toEqual(mine);
    for (const key of WORK_QUEUE_KEYS) {
      expect(src[key]).toHaveBeenCalledTimes(mine.includes(key) ? 1 : 0);
    }
    for (const item of result.items) {
      expect(item).toEqual({
        key: item.key,
        status: 'OK',
        count: WORK_QUEUE_KEYS.indexOf(item.key) + 1,
      });
    }
    expect(result.generatedAt).toBe(NOW.toISOString());
  });

  it('pasa el actor a cada fuente (el cierre acota por rol y usuario)', async () => {
    const src = sources();
    await new GetWorkQueuesSummaryUseCase(src, () => NOW).execute(
      actor(ClinicRole.DENTIST),
    );
    expect(src.CLOSING_QUEUE).toHaveBeenCalledWith({
      userId: 'u-1',
      role: ClinicRole.DENTIST,
    });
  });

  it('una lista que falla sale ERROR y las demás llegan con su número', async () => {
    const src = sources({
      QUOTE_FOLLOW_UP: jest.fn().mockRejectedValue(new Error('se cayó')),
    });
    const result = await new GetWorkQueuesSummaryUseCase(
      src,
      () => NOW,
    ).execute(actor(ClinicRole.RECEPTION));
    expect(result.items).toEqual([
      { key: 'CLOSING_QUEUE', status: 'OK', count: 1 },
      { key: 'QUOTE_FOLLOW_UP', status: 'ERROR', count: null },
      { key: 'ACCEPTED_UNSCHEDULED', status: 'OK', count: 4 },
      { key: 'WAITLIST', status: 'OK', count: 5 },
      { key: 'RECEIVABLES', status: 'OK', count: 6 },
    ]);
  });

  it('corre las fuentes a la vez (no espera una para empezar la siguiente)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started: WorkQueueKey[] = [];
    const src = sources(
      Object.fromEntries(
        WORK_QUEUE_KEYS.map((key) => [
          key,
          jest.fn(async () => {
            started.push(key);
            await gate;
            return { count: 0 };
          }),
        ]),
      ),
    );
    const pending = new GetWorkQueuesSummaryUseCase(src, () => NOW).execute(
      actor(ClinicRole.ADMIN),
    );
    await Promise.resolve();
    expect(started).toEqual([...WORK_QUEUE_KEYS]);
    release();
    await pending;
  });

  it('`only` acota a esas listas y nunca añade una que el rol no tiene', async () => {
    const src = sources();
    const result = await new GetWorkQueuesSummaryUseCase(
      src,
      () => NOW,
    ).execute(actor(ClinicRole.ASSISTANT), [
      'CLOSING_QUEUE',
      'ANAMNESIS_REVIEW',
    ]);
    expect(result.items.map((i) => i.key)).toEqual(['ANAMNESIS_REVIEW']);
    expect(src.CLOSING_QUEUE).not.toHaveBeenCalled();
    expect(src.LOW_STOCK).not.toHaveBeenCalled();
  });

  it('pasa `overdue` de la cartera tal cual', async () => {
    const src = sources({
      RECEIVABLES: jest.fn().mockResolvedValue({
        count: 3,
        overdue: [{ currency: 'USD', amount: 12.5 }],
      }),
    });
    const result = await new GetWorkQueuesSummaryUseCase(
      src,
      () => NOW,
    ).execute(actor(ClinicRole.ADMIN), ['RECEIVABLES']);
    expect(result.items).toEqual([
      {
        key: 'RECEIVABLES',
        status: 'OK',
        count: 3,
        overdue: [{ currency: 'USD', amount: 12.5 }],
      },
    ]);
  });
});

describe('overdueOf', () => {
  it('suma los tramos vencidos (no las cuotas por vencer) a dos decimales', () => {
    expect(
      overdueOf({ days0to30: 0.1, days31to60: 0.2, days61to90: 0, over90: 5 }),
    ).toBe(5.3);
  });
});
