import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { RecallKind } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';
import type { RecallRepository } from '../../domain/ports/recall-repository.port';
import type {
  NewRecallContact,
  PatientRecallRow,
  RecallContactView,
  RecallDueQuery,
  RecallDueRow,
  RecallExclusionUpdate,
  RecallRef,
  RecallTypeRef,
  RecallTypeView,
  RecallUnconfiguredQuery,
  RecallUnconfiguredRow,
  SetPatientRecallData,
  StaffRef,
} from '../../domain/recall.entity';
import { addCivilMonths } from '../../domain/recall-rules';
import {
  APPOINTMENT_NOT_OF_PATIENT_MESSAGE,
  BOOKED_NEEDS_APPOINTMENT_MESSAGE,
  CreateDefaultRecallUseCase,
  CreateRecallContactUseCase,
  DISABLED_REASON_TOO_LONG_MESSAGE,
  DISABLED_UNTIL_INVALID_MESSAGE,
  DISABLED_UNTIL_PAST_MESSAGE,
  GetPatientRecallsUseCase,
  INTERVAL_RANGE_MESSAGE,
  LAST_DONE_FUTURE_MESSAGE,
  LAST_DONE_INVALID_MESSAGE,
  ListDueRecallsUseCase,
  ListUnconfiguredRecallsUseCase,
  NOTE_TOO_LONG_MESSAGE,
  ListRecallTypesUseCase,
  PATIENT_NOT_FOUND_MESSAGE,
  RECALL_NOT_FOUND_MESSAGE,
  RECALL_TYPE_NOT_FOUND_MESSAGE,
  SetPatientRecallUseCase,
} from './recall.use-cases';

// DX-551 (TST-065): los casos de uso del recall con un doble del repositorio
// en memoria. El reloj va fijo: 12:00 en Caracas del 6 de noviembre de 2026.
const NOW = new Date('2026-11-06T16:00:00.000Z');
const SEDE_DAY = '2026-11-06';
const clock = () => NOW;

const NORTE = 'sede-norte';
const SUR = 'sede-sur';

/** Tipos sembrados de la clínica (DX-015-bis): id y nombre por clave. */
const TYPE_ID: Record<RecallKind, string> = {
  HYGIENE: 'tipo-higiene',
  CHECKUP: 'tipo-control',
};
const TYPE_NAME: Record<RecallKind, string> = {
  HYGIENE: 'Higiene',
  CHECKUP: 'Control',
};
const byKey = (systemKey: RecallKind) => ({ systemKey });

interface FakeRecall {
  id: string;
  patientId: string;
  kind: RecallKind;
  intervalMonths: number;
  lastDoneAt: string;
  active: boolean;
  disabledUntil: string | null;
  disabledReason: string | null;
  /** Sede donde se fijó. */
  locationId: string;
  updatedById: string;
}

interface FakeAppointment {
  id: string;
  patientId: string;
  locationId: string;
  /** Día civil (en la sede) de la cita. */
  day: string;
  status: 'COMPLETED' | 'SCHEDULED' | 'CANCELLED';
}

/**
 * Doble del puerto: las mismas reglas que el repositorio Prisma (la sede del
 * recall es la de la última cita atendida o, sin ella, la del recall; el
 * vencimiento, la columna generada "lastDoneAt" + intervalo), sin BD. La base
 * de lo fijado es `lastDoneAt` (sin DONE de procedimientos: eso lo prueban los
 * tests con BD). Guarda cada llamada para poder comprobar qué recibió.
 */
class InMemoryRecallRepository implements RecallRepository {
  readonly patients = new Set<string>();
  readonly recalls: FakeRecall[] = [];
  readonly appointments: FakeAppointment[] = [];
  readonly contacts: RecallContactView[] = [];
  readonly staffNames = new Map<string, string>();
  dueRows: RecallDueRow[] = [];
  dueTotal = 0;
  sedeDay = SEDE_DAY;

  unconfiguredRows: RecallUnconfiguredRow[] = [];
  unconfiguredTotal = 0;
  readonly unconfiguredQueries: RecallUnconfiguredQuery[] = [];
  readonly defaultCreates: {
    patientId: string;
    recallTypeId: string;
    appointmentId?: string;
    now: Date;
    actorId: string;
  }[] = [];
  /** Lo que «desactiva» la exclusión en el próximo alta por defecto. */
  nextExcluded: RecallExclusionUpdate[] = [];
  readonly dueQueries: RecallDueQuery[] = [];
  readonly upserts: SetPatientRecallData[] = [];
  readonly writeTodayCalls: Date[] = [];
  readonly patientRecallsCalls: { patientId: string; now: Date }[] = [];
  readonly calls: string[] = [];

  listDue(
    query: RecallDueQuery,
  ): Promise<{ rows: RecallDueRow[]; total: number }> {
    this.calls.push('listDue');
    this.dueQueries.push(query);
    return Promise.resolve({ rows: this.dueRows, total: this.dueTotal });
  }

  listUnconfigured(
    query: RecallUnconfiguredQuery,
  ): Promise<{ rows: RecallUnconfiguredRow[]; total: number }> {
    this.calls.push('listUnconfigured');
    this.unconfiguredQueries.push(query);
    return Promise.resolve({
      rows: this.unconfiguredRows,
      total: this.unconfiguredTotal,
    });
  }

  // Las reglas del alta (base, 409, 422, exclusión) las prueban los tests con
  // BD (recall-default.int-spec.ts); aquí solo el orden y lo que recibe.
  createDefaultRecall(data: {
    patientId: string;
    recallTypeId: string;
    appointmentId?: string;
    now: Date;
    actorId: string;
  }): Promise<{ id: string; excluded: RecallExclusionUpdate[] }> {
    this.calls.push('createDefaultRecall');
    this.defaultCreates.push({
      patientId: data.patientId,
      recallTypeId: data.recallTypeId,
      ...(data.appointmentId ? { appointmentId: data.appointmentId } : {}),
      now: data.now,
      actorId: data.actorId,
    });
    const kind = (Object.keys(TYPE_ID) as RecallKind[]).find(
      (k) => TYPE_ID[k] === data.recallTypeId,
    );
    if (!kind) return Promise.reject(new Error('tipo inexistente'));
    const recall = this.seedRecall({
      patientId: data.patientId,
      kind,
      lastDoneAt: SEDE_DAY,
      updatedById: data.actorId,
    });
    return Promise.resolve({ id: recall.id, excluded: this.nextExcluded });
  }

  patientExists(patientId: string): Promise<boolean> {
    this.calls.push('patientExists');
    return Promise.resolve(this.patients.has(patientId));
  }

  patientRecalls(
    patientId: string,
    now: Date,
  ): Promise<{ rows: PatientRecallRow[]; contacts: RecallContactView[] }> {
    this.calls.push('patientRecalls');
    this.patientRecallsCalls.push({ patientId, now });
    const rows = this.recalls
      .filter((r) => r.patientId === patientId)
      .map((r): PatientRecallRow => {
        const visit = this.lastCompletedVisit(patientId);
        return {
          id: r.id,
          kind: r.kind,
          recallTypeId: TYPE_ID[r.kind],
          recallTypeName: TYPE_NAME[r.kind],
          intervalMonths: r.intervalMonths,
          lastDoneAt: r.lastDoneAt,
          dueAt: addCivilMonths(r.lastDoneAt, r.intervalMonths),
          manualDoneAt: r.lastDoneAt,
          lastDoneItemId: null,
          source: 'MANUAL',
          preBackfillDoneAt: null,
          active: r.active,
          disabledUntil: r.disabledUntil,
          disabledReason: r.disabledReason,
          locationId: visit?.locationId ?? r.locationId,
          hasUpcomingAppointment: this.appointments.some(
            (a) =>
              a.patientId === patientId &&
              a.status === 'SCHEDULED' &&
              a.day > this.sedeDay,
          ),
          today: this.sedeDay,
          updatedAt: NOW,
          updatedById: r.updatedById,
        };
      });
    return Promise.resolve({
      rows,
      contacts: this.contacts.filter((c) => c.patientId === patientId),
    });
  }

  writeToday(now: Date): Promise<string> {
    this.calls.push('writeToday');
    this.writeTodayCalls.push(now);
    return Promise.resolve(this.sedeDay);
  }

  upsertRecall(
    data: SetPatientRecallData,
  ): Promise<{ id: string; excluded: RecallExclusionUpdate[] }> {
    this.calls.push('upsertRecall');
    this.upserts.push(data);
    const kind = data.recallType.systemKey as RecallKind;
    const existing = this.recalls.find(
      (r) => r.patientId === data.patientId && r.kind === kind,
    );
    const fields = {
      intervalMonths: data.intervalMonths,
      active: data.active,
      disabledUntil: data.disabledUntil,
      disabledReason: data.disabledReason,
      updatedById: data.actorId,
    };
    if (existing) {
      // Como la BD: sin fecha, un recall que ya existe conserva su base.
      Object.assign(
        existing,
        fields,
        data.manualDoneAt === undefined
          ? {}
          : { lastDoneAt: data.manualDoneAt },
      );
      return Promise.resolve({ id: existing.id, excluded: [] });
    }
    const id = `recall-${this.recalls.length + 1}`;
    this.recalls.push({
      id,
      patientId: data.patientId,
      kind,
      locationId: NORTE,
      lastDoneAt: data.manualDoneAt ?? data.newRecallDoneAt,
      ...fields,
    });
    return Promise.resolve({ id, excluded: [] });
  }

  findType(
    ref: { systemKey: RecallKind } | { id: string },
  ): Promise<RecallTypeRef | null> {
    this.calls.push('findType');
    const key = (Object.keys(TYPE_ID) as RecallKind[]).find((k) =>
      'id' in ref ? TYPE_ID[k] === ref.id : k === ref.systemKey,
    );
    return Promise.resolve(
      key
        ? {
            id: TYPE_ID[key],
            name: TYPE_NAME[key],
            systemKey: key,
            exclusionGroup: null,
          }
        : null,
    );
  }

  listTypes(): Promise<RecallTypeView[]> {
    this.calls.push('listTypes');
    return Promise.resolve(
      (Object.keys(TYPE_ID) as RecallKind[]).map((k, i) => ({
        id: TYPE_ID[k],
        name: TYPE_NAME[k],
        defaultIntervalMonths: k === 'HYGIENE' ? 6 : 12,
        active: true,
        sortOrder: i,
        systemKey: k,
        exclusionGroup: k === 'HYGIENE' ? 'HYGIENE_PERIO' : null,
        triggerCatalogItemIds: [],
        triggers: [],
      })),
    );
  }

  // El CRUD de tipos tiene su propio doble (recall-types.use-cases.spec.ts).
  findTypeView(): Promise<RecallTypeView | null> {
    return Promise.reject(new Error('no se usa aquí'));
  }
  createType(): Promise<RecallTypeView> {
    return Promise.reject(new Error('no se usa aquí'));
  }
  updateType(): Promise<RecallTypeView> {
    return Promise.reject(new Error('no se usa aquí'));
  }
  retireType(): Promise<void> {
    return Promise.reject(new Error('no se usa aquí'));
  }
  setTriggers(): Promise<RecallTypeView> {
    return Promise.reject(new Error('no se usa aquí'));
  }

  findRecall(recallId: string): Promise<RecallRef | null> {
    this.calls.push('findRecall');
    const r = this.recalls.find((x) => x.id === recallId);
    if (!r) return Promise.resolve(null);
    const visit = this.lastCompletedVisit(r.patientId);
    return Promise.resolve({
      id: r.id,
      patientId: r.patientId,
      kind: r.kind,
      locationId: visit?.locationId ?? r.locationId,
    });
  }

  appointmentOfPatient(
    appointmentId: string,
    patientId: string,
  ): Promise<boolean> {
    this.calls.push('appointmentOfPatient');
    return Promise.resolve(
      this.appointments.some(
        (a) => a.id === appointmentId && a.patientId === patientId,
      ),
    );
  }

  createContact(data: NewRecallContact): Promise<RecallContactView> {
    this.calls.push('createContact');
    const recall = this.recalls.find((r) => r.id === data.recallId);
    if (!recall) throw new Error(`recall inexistente: ${data.recallId}`);
    const view: RecallContactView = {
      id: `contact-${this.contacts.length + 1}`,
      recallId: data.recallId,
      kind: recall.kind,
      recallTypeId: TYPE_ID[recall.kind],
      recallTypeName: TYPE_NAME[recall.kind],
      patientId: data.patientId,
      locationId: data.locationId,
      channel: data.channel,
      outcome: data.outcome,
      note: data.note,
      appointmentId: data.appointmentId,
      author: {
        id: data.authorId,
        fullName: this.staffNames.get(data.authorId) ?? null,
      },
      createdAt: NOW,
    };
    this.contacts.push(view);
    return Promise.resolve(view);
  }

  staff(ids: readonly string[]): Promise<Map<string, StaffRef>> {
    this.calls.push('staff');
    return Promise.resolve(
      new Map(
        ids
          .filter((id) => this.staffNames.has(id))
          .map((id) => [id, { id, fullName: this.staffNames.get(id) ?? null }]),
      ),
    );
  }

  private lastCompletedVisit(patientId: string): FakeAppointment | undefined {
    return this.appointments
      .filter((a) => a.patientId === patientId && a.status === 'COMPLETED')
      .sort((x, y) => (x.day < y.day ? 1 : -1))[0];
  }

  seedRecall(data: Partial<FakeRecall> & { patientId: string }): FakeRecall {
    this.patients.add(data.patientId);
    const recall: FakeRecall = {
      id: `recall-${this.recalls.length + 1}`,
      kind: 'CHECKUP',
      intervalMonths: 6,
      lastDoneAt: '2026-01-10',
      active: true,
      disabledUntil: null,
      disabledReason: null,
      locationId: NORTE,
      updatedById: 'dra-lopez',
      ...data,
    };
    this.recalls.push(recall);
    return recall;
  }
}

/** Contexto real del request: clínica, sede activa y sedes permitidas. */
function requestContext(allowed?: readonly string[]) {
  const ctx = new TenantContextService();
  const inRequest = <T>(fn: () => Promise<T>) =>
    ctx.run('clinica-a', undefined, fn, allowed);
  return { ctx, inRequest };
}

function dueRow(data: Partial<RecallDueRow> = {}): RecallDueRow {
  return {
    recallId: 'recall-1',
    patientId: 'pac-1',
    patientFirstName: 'Ana',
    patientLastName: 'Pérez',
    patientPhone: '+58 412 555 0101',
    phoneRegion: 'VE',
    reminderOptedOut: false,
    kind: 'CHECKUP',
    recallTypeId: TYPE_ID.CHECKUP,
    recallTypeName: 'Control',
    intervalMonths: 6,
    baseDate: '2026-04-01',
    dueAt: '2026-10-01',
    daysOverdue: 36,
    locationId: NORTE,
    lastContact: null,
    ...data,
  };
}

describe('ListDueRecallsUseCase (DX-015)', () => {
  let repo: InMemoryRecallRepository;
  let list: ListDueRecallsUseCase;

  beforeEach(() => {
    repo = new InMemoryRecallRepository();
    list = new ListDueRecallsUseCase(repo, clock);
  });

  it('sin parámetros: página 1 de 20, solo vencidos, los más vencidos primero y el reloj inyectado', async () => {
    const page = await list.execute({});
    expect(repo.dueQueries).toEqual([
      {
        kind: undefined,
        withinDays: 0,
        sort: 'MOST_OVERDUE',
        page: 1,
        pageSize: 20,
        now: NOW,
      },
    ]);
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('pasa tipo, orden y ventana al repositorio', async () => {
    await list.execute({
      kind: 'HYGIENE',
      sort: 'LEAST_OVERDUE',
      withinDays: 15,
      page: 3,
      pageSize: 50,
    });
    expect(repo.dueQueries[0]).toMatchObject({
      kind: 'HYGIENE',
      sort: 'LEAST_OVERDUE',
      withinDays: 15,
      page: 3,
      pageSize: 50,
    });
  });

  it.each<
    [
      string,
      { page?: number; pageSize?: number; withinDays?: number },
      { page: number; pageSize: number; withinDays: number },
    ]
  >([
    [
      'tope de 100 por página',
      { pageSize: 500 },
      { page: 1, pageSize: 100, withinDays: 0 },
    ],
    [
      'página y tamaño mínimos de 1',
      { page: 0, pageSize: 0 },
      { page: 1, pageSize: 1, withinDays: 0 },
    ],
    [
      'negativos al mínimo',
      { page: -4, pageSize: -1, withinDays: -5 },
      { page: 1, pageSize: 1, withinDays: 0 },
    ],
    [
      'decimales hacia abajo',
      { page: 2.7, pageSize: 10.9, withinDays: 7.5 },
      { page: 2, pageSize: 10, withinDays: 7 },
    ],
    [
      'ventana de hasta 60 días',
      { withinDays: 90 },
      { page: 1, pageSize: 20, withinDays: 60 },
    ],
    [
      'NaN e Infinity = por defecto',
      {
        page: Number.NaN,
        pageSize: Number.POSITIVE_INFINITY,
        withinDays: Number.NaN,
      },
      { page: 1, pageSize: 20, withinDays: 0 },
    ],
  ])(
    'acota la paginación y la ventana: %s',
    async (_label, input, expected) => {
      const page = await list.execute(input);
      expect(repo.dueQueries[0]).toMatchObject(expected);
      expect(page).toMatchObject({
        page: expected.page,
        pageSize: expected.pageSize,
      });
    },
  );

  it('arma el nombre, el teléfono y el enlace de WhatsApp con la región de la sede del paciente', async () => {
    repo.dueRows = [
      dueRow(),
      dueRow({
        recallId: 'recall-2',
        patientId: 'pac-2',
        patientFirstName: 'Luis',
        patientLastName: '',
        patientPhone: '0412 555 0202',
        phoneRegion: 've',
        locationId: SUR,
        lastContact: {
          channel: 'CALL',
          outcome: 'NO_ANSWER',
          createdAt: NOW,
        },
      }),
      dueRow({
        recallId: 'recall-3',
        patientId: 'pac-3',
        patientPhone: '0412 555 0303',
        phoneRegion: null,
      }),
      dueRow({ recallId: 'recall-4', patientId: 'pac-4', patientPhone: null }),
    ];
    repo.dueTotal = 41;
    const page = await list.execute({ pageSize: 4 });
    expect(page.total).toBe(41);
    expect(page.items[0]).toEqual({
      recallId: 'recall-1',
      patientId: 'pac-1',
      patientName: 'Ana Pérez',
      patientPhone: '+58 412 555 0101',
      patientWhatsApp: '584125550101',
      reminderOptedOut: false,
      kind: 'CHECKUP',
      recallTypeId: TYPE_ID.CHECKUP,
      recallTypeName: 'Control',
      intervalMonths: 6,
      baseDate: '2026-04-01',
      dueAt: '2026-10-01',
      daysOverdue: 36,
      locationId: NORTE,
      lastContact: null,
    });
    // Sin apellido no queda un espacio colgando; el número local se lee con la
    // región de la sede (en minúsculas también) y la sede es la del paciente.
    expect(page.items[1]).toMatchObject({
      patientName: 'Luis',
      patientWhatsApp: '584125550202',
      locationId: SUR,
      lastContact: { channel: 'CALL', outcome: 'NO_ANSWER', createdAt: NOW },
    });
    // Un número local sin región de la sede no da un enlace inventado.
    expect(page.items[2]).toMatchObject({
      patientPhone: '0412 555 0303',
      patientWhatsApp: null,
    });
    expect(page.items[3]).toMatchObject({
      patientPhone: null,
      patientWhatsApp: null,
    });
  });

  it('baja de avisos (DX-128): sigue en la lista, pero sin teléfono ni WhatsApp', async () => {
    repo.dueRows = [dueRow({ reminderOptedOut: true })];
    repo.dueTotal = 1;
    const [item] = (await list.execute({})).items;
    expect(item).toMatchObject({
      recallId: 'recall-1',
      reminderOptedOut: true,
      patientPhone: null,
      patientWhatsApp: null,
    });
  });
});

describe('GetPatientRecallsUseCase (DX-015)', () => {
  let repo: InMemoryRecallRepository;
  let get: GetPatientRecallsUseCase;

  beforeEach(() => {
    repo = new InMemoryRecallRepository();
    repo.staffNames.set('dra-lopez', 'Dra. López');
    get = new GetPatientRecallsUseCase(repo, clock);
  });

  it('404 si el paciente no existe (o está archivado), sin leer sus recalls', async () => {
    await expect(get.execute('nadie')).rejects.toThrow(
      new NotFoundException(PATIENT_NOT_FOUND_MESSAGE),
    );
    expect(repo.calls).toEqual(['patientExists']);
  });

  it('sin recalls: listas vacías', async () => {
    repo.patients.add('pac-1');
    await expect(get.execute('pac-1')).resolves.toEqual({
      recalls: [],
      contacts: [],
    });
    expect(repo.patientRecallsCalls).toEqual([
      { patientId: 'pac-1', now: NOW },
    ]);
  });

  it.each<
    [
      string,
      Partial<FakeRecall>,
      FakeAppointment[],
      { status: string; dueAt: string; daysOverdue: number },
    ]
  >([
    // Fijado el 06/05 cada 6 meses: vence justo hoy.
    [
      'vencido hoy',
      { lastDoneAt: '2026-05-06' },
      [],
      { status: 'DUE', dueAt: '2026-11-06', daysOverdue: 0 },
    ],
    [
      'vencido hace días',
      { lastDoneAt: '2026-04-01' },
      [],
      { status: 'DUE', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
    [
      'vence mañana',
      { lastDoneAt: '2026-05-07' },
      [],
      { status: 'UPCOMING', dueAt: '2026-11-07', daysOverdue: -1 },
    ],
    [
      'pausado hasta una fecha futura',
      {
        lastDoneAt: '2026-04-01',
        disabledUntil: '2026-11-07',
        disabledReason: 'Ortodoncia',
      },
      [],
      { status: 'PAUSED', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
    [
      'pausa que ya venció',
      {
        lastDoneAt: '2026-04-01',
        disabledUntil: SEDE_DAY,
        disabledReason: 'Viaje',
      },
      [],
      { status: 'DUE', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
    [
      'retirado',
      { lastDoneAt: '2026-04-01', active: false },
      [],
      { status: 'INACTIVE', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
    [
      'retirado gana a la pausa',
      {
        lastDoneAt: '2026-04-01',
        active: false,
        disabledUntil: '2026-12-01',
        disabledReason: 'Viaje',
      },
      [],
      { status: 'INACTIVE', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
    [
      'vencido con cita futura',
      { lastDoneAt: '2026-04-01' },
      [
        {
          id: 'cita-f',
          patientId: 'pac-1',
          locationId: NORTE,
          day: '2026-11-20',
          status: 'SCHEDULED',
        },
      ],
      { status: 'SCHEDULED', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
    [
      'una cita cancelada no lo agenda',
      { lastDoneAt: '2026-04-01' },
      [
        {
          id: 'cita-c',
          patientId: 'pac-1',
          locationId: NORTE,
          day: '2026-11-20',
          status: 'CANCELLED',
        },
      ],
      { status: 'DUE', dueAt: '2026-10-01', daysOverdue: 36 },
    ],
  ])('estado: %s', async (_label, recall, appointments, expected) => {
    repo.seedRecall({ patientId: 'pac-1', ...recall });
    repo.appointments.push(...appointments);
    const { recalls } = await get.execute('pac-1');
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toMatchObject(expected);
  });

  it.each<[string, string, number, string]>([
    ['31/08 + 6 meses recorta a 28/02', '2026-08-31', 6, '2027-02-28'],
    [
      '31/08 + 6 meses en año bisiesto llega a 29/02',
      '2023-08-31',
      6,
      '2024-02-29',
    ],
    ['29/02 + 12 meses = 28/02', '2024-02-29', 12, '2025-02-28'],
    ['29/02 + 36 meses = 28/02', '2024-02-29', 36, '2027-02-28'],
    ['31/01 + 1 mes = 28/02', '2026-01-31', 1, '2026-02-28'],
    ['31/10 + 1 mes = 30/11', '2026-10-31', 1, '2026-11-30'],
    ['30/11 + 3 meses = 28/02', '2026-11-30', 3, '2027-02-28'],
    ['31/12 + 2 meses en bisiesto = 29/02', '2027-12-31', 2, '2028-02-29'],
  ])(
    'próxima fecha a fin de mes: %s',
    async (_label, lastDoneAt, intervalMonths, dueAt) => {
      repo.seedRecall({ patientId: 'pac-1', lastDoneAt, intervalMonths });
      const [recall] = (await get.execute('pac-1')).recalls;
      expect(recall.baseDate).toBe(lastDoneAt);
      expect(recall.dueAt).toBe(dueAt);
    },
  );

  it('DX-015-bis: una cita atendida ya no mueve la base (solo da la sede del recall)', async () => {
    repo.seedRecall({
      patientId: 'pac-1',
      lastDoneAt: '2026-01-10',
      locationId: NORTE,
    });
    repo.appointments.push({
      id: 'v1',
      patientId: 'pac-1',
      locationId: SUR,
      day: '2026-08-31',
      status: 'COMPLETED',
    });
    const [recall] = (await get.execute('pac-1')).recalls;
    expect(recall).toMatchObject({
      lastDoneAt: '2026-01-10',
      baseDate: '2026-01-10',
      dueAt: '2026-07-10',
      status: 'DUE',
      locationId: SUR,
      recallTypeId: TYPE_ID.CHECKUP,
      recallTypeName: 'Control',
      source: 'MANUAL',
    });
  });

  it('devuelve cada recall con su autor y el historial de contactos; un autor fuera de la clínica sale sin nombre', async () => {
    repo.seedRecall({ patientId: 'pac-1', kind: 'CHECKUP' });
    repo.seedRecall({
      patientId: 'pac-1',
      kind: 'HYGIENE',
      updatedById: 'ex-empleado',
      disabledUntil: '2027-01-01',
      disabledReason: 'Embarazo',
    });
    repo.seedRecall({ patientId: 'otro' });
    const contact: RecallContactView = {
      id: 'c1',
      recallId: 'recall-1',
      kind: 'CHECKUP',
      recallTypeId: TYPE_ID.CHECKUP,
      recallTypeName: 'Control',
      patientId: 'pac-1',
      locationId: NORTE,
      channel: 'CALL',
      outcome: 'NO_ANSWER',
      note: null,
      appointmentId: null,
      author: { id: 'recepcion', fullName: 'Recepción' },
      createdAt: NOW,
    };
    repo.contacts.push(contact);
    const out = await get.execute('pac-1');
    expect(out.contacts).toEqual([contact]);
    expect(out.recalls.map((r) => [r.kind, r.updatedBy])).toEqual([
      ['CHECKUP', { id: 'dra-lopez', fullName: 'Dra. López' }],
      ['HYGIENE', { id: 'ex-empleado', fullName: null }],
    ]);
    expect(out.recalls[1]).toMatchObject({
      disabledUntil: '2027-01-01',
      disabledReason: 'Embarazo',
      status: 'PAUSED',
      updatedAt: NOW,
    });
  });
});

describe('SetPatientRecallUseCase (DX-015)', () => {
  let repo: InMemoryRecallRepository;
  let set: SetPatientRecallUseCase;

  beforeEach(() => {
    repo = new InMemoryRecallRepository();
    repo.patients.add('pac-1');
    set = new SetPatientRecallUseCase(
      repo,
      clock,
      new GetPatientRecallsUseCase(repo, clock),
    );
  });

  it('crea el recall con la fecha de hoy en la sede y activo por defecto, y devuelve la ficha', async () => {
    const out = await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      { intervalMonths: 6 },
      'dra-lopez',
    );
    expect(repo.writeTodayCalls).toEqual([NOW]);
    expect(repo.upserts).toEqual([
      {
        patientId: 'pac-1',
        recallType: {
          id: TYPE_ID.CHECKUP,
          name: 'Control',
          systemKey: 'CHECKUP',
          exclusionGroup: null,
        },
        intervalMonths: 6,
        manualDoneAt: undefined,
        newRecallDoneAt: SEDE_DAY,
        active: true,
        disabledUntil: null,
        disabledReason: null,
        actorId: 'dra-lopez',
        audit: undefined,
      },
    ]);
    // D9: sin exclusión que aplicar, nada desactivado.
    expect(out.recallUpdates).toEqual([]);
    expect(out.recalls).toEqual([
      expect.objectContaining({
        kind: 'CHECKUP',
        lastDoneAt: SEDE_DAY,
        dueAt: '2027-05-06',
        status: 'UPCOMING',
      }),
    ]);
  });

  it('al editar sin fecha, conserva la base fijada (no la reinicia a hoy)', async () => {
    await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      { intervalMonths: 6, lastDoneAt: '2026-02-28' },
      'dra-lopez',
    );
    const out = await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      { intervalMonths: 3 },
      'dr-ruiz',
    );
    expect(repo.upserts[1]).toMatchObject({
      manualDoneAt: undefined,
      newRecallDoneAt: SEDE_DAY,
    });
    expect(out.recalls[0]).toMatchObject({
      intervalMonths: 3,
      lastDoneAt: '2026-02-28',
      dueAt: '2026-05-28',
    });
  });

  it('cambia el mismo recall del tipo (no lo duplica) y puede retirarlo', async () => {
    await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      { intervalMonths: 6 },
      'dra-lopez',
    );
    const out = await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      { intervalMonths: 12, lastDoneAt: '2026-02-28', active: false },
      'dr-ruiz',
    );
    expect(repo.recalls).toHaveLength(1);
    expect(out.recalls[0]).toMatchObject({
      intervalMonths: 12,
      lastDoneAt: '2026-02-28',
      dueAt: '2027-02-28',
      active: false,
      status: 'INACTIVE',
      updatedBy: { id: 'dr-ruiz', fullName: null },
    });
  });

  it.each([0, 37, -6, 6.5, Number.NaN])(
    '400 con el intervalo %p, antes de tocar la BD',
    async (intervalMonths) => {
      await expect(
        set.execute('pac-1', byKey('CHECKUP'), { intervalMonths }, 'dra-lopez'),
      ).rejects.toThrow(new BadRequestException(INTERVAL_RANGE_MESSAGE));
      expect(repo.calls).toEqual([]);
    },
  );

  it.each([1, 36])('acepta los extremos del intervalo (%p)', async (n) => {
    await set.execute(
      'pac-1',
      byKey('HYGIENE'),
      { intervalMonths: n },
      'dra-lopez',
    );
    expect(repo.upserts[0].intervalMonths).toBe(n);
  });

  it('DX-015-bis: el tipo también por su id; uno que no existe en la clínica da 404 sin escribir', async () => {
    await set.execute(
      'pac-1',
      { id: TYPE_ID.HYGIENE },
      { intervalMonths: 6 },
      'dra-lopez',
    );
    expect(repo.upserts[0].recallType).toEqual({
      id: TYPE_ID.HYGIENE,
      name: 'Higiene',
      systemKey: 'HYGIENE',
      exclusionGroup: null,
    });
    await expect(
      set.execute(
        'pac-1',
        { id: 'tipo-de-otra-clinica' },
        { intervalMonths: 6 },
        'dra-lopez',
      ),
    ).rejects.toThrow(new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE));
    expect(repo.upserts).toHaveLength(1);
  });

  it('404 si el paciente no existe, sin escribir', async () => {
    await expect(
      set.execute(
        'nadie',
        byKey('CHECKUP'),
        { intervalMonths: 6 },
        'dra-lopez',
      ),
    ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
    expect(repo.calls).toEqual(['patientExists']);
  });

  it.each(['2026-02-30', '06/11/2026', '2026-13-01', '', '1899-12-31'])(
    '400 con un último control inválido (%p)',
    async (lastDoneAt) => {
      await expect(
        set.execute(
          'pac-1',
          byKey('CHECKUP'),
          { intervalMonths: 6, lastDoneAt },
          'dra-lopez',
        ),
      ).rejects.toThrow(new BadRequestException(LAST_DONE_INVALID_MESSAGE));
      expect(repo.upserts).toEqual([]);
    },
  );

  it('400 con un último control posterior a hoy en la sede; hoy y 1900-01-01 valen', async () => {
    await expect(
      set.execute(
        'pac-1',
        byKey('CHECKUP'),
        { intervalMonths: 6, lastDoneAt: '2026-11-07' },
        'dra-lopez',
      ),
    ).rejects.toThrow(new BadRequestException(LAST_DONE_FUTURE_MESSAGE));
    await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      { intervalMonths: 6, lastDoneAt: SEDE_DAY },
      'dra-lopez',
    );
    await set.execute(
      'pac-1',
      byKey('HYGIENE'),
      { intervalMonths: 6, lastDoneAt: '1900-01-01' },
      'dra-lopez',
    );
    expect(repo.upserts.map((u) => u.manualDoneAt)).toEqual([
      SEDE_DAY,
      '1900-01-01',
    ]);
  });

  it('«hoy» es el de la sede donde se escribe, no el UTC', async () => {
    // A las 22:30 del 6 en Caracas ya es 7 en UTC: el 7 sigue siendo futuro.
    repo.sedeDay = '2026-11-06';
    const late = new SetPatientRecallUseCase(
      repo,
      () => new Date('2026-11-07T02:30:00.000Z'),
      new GetPatientRecallsUseCase(repo, clock),
    );
    await expect(
      late.execute(
        'pac-1',
        byKey('CHECKUP'),
        { intervalMonths: 6, lastDoneAt: '2026-11-07' },
        'dra-lopez',
      ),
    ).rejects.toThrow(LAST_DONE_FUTURE_MESSAGE);
    expect(repo.writeTodayCalls).toEqual([
      new Date('2026-11-07T02:30:00.000Z'),
    ]);
  });

  it('pausa hasta una fecha posterior a hoy con su motivo recortado', async () => {
    await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      {
        intervalMonths: 6,
        disabledUntil: '2026-11-07',
        disabledReason: '  Tratamiento de ortodoncia  ',
      },
      'dra-lopez',
    );
    expect(repo.upserts[0]).toMatchObject({
      disabledUntil: '2026-11-07',
      disabledReason: 'Tratamiento de ortodoncia',
    });
  });

  it.each(['2026-02-30', 'mañana'])(
    '400 con una fecha de reactivación inválida (%p)',
    async (disabledUntil) => {
      await expect(
        set.execute(
          'pac-1',
          byKey('CHECKUP'),
          { intervalMonths: 6, disabledUntil },
          'dra-lopez',
        ),
      ).rejects.toThrow(
        new BadRequestException(DISABLED_UNTIL_INVALID_MESSAGE),
      );
    },
  );

  it.each([SEDE_DAY, '2026-01-01'])(
    '400 si la reactivación no es posterior a hoy (%p)',
    async (disabledUntil) => {
      await expect(
        set.execute(
          'pac-1',
          byKey('CHECKUP'),
          { intervalMonths: 6, disabledUntil },
          'dra-lopez',
        ),
      ).rejects.toThrow(new BadRequestException(DISABLED_UNTIL_PAST_MESSAGE));
      expect(repo.upserts).toEqual([]);
    },
  );

  it('sin fecha (null o vacía) quita la pausa y descarta el motivo; un motivo en blanco es null', async () => {
    for (const input of [
      { disabledUntil: null, disabledReason: 'Viaje' },
      { disabledUntil: '', disabledReason: 'Viaje' },
      { disabledUntil: '2026-12-01', disabledReason: '   ' },
      { disabledUntil: '2026-12-01', disabledReason: null },
    ]) {
      await set.execute(
        'pac-1',
        byKey('CHECKUP'),
        { intervalMonths: 6, ...input },
        'dra-lopez',
      );
    }
    expect(
      repo.upserts.map((u) => [u.disabledUntil, u.disabledReason]),
    ).toEqual([
      [null, null],
      [null, null],
      ['2026-12-01', null],
      ['2026-12-01', null],
    ]);
  });

  it('el motivo admite 120 caracteres (tras recortar) y 121 da 400', async () => {
    await set.execute(
      'pac-1',
      byKey('CHECKUP'),
      {
        intervalMonths: 6,
        disabledUntil: '2026-12-01',
        disabledReason: ` ${'m'.repeat(120)} `,
      },
      'dra-lopez',
    );
    expect(repo.upserts[0].disabledReason).toHaveLength(120);
    await expect(
      set.execute(
        'pac-1',
        byKey('CHECKUP'),
        {
          intervalMonths: 6,
          disabledUntil: '2026-12-01',
          disabledReason: 'm'.repeat(121),
        },
        'dra-lopez',
      ),
    ).rejects.toThrow(
      new BadRequestException(DISABLED_REASON_TOO_LONG_MESSAGE),
    );
    expect(repo.upserts).toHaveLength(1);
  });
});

describe('CreateRecallContactUseCase (DX-015)', () => {
  let repo: InMemoryRecallRepository;
  let recallId: string;

  beforeEach(() => {
    repo = new InMemoryRecallRepository();
    repo.staffNames.set('recepcion', 'Recepción');
    // Recall fijado en Norte; la última visita atendida fue en Sur.
    recallId = repo.seedRecall({ patientId: 'pac-1', locationId: NORTE }).id;
    repo.seedRecall({ patientId: 'pac-2', kind: 'HYGIENE' });
    repo.appointments.push(
      {
        id: 'visita-sur',
        patientId: 'pac-1',
        locationId: SUR,
        day: '2026-03-01',
        status: 'COMPLETED',
      },
      {
        id: 'cita-pac-1',
        patientId: 'pac-1',
        locationId: SUR,
        day: '2026-11-20',
        status: 'SCHEDULED',
      },
      {
        id: 'cita-pac-2',
        patientId: 'pac-2',
        locationId: NORTE,
        day: '2026-11-21',
        status: 'SCHEDULED',
      },
    );
  });

  function build(allowed?: readonly string[]) {
    const { ctx, inRequest } = requestContext(allowed);
    const create = new CreateRecallContactUseCase(repo, ctx);
    return {
      create: (
        id: string,
        input: Parameters<CreateRecallContactUseCase['execute']>[1],
      ) => inRequest(() => create.execute(id, input, 'recepcion')),
    };
  }

  it('registra el contacto con el paciente y la sede del recall (la de su última visita) y la nota recortada', async () => {
    const { create } = build();
    const contact = await create(recallId, {
      channel: 'CALL',
      outcome: 'CALL_BACK',
      note: '  Llamar después de las 5  ',
    });
    expect(contact).toEqual({
      id: 'contact-1',
      recallId,
      kind: 'CHECKUP',
      recallTypeId: TYPE_ID.CHECKUP,
      recallTypeName: 'Control',
      patientId: 'pac-1',
      locationId: SUR,
      channel: 'CALL',
      outcome: 'CALL_BACK',
      note: 'Llamar después de las 5',
      appointmentId: null,
      author: { id: 'recepcion', fullName: 'Recepción' },
      createdAt: NOW,
    });
  });

  it('una nota en blanco o ausente se guarda como null', async () => {
    const { create } = build();
    await create(recallId, {
      channel: 'WHATSAPP_LINK',
      outcome: 'LEFT_MESSAGE',
      note: '   ',
    });
    await create(recallId, {
      channel: 'EMAIL',
      outcome: 'NO_ANSWER',
      note: null,
    });
    await create(recallId, { channel: 'IN_PERSON', outcome: 'WILL_BOOK' });
    expect(repo.contacts.map((c) => c.note)).toEqual([null, null, null]);
  });

  it('la nota admite 280 caracteres (tras recortar) y 281 da 400 sin leer el recall', async () => {
    const { create } = build();
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'NO_ANSWER',
        note: ` ${'n'.repeat(280)} `,
      }),
    ).resolves.toMatchObject({ note: 'n'.repeat(280) });
    repo.calls.length = 0;
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'NO_ANSWER',
        note: 'n'.repeat(281),
      }),
    ).rejects.toThrow(new BadRequestException(NOTE_TOO_LONG_MESSAGE));
    expect(repo.calls).toEqual([]);
  });

  it.each([undefined, null])(
    '«Agendó» sin cita (%p) da 400 sin leer el recall',
    async (appointmentId) => {
      const { create } = build();
      await expect(
        create(recallId, { channel: 'CALL', outcome: 'BOOKED', appointmentId }),
      ).rejects.toThrow(
        new BadRequestException(BOOKED_NEEDS_APPOINTMENT_MESSAGE),
      );
      expect(repo.calls).toEqual([]);
    },
  );

  it('«Agendó» con una cita del MISMO paciente se registra con esa cita', async () => {
    const { create } = build();
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'BOOKED',
        appointmentId: 'cita-pac-1',
      }),
    ).resolves.toMatchObject({
      outcome: 'BOOKED',
      appointmentId: 'cita-pac-1',
      patientId: 'pac-1',
    });
  });

  it('«Agendó» con la cita de OTRO paciente de la clínica da 400 y no escribe', async () => {
    const { create } = build();
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'BOOKED',
        appointmentId: 'cita-pac-2',
      }),
    ).rejects.toThrow(
      new BadRequestException(APPOINTMENT_NOT_OF_PATIENT_MESSAGE),
    );
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'BOOKED',
        appointmentId: 'no-existe',
      }),
    ).rejects.toThrow(APPOINTMENT_NOT_OF_PATIENT_MESSAGE);
    expect(repo.contacts).toEqual([]);
  });

  it('otro desenlace con cita también exige que sea del paciente', async () => {
    const { create } = build();
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'WILL_BOOK',
        appointmentId: 'cita-pac-2',
      }),
    ).rejects.toThrow(APPOINTMENT_NOT_OF_PATIENT_MESSAGE);
    await expect(
      create(recallId, {
        channel: 'CALL',
        outcome: 'WILL_BOOK',
        appointmentId: 'cita-pac-1',
      }),
    ).resolves.toMatchObject({ appointmentId: 'cita-pac-1' });
  });

  it('404 si el recall no existe', async () => {
    const { create } = build();
    await expect(
      create('no-existe', { channel: 'CALL', outcome: 'NO_ANSWER' }),
    ).rejects.toThrow(new NotFoundException(RECALL_NOT_FOUND_MESSAGE));
    expect(repo.calls).toEqual(['findRecall']);
  });

  it('403 por la sede de la última visita (Sur), aunque el recall se fijara en Norte, antes de mirar la cita', async () => {
    const { create } = build([NORTE]);
    const error = await create(recallId, {
      channel: 'CALL',
      outcome: 'BOOKED',
      appointmentId: 'cita-pac-1',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      LOCATION_NOT_ALLOWED_MESSAGE,
    );
    expect(repo.calls).toEqual(['findRecall']);
    expect(repo.contacts).toEqual([]);
  });

  it('un miembro de Sur sí puede; sin sedes permitidas, nadie', async () => {
    await expect(
      build([SUR]).create(recallId, { channel: 'CALL', outcome: 'NO_ANSWER' }),
    ).resolves.toMatchObject({ locationId: SUR });
    await expect(
      build([]).create(recallId, { channel: 'CALL', outcome: 'NO_ANSWER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin visita atendida, manda la sede del recall', async () => {
    const pac2 = repo.recalls.find((r) => r.patientId === 'pac-2');
    if (!pac2) throw new Error('falta el recall de pac-2');
    await expect(
      build([SUR]).create(pac2.id, { channel: 'CALL', outcome: 'NO_ANSWER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      build([NORTE]).create(pac2.id, { channel: 'CALL', outcome: 'NO_ANSWER' }),
    ).resolves.toMatchObject({ kind: 'HYGIENE', locationId: NORTE });
  });
});

describe('ListRecallTypesUseCase (DX-015-bis)', () => {
  it('devuelve los tipos de la clínica tal cual los da el repositorio', async () => {
    const repo = new InMemoryRecallRepository();
    const types = await new ListRecallTypesUseCase(repo).execute();
    expect(types.map((t) => [t.name, t.systemKey])).toEqual([
      ['Higiene', 'HYGIENE'],
      ['Control', 'CHECKUP'],
    ]);
    expect(repo.calls).toEqual(['listTypes']);
  });
});

describe('ListUnconfiguredRecallsUseCase (DX-015-bis, D17)', () => {
  const row = (
    data: Partial<RecallUnconfiguredRow> = {},
  ): RecallUnconfiguredRow => ({
    patientId: 'pac-1',
    patientFirstName: 'María',
    patientLastName: 'Rondón',
    patientPhone: '+58 412 555 0101',
    phoneRegion: 'VE',
    reminderOptedOut: false,
    lastVisitAt: '2026-10-20',
    lastVisitLocationId: NORTE,
    ...data,
  });

  it('sin parámetros: página 1 de 20, sin sede de la query y el reloj inyectado', async () => {
    const repo = new InMemoryRecallRepository();
    const { ctx, inRequest } = requestContext();
    const page = await inRequest(() =>
      new ListUnconfiguredRecallsUseCase(repo, clock, ctx).execute({}),
    );
    expect(repo.unconfiguredQueries).toEqual([
      { locationId: undefined, page: 1, pageSize: 20, now: NOW },
    ]);
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('acota la paginación como la lista de vencidos', async () => {
    const repo = new InMemoryRecallRepository();
    const { ctx, inRequest } = requestContext();
    const page = await inRequest(() =>
      new ListUnconfiguredRecallsUseCase(repo, clock, ctx).execute({
        page: 0,
        pageSize: 500,
      }),
    );
    expect(repo.unconfiguredQueries[0]).toMatchObject({
      page: 1,
      pageSize: 100,
    });
    expect(page).toMatchObject({ page: 1, pageSize: 100 });
  });

  it('nombre, teléfono y WhatsApp con la región de la sede; con baja de avisos, sin contacto', async () => {
    const repo = new InMemoryRecallRepository();
    repo.unconfiguredRows = [
      row(),
      row({
        patientId: 'pac-2',
        patientFirstName: 'José',
        patientLastName: 'Guédez',
        reminderOptedOut: true,
      }),
    ];
    repo.unconfiguredTotal = 2;
    const { ctx, inRequest } = requestContext();
    const page = await inRequest(() =>
      new ListUnconfiguredRecallsUseCase(repo, clock, ctx).execute({}),
    );
    expect(page.total).toBe(2);
    expect(page.items).toEqual([
      {
        patientId: 'pac-1',
        patientName: 'María Rondón',
        patientPhone: '+58 412 555 0101',
        patientWhatsApp: '584125550101',
        reminderOptedOut: false,
        lastVisitAt: '2026-10-20',
        lastVisitLocationId: NORTE,
      },
      {
        patientId: 'pac-2',
        patientName: 'José Guédez',
        patientPhone: null,
        patientWhatsApp: null,
        reminderOptedOut: true,
        lastVisitAt: '2026-10-20',
        lastVisitLocationId: NORTE,
      },
    ]);
  });

  it('locationId de una sede permitida pasa al repositorio; de otra, 403 sin consultar', async () => {
    const repo = new InMemoryRecallRepository();
    const { ctx, inRequest } = requestContext([NORTE]);
    const list = new ListUnconfiguredRecallsUseCase(repo, clock, ctx);
    await inRequest(() => list.execute({ locationId: NORTE }));
    expect(repo.unconfiguredQueries[0]).toMatchObject({ locationId: NORTE });
    await expect(
      inRequest(() => list.execute({ locationId: SUR })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.unconfiguredQueries).toHaveLength(1);
  });
});

describe('CreateDefaultRecallUseCase (DX-015-bis, D15)', () => {
  it('paciente inexistente: 404 sin tocar nada', async () => {
    const repo = new InMemoryRecallRepository();
    const create = new CreateDefaultRecallUseCase(
      repo,
      clock,
      new GetPatientRecallsUseCase(repo, clock),
    );
    await expect(
      create.execute('pac-x', TYPE_ID.HYGIENE, 'recepcion-1'),
    ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
    expect(repo.calls).toEqual(['patientExists']);
  });

  it('crea con el reloj inyectado y responde como el PUT: la ficha y lo que desactivó la exclusión', async () => {
    const repo = new InMemoryRecallRepository();
    repo.patients.add('pac-1');
    const excluded: RecallExclusionUpdate = {
      recallId: 'recall-perio',
      recallTypeId: 'tipo-perio',
      recallTypeName: 'Mantenimiento periodontal',
      dueAt: '2027-01-10',
      deactivated: true,
      replacedBy: { recallTypeId: TYPE_ID.HYGIENE, recallTypeName: 'Higiene' },
    };
    repo.nextExcluded = [excluded];
    const result = await new CreateDefaultRecallUseCase(
      repo,
      clock,
      new GetPatientRecallsUseCase(repo, clock),
    ).execute('pac-1', TYPE_ID.HYGIENE, 'recepcion-1');
    expect(repo.defaultCreates).toEqual([
      {
        patientId: 'pac-1',
        recallTypeId: TYPE_ID.HYGIENE,
        now: NOW,
        actorId: 'recepcion-1',
      },
    ]);
    expect(repo.calls.slice(0, 3)).toEqual([
      'patientExists',
      'createDefaultRecall',
      'patientExists',
    ]);
    expect(result.recalls.map((r) => r.recallTypeId)).toEqual([
      TYPE_ID.HYGIENE,
    ]);
    expect(result.recallUpdates).toEqual([excluded]);
  });

  it('desde la salida pasa la cita que se despide al repositorio', async () => {
    const repo = new InMemoryRecallRepository();
    repo.patients.add('pac-2');
    await new CreateDefaultRecallUseCase(
      repo,
      clock,
      new GetPatientRecallsUseCase(repo, clock),
    ).execute('pac-2', TYPE_ID.CHECKUP, 'recepcion-1', undefined, 'cita-hoy');
    expect(repo.defaultCreates).toEqual([
      expect.objectContaining({
        patientId: 'pac-2',
        appointmentId: 'cita-hoy',
      }),
    ]);
  });
});
