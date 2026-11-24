import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type {
  RetentionFactsGroup,
  RetentionPatientRow,
  RetentionQuery,
  RetentionRepository,
} from '../../domain/ports/retention-repository.port';
import type { RetentionFacts } from '../../domain/retention';
import {
  GetRetentionUseCase,
  RETENTION_LOCATION_NOT_FOUND_MESSAGE,
  RETENTION_PERIOD_TOO_LONG_MESSAGE,
  retentionPeriod,
} from './get-retention.use-case';

const NORTE = '00000000-0000-4000-8000-00000000a001';
const SUR = '00000000-0000-4000-8000-00000000a002';
const DRA = '00000000-0000-4000-8000-00000000d001';
const NOW = new Date('2026-07-15T15:00:00Z');

const facts = (over: Partial<RetentionFacts>): RetentionFacts => ({
  activeAtStart: false,
  activeWindowAtEnd: false,
  seenBefore: false,
  seenInPeriod: false,
  upcoming: false,
  returnedWithinDays: false,
  ...over,
});

function fakeRepo(over: Partial<RetentionRepository> = {}) {
  const calls: RetentionQuery[] = [];
  const repo: RetentionRepository = {
    listLocations: jest.fn((allowed) =>
      Promise.resolve(
        [
          { id: NORTE, name: 'Sede Norte', isActive: true },
          { id: SUR, name: 'Sede Sur', isActive: true },
        ].filter((l) => allowed === 'ALL' || allowed.includes(l.id)),
      ),
    ),
    locationInClinic: jest.fn((id) =>
      Promise.resolve(id === NORTE || id === SUR),
    ),
    listProfessionals: jest.fn(() =>
      Promise.resolve([{ userId: DRA, fullName: 'Dra. Pérez' }]),
    ),
    locationZones: jest.fn(() =>
      Promise.resolve(
        new Map([
          [NORTE, 'America/Caracas'],
          [SUR, 'America/Caracas'],
        ]),
      ),
    ),
    factGroups: jest.fn((q) => {
      calls.push(q);
      const group = (
        locationId: string,
        f: Partial<RetentionFacts>,
        count: number,
      ): RetentionFactsGroup => ({
        locationId,
        locationName: locationId === NORTE ? 'Sede Norte' : 'Sede Sur',
        providerId: DRA,
        providerName: null,
        facts: facts(f),
        count,
      });
      return Promise.resolve([
        group(
          NORTE,
          { activeAtStart: true, seenBefore: true, activeWindowAtEnd: true },
          8,
        ),
        group(NORTE, { activeAtStart: true, seenBefore: true }, 2),
        group(SUR, { seenInPeriod: true, activeWindowAtEnd: true }, 3),
      ]);
    }),
    listPatients: jest.fn((q) => {
      calls.push(q);
      const row: RetentionPatientRow = {
        patientId: 'p1',
        patientName: 'Ana Rondón',
        phone: '0412 555 0101',
        phoneRegion: 'VE',
        reminderOptedOut: false,
        firstVisitAt: new Date('2026-02-02T14:00:00Z'),
        lastVisitAt: new Date('2026-02-02T14:00:00Z'),
        locationId: NORTE,
        locationName: 'Sede Norte',
        providerId: DRA,
        providerName: 'Dra. Pérez',
        hasUpcomingAppointment: false,
      };
      return Promise.resolve({
        items: [row, { ...row, patientId: 'p2', reminderOptedOut: true }],
        total: 2,
      });
    }),
    ...over,
  };
  return { repo, calls };
}

describe('GetRetentionUseCase (DX-260)', () => {
  const base = {
    from: '2026-01-01',
    to: '2026-06-30',
    allowedLocationIds: 'ALL' as const,
  };

  it('suma por sede y profesional, subtotal por sede y total con la retención de la fórmula', async () => {
    const { repo, calls } = fakeRepo();
    const report = await new GetRetentionUseCase(repo, () => NOW).execute(base);
    expect(report.totals).toEqual({
      activeAtStart: 10,
      newPatients: 3,
      lost: 2,
      activeAtEnd: 11,
      reactivated: 0,
      newNoReturn: 3,
      retentionRate: 80,
    });
    expect(report.rows.map((r) => [r.locationId, r.retentionRate])).toEqual([
      [NORTE, 80],
      [SUR, null],
    ]);
    // Sin nombre legible: «Profesional sin nombre».
    expect(report.rows[0].providerName).toBe('Profesional sin nombre');
    expect(report.locations.map((l) => l.locationId)).toEqual([NORTE, SUR]);
    expect(report.filters.activeMonths).toBe(18);
    expect(report.hasData).toBe(true);
    expect(calls[0].now).toBe(NOW);
    expect(calls[0].locationIds).toEqual([NORTE, SUR]);
    expect(calls[0].bounds.map((b) => b.locationId).sort()).toEqual(
      [NORTE, SUR].sort(),
    );
  });

  it('una sede que no es de la clínica es 404 (sin mirar las permitidas); una de la clínica no permitida, 403', async () => {
    const { repo } = fakeRepo();
    const useCase = new GetRetentionUseCase(repo, () => NOW);
    await expect(
      useCase.execute({
        ...base,
        locationId: '00000000-0000-4000-8000-00000000ffff',
      }),
    ).rejects.toThrow(
      new NotFoundException(RETENTION_LOCATION_NOT_FOUND_MESSAGE),
    );
    await expect(
      useCase.execute({
        ...base,
        locationId: SUR,
        allowedLocationIds: [NORTE],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('con una sede, solo esa; con sedes permitidas, solo ellas', async () => {
    const { repo, calls } = fakeRepo();
    const useCase = new GetRetentionUseCase(repo, () => NOW);
    await useCase.execute({ ...base, locationId: SUR });
    await useCase.execute({ ...base, allowedLocationIds: [NORTE] });
    expect(calls.map((c) => c.locationIds)).toEqual([[SUR], [NORTE]]);
  });

  it('la lista: wa.me con la región de la sede; con baja de avisos, null', async () => {
    const { repo } = fakeRepo();
    const list = await new GetRetentionUseCase(repo, () => NOW).patients({
      ...base,
      segment: 'new',
    });
    expect(list.items.map((i) => [i.patientId, i.whatsApp])).toEqual([
      ['p1', '584125550101'],
      ['p2', null],
    ]);
    expect(list.items[0].timeZone).toBe('America/Caracas');
    expect(list.definition.key).toBe('newPatients');
    expect(list).toMatchObject({ total: 2, page: 1, pageSize: 25 });
  });

  it('período: fechas válidas y como mucho 12 meses por calendario', () => {
    expect(retentionPeriod('2026-01-01', '2026-12-31')).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(() => retentionPeriod('2026-01-01', '2027-01-01')).toThrow(
      new BadRequestException(RETENTION_PERIOD_TOO_LONG_MESSAGE),
    );
    expect(() => retentionPeriod('2026-06-30', '2026-01-01')).toThrow(
      BadRequestException,
    );
    expect(() => retentionPeriod('2026-02-30', '2026-03-01')).toThrow(
      BadRequestException,
    );
  });
});
