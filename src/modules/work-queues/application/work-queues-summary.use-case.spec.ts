import { Logger } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { withinTransactionBudget } from '../../../shared/prisma/transaction-budget';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  APPOINTMENT_ROLES,
  CLINICAL_ROLES,
  CLOSING_QUEUE_ROLES,
  INVENTORY_ROLES,
  RECALL_LIST_ROLES,
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
  WORK_QUEUES_CACHE_TTL_MS,
  WorkQueuesSummaryCache,
} from './work-queues-summary.cache';
import {
  GetWorkQueuesSummaryUseCase,
  WORK_QUEUES_MAX_CONNECTIONS,
  type WorkQueueSources,
} from './work-queues-summary.use-case';

const NOW = new Date('2026-11-01T12:00:00.000Z');

/** Sin tenant en el contexto (como estas pruebas): calcula siempre, sin caché. */
function useCase(
  src: WorkQueueSources,
  tenantContext = new TenantContextService(),
  cache = new WorkQueuesSummaryCache(WORK_QUEUES_CACHE_TTL_MS, () =>
    NOW.getTime(),
  ),
): GetWorkQueuesSummaryUseCase {
  return new GetWorkQueuesSummaryUseCase(src, () => NOW, tenantContext, cache);
}

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
    RECALL: RECALL_LIST_ROLES,
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
      'RECALL',
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
    const result = await useCase(src).execute(actor(role));
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
    await useCase(src).execute(actor(ClinicRole.DENTIST));
    expect(src.CLOSING_QUEUE).toHaveBeenCalledWith({
      userId: 'u-1',
      role: ClinicRole.DENTIST,
    });
  });

  it('una lista que falla sale ERROR y las demás llegan con su número', async () => {
    const src = sources({
      QUOTE_FOLLOW_UP: jest.fn().mockRejectedValue(new Error('se cayó')),
    });
    const result = await useCase(src).execute(actor(ClinicRole.RECEPTION));
    expect(result.items).toEqual([
      { key: 'CLOSING_QUEUE', status: 'OK', count: 1 },
      { key: 'QUOTE_FOLLOW_UP', status: 'ERROR', count: null },
      { key: 'ACCEPTED_UNSCHEDULED', status: 'OK', count: 4 },
      { key: 'WAITLIST', status: 'OK', count: 5 },
      { key: 'RECALL', status: 'OK', count: 6 },
      { key: 'RECEIVABLES', status: 'OK', count: 7 },
    ]);
  });

  it('nunca corre más de 2 fuentes a la vez (OPS-056), y las corre todas', async () => {
    let running = 0;
    let peak = 0;
    const started: WorkQueueKey[] = [];
    const src = sources(
      Object.fromEntries(
        WORK_QUEUE_KEYS.map((key, i) => [
          key,
          jest.fn(async () => {
            started.push(key);
            running++;
            peak = Math.max(peak, running);
            // Duraciones distintas: el hueco lo toma la siguiente en cola.
            for (let n = 0; n <= i % 3; n++) {
              await new Promise((r) => setImmediate(r));
            }
            running--;
            return { count: i };
          }),
        ]),
      ),
    );
    const result = await useCase(src).execute(actor(ClinicRole.ADMIN));
    expect(peak).toBe(WORK_QUEUES_MAX_CONNECTIONS);
    expect(WORK_QUEUES_MAX_CONNECTIONS).toBe(2);
    expect([...started].sort()).toEqual([...WORK_QUEUE_KEYS].sort());
    // El orden de la respuesta es el de la bandeja, no el de llegada.
    expect(result.items.map((i) => i.key)).toEqual([...WORK_QUEUE_KEYS]);
    expect(result.items.map((i) => i.count)).toEqual(
      WORK_QUEUE_KEYS.map((_, i) => i),
    );
  });

  it('nunca más de 2 transacciones a la vez aunque cada fuente abra varias en paralelo', async () => {
    let open = 0;
    let peak = 0;
    const transaction = () =>
      withinTransactionBudget(async () => {
        open++;
        peak = Math.max(peak, open);
        await new Promise((r) => setImmediate(r));
        open--;
      });
    // Como pendiente de cerrar (3 secciones) o la cartera (2 + 3): cada
    // fuente abre 3 transacciones con Promise.all.
    const src = sources(
      Object.fromEntries(
        WORK_QUEUE_KEYS.map((key) => [
          key,
          jest.fn(async () => {
            await Promise.all([transaction(), transaction(), transaction()]);
            return { count: 1 };
          }),
        ]),
      ),
    );
    await useCase(src).execute(actor(ClinicRole.ADMIN));
    expect(peak).toBe(2);
  });

  it('una fuente que falla registra un evento estructurado, sin el mensaje', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const failure = Object.assign(
        new Error('duplicate key value (id)=(paciente-secreto)'),
        { name: 'PrismaClientKnownRequestError', code: 'P2002' },
      );
      const src = sources({
        WAITLIST: jest.fn().mockRejectedValue(failure),
        RECALL: jest.fn().mockRejectedValue('texto suelto'),
      });
      await useCase(src).execute(actor(ClinicRole.RECEPTION));
      expect(warn.mock.calls).toEqual([
        [
          {
            event: 'work_queues.source_failed',
            key: 'WAITLIST',
            error: 'PrismaClientKnownRequestError',
            code: 'P2002',
          },
        ],
        [
          {
            event: 'work_queues.source_failed',
            key: 'RECALL',
            error: 'string',
            code: null,
          },
        ],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secreto');
    } finally {
      warn.mockRestore();
    }
  });

  it('`only` acota a esas listas y nunca añade una que el rol no tiene', async () => {
    const src = sources();
    const result = await useCase(src).execute(actor(ClinicRole.ASSISTANT), [
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
    const result = await useCase(src).execute(actor(ClinicRole.ADMIN), [
      'RECEIVABLES',
    ]);
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

describe('GetWorkQueuesSummaryUseCase · caché corta (OPS-056)', () => {
  const actor = (role: ClinicRole, userId = 'u-1') => ({ userId, role });
  let nowMs: number;
  let tenantContext: TenantContextService;
  let src: ReturnType<typeof sources>;
  let uc: GetWorkQueuesSummaryUseCase;

  beforeEach(() => {
    nowMs = NOW.getTime();
    tenantContext = new TenantContextService();
    src = sources();
    uc = useCase(
      src,
      tenantContext,
      new WorkQueuesSummaryCache(WORK_QUEUES_CACHE_TTL_MS, () => nowMs),
    );
  });

  const inScope = <T>(
    fn: () => Promise<T>,
    scope: {
      tenantId?: string;
      locationId?: string;
      allowed?: readonly string[];
    } = { locationId: 'loc-1' },
  ) =>
    tenantContext.run(
      scope.tenantId ?? 'tenant-a',
      scope.locationId,
      fn,
      scope.allowed,
    );

  const calls = () => src.CLOSING_QUEUE.mock.calls.length;

  it('la misma consulta dentro del TTL no vuelve a contar; pasado el TTL, sí', async () => {
    const first = await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
    expect(calls()).toBe(1);
    nowMs += WORK_QUEUES_CACHE_TTL_MS - 1;
    const again = await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
    expect(again).toEqual(first);
    expect(calls()).toBe(1);
    nowMs += 1;
    await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
    expect(calls()).toBe(2);
  });

  it('nunca sirve lo de otra clínica, otra sede, otras sedes permitidas, otro rol u otro usuario', async () => {
    const admin = () => uc.execute(actor(ClinicRole.ADMIN));
    await inScope(admin);
    await inScope(admin, { tenantId: 'tenant-b', locationId: 'loc-1' });
    await inScope(admin, { locationId: 'loc-2' });
    await inScope(admin, {});
    await inScope(admin, { allowed: ['loc-1'] });
    await inScope(() => uc.execute(actor(ClinicRole.RECEPTION)));
    await inScope(() => uc.execute(actor(ClinicRole.ADMIN, 'u-2')));
    expect(calls()).toBe(7);
    // Y cada una, repetida, sale de la suya.
    await inScope(admin, { tenantId: 'tenant-b', locationId: 'loc-1' });
    await inScope(admin, {});
    await inScope(() => uc.execute(actor(ClinicRole.RECEPTION)));
    expect(calls()).toBe(7);
  });

  it('un rol con menos listas nunca recibe las de otro rol desde la caché', async () => {
    await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
    const dentist = await inScope(() => uc.execute(actor(ClinicRole.DENTIST)));
    expect(dentist.items.map((i) => i.key)).toEqual(
      workQueuesFor(ClinicRole.DENTIST),
    );
  });

  it('`only` distinto es otra entrada', async () => {
    await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
    const two = await inScope(() =>
      uc.execute(actor(ClinicRole.ADMIN), ['CLOSING_QUEUE', 'RECALL']),
    );
    expect(two.items.map((i) => i.key)).toEqual(['CLOSING_QUEUE', 'RECALL']);
    expect(calls()).toBe(2);
  });

  it('una respuesta con una lista en ERROR no se guarda', async () => {
    src.RECALL.mockRejectedValueOnce(new Error('caída'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const first = await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
      expect(first.items.find((i) => i.key === 'RECALL')?.status).toBe('ERROR');
      const second = await inScope(() => uc.execute(actor(ClinicRole.ADMIN)));
      expect(second.items.every((i) => i.status === 'OK')).toBe(true);
      expect(calls()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('sin clínica en el contexto no guarda ni sirve nada', async () => {
    await uc.execute(actor(ClinicRole.ADMIN));
    await uc.execute(actor(ClinicRole.ADMIN));
    expect(calls()).toBe(2);
  });
});

describe('overdueOf', () => {
  it('suma los tramos vencidos (no las cuotas por vencer) a dos decimales', () => {
    expect(
      overdueOf({ days0to30: 0.1, days31to60: 0.2, days61to90: 0, over90: 5 }),
    ).toBe(5.3);
  });
});
