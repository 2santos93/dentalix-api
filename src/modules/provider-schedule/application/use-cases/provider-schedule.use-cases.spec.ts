import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { InMemoryProviderScheduleRepository } from '../__fixtures__/in-memory-provider-schedule.repository';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  DeleteProviderOverrideUseCase,
  GetProviderScheduleUseCase,
  GetScheduleRosterUseCase,
  ListProviderOverridesUseCase,
  ReplaceProviderScheduleUseCase,
  SetProviderOverrideUseCase,
} from './provider-schedule.use-cases';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';
const H = (h: number) => h * 60;
// Martes 20-10-2026, 12:00 en Bogotá.
const NOW = new Date('2026-10-20T17:00:00.000Z');

const CTX: AuditRequestContext = {
  tenantId: 't',
  locationId: null,
  actor: { userId: 'admin', role: ClinicRole.ADMIN },
  requestId: null,
  ip: null,
  userAgent: null,
};

function makeLocations(): LocationRepository {
  const all = [
    { id: A, name: 'Sede A', timeZone: 'America/Bogota', isActive: true },
    { id: B, name: 'Sede B', timeZone: 'America/Bogota', isActive: true },
    {
      id: OFF,
      name: 'Sede Cerrada',
      timeZone: 'America/Bogota',
      isActive: false,
    },
  ];
  return {
    list: () => Promise.resolve(all),
    findById: (id: string) =>
      Promise.resolve(all.find((l) => l.id === id) ?? null),
  } as unknown as LocationRepository;
}

function makeStaff(): StaffRepository {
  const members = [
    { userId: 'dra-x', fullName: 'Dra. X', role: ClinicRole.DENTIST },
    { userId: 'admin', fullName: 'Admin', role: ClinicRole.ADMIN },
    { userId: 'rec', fullName: 'Recepción', role: ClinicRole.RECEPTION },
  ];
  return {
    findById: (id: string) =>
      Promise.resolve(members.find((m) => m.userId === id) ?? null),
    listActive: () => Promise.resolve(members),
  } as unknown as StaffRepository;
}

const DRA_X = {
  locations: [
    {
      locationId: A,
      ranges: [
        { weekday: 1, startMinute: H(8), endMinute: H(13) },
        { weekday: 3, startMinute: H(8), endMinute: H(13) },
      ],
    },
    {
      locationId: B,
      ranges: [{ weekday: 4, startMinute: H(14), endMinute: H(19) }],
    },
  ],
};

describe('horario de los profesionales (DX-233)', () => {
  let repo: InMemoryProviderScheduleRepository;
  let audits: AuditEventDraft[];
  let replace: ReplaceProviderScheduleUseCase;
  let setOverride: SetProviderOverrideUseCase;
  let removeOverride: DeleteProviderOverrideUseCase;
  let roster: GetScheduleRosterUseCase;

  beforeEach(() => {
    repo = new InMemoryProviderScheduleRepository();
    audits = [];
    const audit = {
      record: (d: AuditEventDraft) => {
        audits.push(d);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase;
    const clock = () => NOW;
    replace = new ReplaceProviderScheduleUseCase(
      repo,
      makeStaff(),
      makeLocations(),
      audit,
      clock,
    );
    setOverride = new SetProviderOverrideUseCase(
      repo,
      makeStaff(),
      makeLocations(),
      audit,
      clock,
    );
    removeOverride = new DeleteProviderOverrideUseCase(
      repo,
      makeStaff(),
      audit,
    );
    roster = new GetScheduleRosterUseCase(
      repo,
      makeStaff(),
      makeLocations(),
      new TenantContextService(),
    );
  });

  describe('PUT del semanal', () => {
    it('guarda la rotación y la audita con antes y después', async () => {
      const view = await replace.execute('dra-x', DRA_X, CTX);
      expect(view.configured).toBe(true);
      expect(view.locations.map((l) => l.locationName)).toEqual([
        'Sede A',
        'Sede B',
      ]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'PROVIDER_SCHEDULE',
        resourceId: 'dra-x',
        metadata: {
          reason: 'PROVIDER_SCHEDULE_REPLACED',
          scheduleChange: { before: [] },
        },
      });
      expect(audits[0].metadata.scheduleChange?.after).toHaveLength(3);

      // Segundo guardado: el «antes» es la rotación anterior.
      await replace.execute('dra-x', { locations: [DRA_X.locations[0]] }, CTX);
      expect(audits[1].metadata.scheduleChange?.before).toHaveLength(3);
      expect(audits[1].metadata.scheduleChange?.after).toHaveLength(2);
    });

    it('rechaza (400, en español) el mismo día en dos sedes solapado', async () => {
      await expect(
        replace.execute(
          'dra-x',
          {
            locations: [
              DRA_X.locations[0],
              {
                locationId: B,
                ranges: [{ weekday: 1, startMinute: H(12), endMinute: H(15) }],
              },
            ],
          },
          CTX,
        ),
      ).rejects.toThrow(
        'El tramo 08:00–13:00 en Sede A se solapa el lunes con 12:00–15:00 en Sede B: un profesional no puede estar en dos sedes a la vez.',
      );
      expect(audits).toHaveLength(0);
    });

    it('sede sin tramos no se guarda; lista vacía deja al profesional sin horario', async () => {
      const view = await replace.execute(
        'dra-x',
        { locations: [{ locationId: A, ranges: [] }] },
        CTX,
      );
      expect(view).toEqual({
        providerId: 'dra-x',
        configured: false,
        locations: [],
      });
    });

    it('404 si no es miembro; 400 si no atiende; 400 con una sede desactivada', async () => {
      await expect(replace.execute('nadie', DRA_X, CTX)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(replace.execute('rec', DRA_X, CTX)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        replace.execute(
          'dra-x',
          {
            locations: [
              {
                locationId: OFF,
                ranges: [{ weekday: 1, startMinute: H(8), endMinute: H(9) }],
              },
            ],
          },
          CTX,
        ),
      ).rejects.toThrow(/desactivada/);
    });

    it('no deja que el semanal nuevo pise una excepción de otra sede', async () => {
      await replace.execute('dra-x', DRA_X, CTX);
      // Jueves 22: excepción en A de 9 a 12.
      await setOverride.execute(
        'dra-x',
        {
          locationId: A,
          date: '2026-10-22',
          ranges: [{ startMinute: H(9), endMinute: H(12) }],
        },
        CTX,
      );
      // Ahora quiere los jueves en B desde las 10: choca el 22 con la excepción.
      await expect(
        replace.execute(
          'dra-x',
          {
            locations: [
              DRA_X.locations[0],
              {
                locationId: B,
                ranges: [{ weekday: 4, startMinute: H(10), endMinute: H(19) }],
              },
            ],
          },
          CTX,
        ),
      ).rejects.toThrow(/2026-10-22.*dos sedes a la vez/);
    });
  });

  describe('excepciones', () => {
    beforeEach(() => replace.execute('dra-x', DRA_X, CTX));

    it('«no trabaja» el jueves en B: se guarda, se audita y se puede quitar', async () => {
      const created = await setOverride.execute(
        'dra-x',
        { locationId: B, date: '2026-10-22', ranges: [] },
        CTX,
      );
      expect(created).toMatchObject({
        off: true,
        replaced: false,
        locationName: 'Sede B',
      });
      expect(audits.at(-1)).toMatchObject({
        action: 'CREATE',
        metadata: {
          reason: 'PROVIDER_SCHEDULE_OVERRIDE_SET',
          scheduleChange: {
            before: [],
            after: [{ locationId: B, date: '2026-10-22', off: true }],
          },
        },
      });

      // Reemplazo por un horario distinto ese día.
      const replaced = await setOverride.execute(
        'dra-x',
        {
          locationId: B,
          date: '2026-10-22',
          ranges: [{ startMinute: H(9), endMinute: H(12) }],
        },
        CTX,
      );
      expect(replaced).toMatchObject({ off: false, replaced: true });
      expect(audits.at(-1)?.action).toBe('UPDATE');

      await removeOverride.execute('dra-x', replaced.id, CTX);
      expect(audits.at(-1)).toMatchObject({
        action: 'DELETE',
        metadata: { reason: 'PROVIDER_SCHEDULE_OVERRIDE_DELETED' },
      });
      await expect(
        removeOverride.execute('dra-x', replaced.id, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ventana: ni un día pasado ni más allá de dos años', async () => {
      await expect(
        setOverride.execute(
          'dra-x',
          { locationId: B, date: '2026-10-19', ranges: [] },
          CTX,
        ),
      ).rejects.toThrow(/ya pasó/);
      await expect(
        setOverride.execute(
          'dra-x',
          { locationId: B, date: '2028-10-21', ranges: [] },
          CTX,
        ),
      ).rejects.toThrow(/próximos dos años/);
      await expect(
        setOverride.execute(
          'dra-x',
          { locationId: B, date: '2026-02-30', ranges: [] },
          CTX,
        ),
      ).rejects.toThrow(/días reales/);
      // Hoy sí vale.
      await expect(
        setOverride.execute(
          'dra-x',
          { locationId: B, date: '2026-10-20', ranges: [] },
          CTX,
        ),
      ).resolves.toMatchObject({ date: '2026-10-20' });
    });

    it('una excepción que pisa lo que tiene ese día en otra sede es 400', async () => {
      // Lunes 26: en A tiene 8–13 (semanal). Excepción en B 12–14: choca.
      await expect(
        setOverride.execute(
          'dra-x',
          {
            locationId: B,
            date: '2026-10-26',
            ranges: [{ startMinute: H(12), endMinute: H(14) }],
          },
          CTX,
        ),
      ).rejects.toThrow(
        'El tramo 12:00–14:00 en Sede B se solapa el 2026-10-26 con 08:00–13:00 en Sede A: un profesional no puede estar en dos sedes a la vez.',
      );
    });
  });

  describe('cuadrante', () => {
    it('muestra la rotación por día con la sede y si trabaja en la sede pedida', async () => {
      await replace.execute('dra-x', DRA_X, CTX);
      await setOverride.execute(
        'dra-x',
        { locationId: B, date: '2026-10-22', ranges: [] },
        CTX,
      );
      const view = await roster.execute({
        weekStart: '2026-10-19',
        locationId: B,
      });
      expect(view).toMatchObject({
        from: '2026-10-19',
        to: '2026-10-25',
        locationId: B,
      });
      // Solo quienes atienden (DENTIST y ADMIN), no recepción.
      expect(view.providers.map((p) => p.providerId)).toEqual([
        'dra-x',
        'admin',
      ]);
      const x = view.providers[0];
      expect(x.days[0]).toMatchObject({
        date: '2026-10-19',
        weekday: 1,
        unrestricted: false,
        worksAtLocation: false,
        locationRanges: [],
        assignments: [
          {
            locationId: A,
            source: 'WEEKLY',
            ranges: [{ startMinute: H(8), endMinute: H(13) }],
          },
        ],
      });
      // Jueves 22: «no trabaja» en B por la excepción.
      expect(x.days[3]).toMatchObject({
        worksAtLocation: false,
        assignments: [{ locationId: B, source: 'OVERRIDE', ranges: [] }],
      });
      // El admin no tiene horario: sin restricción.
      expect(view.providers[1].days[0]).toMatchObject({
        unrestricted: true,
        worksAtLocation: true,
        locationRanges: null,
        assignments: [],
      });
    });

    it('rango de días para la agenda y validación', async () => {
      const day = await roster.execute({ weekStart: '2026-10-22', days: 1 });
      expect(day.providers[0].days).toHaveLength(1);
      expect(day.providers[0].days[0].worksAtLocation).toBeNull();
      await expect(
        roster.execute({ weekStart: '2026-10-19', days: 32 }),
      ).rejects.toThrow(/de 1 a 31 días/);
      await expect(
        roster.execute({ weekStart: '2026-10-19', locationId: 'otra' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

// DX-089: sedes permitidas de cada miembro (`membership_locations`).
describe('horario de los profesionales y sedes permitidas (DX-233 × DX-089)', () => {
  // La Dra. Y solo atiende en la sede A; el Dr. Z, sin restricción.
  const members = [
    {
      userId: 'dra-y',
      fullName: 'Dra. Y',
      role: ClinicRole.DENTIST,
      locationIds: [A],
    },
    {
      userId: 'dr-z',
      fullName: 'Dr. Z',
      role: ClinicRole.DENTIST,
      locationIds: null,
    },
  ];
  const staff = {
    findById: (id: string) =>
      Promise.resolve(members.find((m) => m.userId === id) ?? null),
    listActive: () => Promise.resolve(members),
  } as unknown as StaffRepository;
  const audit = {
    record: () => Promise.resolve(),
  } as unknown as RecordAuditEventUseCase;
  const clock = () => NOW;
  const tenantContext = new TenantContextService();
  /** Lo que haría un miembro acotado a `allowed` (claim `loc`). */
  const as = <T>(allowed: string[], fn: () => Promise<T>) =>
    tenantContext.run('t', undefined, fn, allowed);
  const thursdayAt = (locationId: string) => ({
    locationId,
    ranges: [{ weekday: 4, startMinute: H(8), endMinute: H(12) }],
  });

  let repo: InMemoryProviderScheduleRepository;
  let replace: ReplaceProviderScheduleUseCase;
  let setOverride: SetProviderOverrideUseCase;
  let getSchedule: GetProviderScheduleUseCase;
  let listOverrides: ListProviderOverridesUseCase;
  let roster: GetScheduleRosterUseCase;

  beforeEach(() => {
    repo = new InMemoryProviderScheduleRepository();
    const locations = makeLocations();
    replace = new ReplaceProviderScheduleUseCase(
      repo,
      staff,
      locations,
      audit,
      clock,
    );
    setOverride = new SetProviderOverrideUseCase(
      repo,
      staff,
      locations,
      audit,
      clock,
    );
    getSchedule = new GetProviderScheduleUseCase(
      repo,
      staff,
      locations,
      clock,
      tenantContext,
    );
    listOverrides = new ListProviderOverridesUseCase(
      repo,
      staff,
      locations,
      clock,
      tenantContext,
    );
    roster = new GetScheduleRosterUseCase(
      repo,
      staff,
      locations,
      tenantContext,
    );
  });

  it('no se le pone horario semanal en una sede que no tiene permitida (400, español)', async () => {
    await expect(
      replace.execute(
        'dra-y',
        {
          locations: [
            { locationId: A, ranges: [] },
            {
              locationId: B,
              ranges: [{ weekday: 1, startMinute: H(8), endMinute: H(12) }],
            },
          ],
        },
        CTX,
      ),
    ).rejects.toThrow(
      'Dra. Y no atiende en Sede B: solo se le puede poner horario en las sedes que tiene permitidas en Personal.',
    );
    await expect(
      replace.execute('dra-y', { locations: [thursdayAt(B)] }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.weekly.get('dra-y')).toBeUndefined();
    // En su sede, sí; y una sede ajena SIN tramos (quitarla) no molesta.
    const view = await replace.execute(
      'dra-y',
      { locations: [thursdayAt(A), { locationId: B, ranges: [] }] },
      CTX,
    );
    expect(view.locations.map((l) => l.locationId)).toEqual([A]);
    // Sin restricción, en cualquiera.
    await expect(
      replace.execute('dr-z', { locations: [thursdayAt(B)] }, CTX),
    ).resolves.toMatchObject({ configured: true });
  });

  it('ni una excepción (tampoco «no trabaja») en una sede que no tiene permitida', async () => {
    for (const ranges of [[{ startMinute: H(9), endMinute: H(12) }], []]) {
      await expect(
        setOverride.execute(
          'dra-y',
          { locationId: B, date: '2026-10-22', ranges },
          CTX,
        ),
      ).rejects.toThrow(
        'Dra. Y no atiende en Sede B: solo se le puede poner horario en las sedes que tiene permitidas en Personal.',
      );
    }
    expect(repo.overrides.get('dra-y')).toBeUndefined();
    await expect(
      setOverride.execute(
        'dra-y',
        { locationId: A, date: '2026-10-22', ranges: [] },
        CTX,
      ),
    ).resolves.toMatchObject({ locationId: A, off: true });
  });

  it('el cuadrante de un miembro acotado solo enseña sus sedes y a quien atiende en ellas', async () => {
    await replace.execute('dra-y', { locations: [thursdayAt(A)] }, CTX);
    await replace.execute(
      'dr-z',
      {
        locations: [
          {
            locationId: A,
            ranges: [{ weekday: 1, startMinute: H(8), endMinute: H(12) }],
          },
          thursdayAt(B),
        ],
      },
      CTX,
    );
    // Acotado a B: pedir la sede A es 403, como la agenda.
    await expect(
      as([B], () => roster.execute({ weekStart: '2026-10-19', locationId: A })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const view = await as([B], () =>
      roster.execute({ weekStart: '2026-10-19' }),
    );
    expect(view.locations.map((l) => l.id)).toEqual([B]);
    // La Dra. Y no atiende en B: no sale.
    expect(view.providers.map((p) => p.providerId)).toEqual(['dr-z']);
    const z = view.providers[0];
    // Lunes: el Dr. Z está en A, que el acotado no ve.
    expect(z.days[0]).toMatchObject({ unrestricted: false, assignments: [] });
    expect(z.days[3].assignments).toEqual([
      expect.objectContaining({ locationId: B, source: 'WEEKLY' }),
    ]);

    // Sin restricción ve todo.
    const all = await roster.execute({ weekStart: '2026-10-19' });
    expect(all.locations.map((l) => l.id)).toEqual([A, B, OFF]);
    expect(all.providers.map((p) => p.providerId)).toEqual(['dra-y', 'dr-z']);
  });

  it('en una sede donde el profesional no atiende, el cuadrante dice que no trabaja allí', async () => {
    // Sin horario, pero acotada a A: en B no se la puede citar (DX-121d).
    const view = await roster.execute({
      weekStart: '2026-10-19',
      days: 1,
      locationId: B,
    });
    const y = view.providers.find((p) => p.providerId === 'dra-y')!;
    expect(y.days[0]).toMatchObject({
      worksAtLocation: false,
      locationRanges: [],
    });
    const z = view.providers.find((p) => p.providerId === 'dr-z')!;
    expect(z.days[0]).toMatchObject({
      worksAtLocation: true,
      locationRanges: null,
    });
  });

  it('el horario y las excepciones que lee un miembro acotado son solo de sus sedes', async () => {
    await replace.execute(
      'dr-z',
      {
        locations: [
          thursdayAt(A),
          {
            ...thursdayAt(B),
            ranges: [{ weekday: 2, startMinute: H(8), endMinute: H(12) }],
          },
        ],
      },
      CTX,
    );
    await setOverride.execute(
      'dr-z',
      { locationId: A, date: '2026-10-22', ranges: [] },
      CTX,
    );
    await setOverride.execute(
      'dr-z',
      { locationId: B, date: '2026-10-27', ranges: [] },
      CTX,
    );
    const mine = await as([B], () => getSchedule.execute('dr-z'));
    expect(mine.locations.map((l) => l.locationId)).toEqual([B]);
    expect(mine.configured).toBe(true);
    const overrides = await as([B], () => listOverrides.execute('dr-z', {}));
    expect(overrides.map((o) => o.locationId)).toEqual([B]);

    expect(
      (await getSchedule.execute('dr-z')).locations.map((l) => l.locationId),
    ).toEqual([A, B]);
    expect(await listOverrides.execute('dr-z', {})).toHaveLength(2);
  });
});
