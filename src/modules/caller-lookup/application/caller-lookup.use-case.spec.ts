import { BadRequestException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { CallerLookupUseCase } from './caller-lookup.use-case';
import type {
  CallerLookupRepository,
  CallerMatch,
  CallerNextAppointment,
  CallerVisitRef,
} from '../domain/caller-lookup-repository.port';
import type {
  PatientBalanceFlags,
  PatientBalanceView,
} from '../../collections/application/patient-balance-flags';
import type { PatientMedicalAlertFlags } from '../../medical-history/application/patient-medical-alert-flags';
import type { MedicalAlertFlags } from '../../medical-history/domain/medical-alert-flags';

const NOW = new Date('2026-11-04T15:00:00.000Z');
const ANA = '11111111-1111-4111-8111-111111111111';
const LUIS = '22222222-2222-4222-8222-222222222222';
const CCS = {
  locationId: 'loc-ccs',
  locationName: 'Caracas',
  timeZone: 'America/Caracas',
};

class FakeRepo implements CallerLookupRepository {
  region: string | null = 'VE';
  seen: string[][] = [];
  matches: CallerMatch[] = [];
  truncated = false;
  next = new Map<string, CallerNextAppointment>();
  last = new Map<string, CallerVisitRef>();
  defaultPhoneRegion() {
    return Promise.resolve(this.region);
  }
  findByPhoneE164(e164s: readonly string[]) {
    this.seen.push([...e164s]);
    return Promise.resolve({
      matches: this.matches,
      truncated: this.truncated,
    });
  }
  nextAppointments() {
    return Promise.resolve(this.next);
  }
  lastVisits() {
    return Promise.resolve(this.last);
  }
}

const noBalance: PatientBalanceView = {
  overdue: { hasOverdue: false, overdueDays: null },
  pending: [],
};

function build(repo: FakeRepo, over: Partial<PatientBalanceView> = {}) {
  const alertCalls: string[][] = [];
  const balances = {
    viewsForPatients: (ids: string[]) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { ...noBalance, ...over }])),
      ),
  } as unknown as PatientBalanceFlags;
  const alerts = {
    todayInSede: () =>
      Promise.resolve({ date: '2026-11-04', timeZone: 'America/Caracas' }),
    forPatients: (ids: string[]) => {
      alertCalls.push(ids);
      return Promise.resolve(
        new Map(
          ids.map((id) => [
            id,
            { hasCriticalAlert: id === ANA } as MedicalAlertFlags,
          ]),
        ),
      );
    },
  } as unknown as PatientMedicalAlertFlags;
  return {
    useCase: new CallerLookupUseCase(repo, balances, alerts, () => NOW),
    alertCalls,
  };
}

describe('CallerLookupUseCase (DX-224)', () => {
  it('menos de 7 dígitos: 400 «Escribe el número completo», sin tocar la BD', async () => {
    const repo = new FakeRepo();
    const { useCase } = build(repo);
    const error = await useCase
      .execute('412 123', ClinicRole.ADMIN)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'CALLER_PHONE_TOO_SHORT',
      message: 'Escribe el número completo',
    });
    expect(repo.seen).toEqual([]);
  });

  it.each([
    '0412-123.45.67',
    '412 1234567',
    '+58 412 1234567',
    '(0412) 1234567',
  ])('«%s» busca el E.164 completo de la sede (+58)', async (text) => {
    const repo = new FakeRepo();
    const { useCase } = build(repo);
    await useCase.execute(text, ClinicRole.RECEPTION);
    expect(repo.seen).toEqual([['+584121234567']]);
  });

  it('la sede con +34 lee sin prefijo como España', async () => {
    const repo = new FakeRepo();
    repo.region = 'ES';
    const { useCase } = build(repo);
    await useCase.execute('612 345 678', ClinicRole.RECEPTION);
    expect(repo.seen).toEqual([['+34612345678']]);
  });

  it('un número que no es un número válido: sin coincidencias y sin consulta', async () => {
    const repo = new FakeRepo();
    const { useCase } = build(repo);
    await expect(useCase.execute('1234567', ClinicRole.ADMIN)).resolves.toEqual(
      {
        matches: [],
        truncated: false,
      },
    );
    expect(repo.seen).toEqual([]);
  });

  it('más de 20 pacientes: devuelve los que dice el repositorio y lo avisa', async () => {
    const repo = new FakeRepo();
    repo.truncated = true;
    repo.matches = [
      { patientId: ANA, firstName: 'Ana', lastName: 'P', matchedBy: 'PATIENT' },
    ];
    const { useCase } = build(repo);
    const res = await useCase.execute('0412 1234567', ClinicRole.ADMIN);
    expect(res.truncated).toBe(true);
    expect(res.matches).toHaveLength(1);
  });

  it('sin coincidencias: lista vacía', async () => {
    const repo = new FakeRepo();
    const { useCase } = build(repo);
    await expect(
      useCase.execute('0412 1234567', ClinicRole.ADMIN),
    ).resolves.toEqual({ matches: [], truncated: false });
  });

  it('varios pacientes con el mismo número salen todos, con su contexto', async () => {
    const repo = new FakeRepo();
    repo.matches = [
      {
        patientId: ANA,
        firstName: 'Ana',
        lastName: 'Pérez',
        matchedBy: 'PATIENT',
      },
      {
        patientId: LUIS,
        firstName: 'Luis',
        lastName: 'Pérez',
        matchedBy: 'RESPONSIBLE_PARTY',
      },
    ];
    repo.next.set(ANA, {
      appointmentId: 'apt-1',
      start: new Date('2026-11-10T14:00:00.000Z'),
      ...CCS,
    });
    repo.last.set(LUIS, {
      start: new Date('2026-10-01T14:00:00.000Z'),
      ...CCS,
    });
    const { useCase } = build(repo, {
      pending: [{ currency: 'USD', amount: 80 }],
    });

    const { matches } = await useCase.execute('0412 1234567', ClinicRole.ADMIN);

    expect(matches.map((m) => m.id)).toEqual([ANA, LUIS]);
    expect(matches[0].nextAppointment?.appointmentId).toBe('apt-1');
    expect(matches[0].lastVisit).toBeNull();
    expect(matches[1].nextAppointment).toBeNull();
    expect(matches[1].lastVisit?.locationName).toBe('Caracas');
    expect(matches[1].matchedBy).toBe('RESPONSIBLE_PARTY');
    expect(matches[0].balance.pending).toEqual([
      { currency: 'USD', amount: 80 },
    ]);
  });

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.ADMIN])(
    '%s recibe hasCriticalAlert',
    async (role) => {
      const repo = new FakeRepo();
      repo.matches = [
        {
          patientId: ANA,
          firstName: 'Ana',
          lastName: 'P',
          matchedBy: 'PATIENT',
        },
        {
          patientId: LUIS,
          firstName: 'Luis',
          lastName: 'P',
          matchedBy: 'PATIENT',
        },
      ];
      const { useCase } = build(repo);
      const { matches } = await useCase.execute('0412 1234567', role);
      expect(matches.map((m) => m.hasCriticalAlert)).toEqual([true, false]);
    },
  );

  it('RECEPTION no recibe la clave hasCriticalAlert ni se leen sus alertas', async () => {
    const repo = new FakeRepo();
    repo.matches = [
      { patientId: ANA, firstName: 'Ana', lastName: 'P', matchedBy: 'PATIENT' },
    ];
    const { useCase, alertCalls } = build(repo);
    const { matches } = await useCase.execute(
      '0412 1234567',
      ClinicRole.RECEPTION,
    );
    expect('hasCriticalAlert' in matches[0]).toBe(false);
    expect(JSON.stringify(matches)).not.toContain('hasCriticalAlert');
    expect(alertCalls).toEqual([]);
  });
});
