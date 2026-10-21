import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { patientsInClinic } from '../../patients/application/__fixtures__/patients-in-clinic.fake';
import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { deriveSafetyFlags } from '../domain/safety-flags';
import { NO_ANAMNESIS_FLAGS } from '../domain/medical-alert-flags';
import { InMemoryMedicalAlertsRepository } from './__fixtures__/in-memory-medical-alerts';
import { PatientMedicalAlertFlags } from './patient-medical-alert-flags';
import type { LocationRepository } from '../../locations/domain/ports/location-repository.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ConfirmAnamnesisNoChangesUseCase,
  GetAnamnesisSettingsUseCase,
  GetPatientMedicalAlertsUseCase,
  NO_ANAMNESIS_TO_CONFIRM_MESSAGE,
  UpdateAnamnesisSettingsUseCase,
} from './use-cases/medical-alerts.use-cases';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const TODAY = { date: '2026-10-20', timeZone: 'America/Bogota' };

/** Dos sedes: la principal en Bogotá y otra en Madrid. */
function fakeLocations(): LocationRepository & { calls: number } {
  const fake = {
    calls: 0,
    list() {
      fake.calls++;
      return Promise.resolve([
        { id: 'bog', timeZone: 'America/Bogota' },
        { id: 'mad', timeZone: 'Europe/Madrid' },
      ]);
    },
  };
  return fake as unknown as LocationRepository & { calls: number };
}

function flagsService(
  repo: InMemoryMedicalAlertsRepository,
  locations = fakeLocations(),
  tenantContext = new TenantContextService(),
) {
  return new PatientMedicalAlertFlags(
    repo,
    locations,
    tenantContext,
    () => NOW,
  );
}
const premedication = deriveSafetyFlags({
  conditions: [
    {
      codigo: 'PROTESIS_VALVULAR',
      etiqueta: 'Prótesis valvular',
      estado: 'SI',
      esAlerta: true,
    },
  ],
});

describe('PatientMedicalAlertFlags (DX-247, por lote)', () => {
  let repo: InMemoryMedicalAlertsRepository;
  let flags: PatientMedicalAlertFlags;

  beforeEach(() => {
    repo = new InMemoryMedicalAlertsRepository();
    flags = flagsService(repo);
  });

  const callsOf = (name: string) => repo.calls.filter((c) => c === name).length;

  it('300 ids son UNA lectura de anamnesis y UNA de la vigencia (sin N+1)', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `p-${i}`);
    repo.seedSnapshot('p-1', { ...premedication });
    const map = await flags.forPatients(ids, TODAY);
    expect(map.size).toBe(300);
    expect(callsOf('reviewStates')).toBe(1);
    expect(callsOf('getValidityMonths')).toBe(1);
  });

  it('sin ids no consulta nada; ids repetidos cuentan una vez', async () => {
    expect((await flags.forPatients([], TODAY)).size).toBe(0);
    expect(repo.calls).toEqual([]);
    expect((await flags.forPatients(['a', 'a'], TODAY)).size).toBe(1);
  });

  it('paciente sin anamnesis → MISSING (no «sin alertas»)', async () => {
    const map = await flags.forPatients(['nuevo'], TODAY);
    expect(map.get('nuevo')).toEqual(NO_ANAMNESIS_FLAGS);
  });

  it('profilaxis antibiótica → requiresPremedication', async () => {
    repo.seedSnapshot('p-1', { ...premedication });
    const flag = (await flags.forPatients(['p-1'], TODAY)).get('p-1');
    expect(flag?.requiresPremedication).toBe(true);
    expect(flag?.hasCriticalAlert).toBe(true);
    expect(flag?.alerts).toEqual(['profilaxisAntibiotica']);
  });

  it('cada cita se evalúa el día civil de su inicio en la zona de su sede, sin N+1', async () => {
    const locations = fakeLocations();
    flags = flagsService(repo, locations);
    // Revisada el 25/10/2025: caduca el 25/10/2026 en Bogotá.
    repo.seedSnapshot('p-1', {
      createdAt: new Date('2025-10-25T15:00:00.000Z'),
    });
    const map = await flags.forAppointments([
      {
        id: 'hoy',
        patientId: 'p-1',
        start: new Date('2026-10-21T14:00:00.000Z'),
        locationId: 'bog',
      },
      {
        id: 'jueves',
        patientId: 'p-1',
        start: new Date('2026-10-29T14:00:00.000Z'),
        locationId: 'bog',
      },
      // 24/10 a las 23:30 en Bogotá es el 25/10 en UTC: sigue al día.
      {
        id: 'noche',
        patientId: 'p-1',
        start: new Date('2026-10-25T04:30:00.000Z'),
        locationId: 'bog',
      },
      // La misma hora en Madrid ya es el 25/10 allí.
      {
        id: 'madrid',
        patientId: 'p-1',
        start: new Date('2026-10-25T04:30:00.000Z'),
        locationId: 'mad',
      },
      {
        id: 'nuevo',
        patientId: 'p-2',
        start: new Date('2026-10-21T14:00:00.000Z'),
        locationId: 'bog',
      },
    ]);
    expect(map.get('hoy')?.anamnesisStatus).toBe('CURRENT');
    expect(map.get('jueves')?.anamnesisStatus).toBe('EXPIRED');
    expect(map.get('noche')?.anamnesisStatus).toBe('CURRENT');
    expect(map.get('madrid')?.anamnesisStatus).toBe('EXPIRED');
    expect(map.get('nuevo')).toEqual(NO_ANAMNESIS_FLAGS);
    expect(callsOf('reviewStates')).toBe(1);
    expect(callsOf('getValidityMonths')).toBe(1);
    expect(locations.calls).toBe(1);
  });

  it('hoy en la sede del request o, sin sede, en la principal', async () => {
    const tenantContext = new TenantContextService();
    flags = flagsService(repo, fakeLocations(), tenantContext);
    // 15:00 UTC del 20/10: ya es 20/10 en Bogotá y en Madrid.
    await expect(flags.todayInSede()).resolves.toEqual({
      date: '2026-10-20',
      timeZone: 'America/Bogota',
    });
    await expect(
      tenantContext.run('t-1', 'mad', () => flags.todayInSede()),
    ).resolves.toEqual({ date: '2026-10-20', timeZone: 'Europe/Madrid' });
  });

  it('la vigencia de la clínica decide «caducada»', async () => {
    repo.seedSnapshot('p-1', {
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect((await flags.forPatient('p-1', TODAY)).anamnesisStatus).toBe(
      'CURRENT',
    );
    repo.validityMonths = 6;
    expect((await flags.forPatient('p-1', TODAY)).anamnesisStatus).toBe(
      'EXPIRED',
    );
  });
});

describe('Casos de uso de alertas y vigencia (DX-247)', () => {
  let repo: InMemoryMedicalAlertsRepository;
  const audit = { record: jest.fn() };
  const ctx: AuditRequestContext = {
    tenantId: 't-1',
    locationId: 'l-1',
    actor: { userId: 'u-admin', role: 'ADMIN' },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };

  beforeEach(() => {
    repo = new InMemoryMedicalAlertsRepository();
    repo.now = () => NOW;
    audit.record.mockReset();
  });

  describe('GetPatientMedicalAlertsUseCase', () => {
    const uc = () =>
      new GetPatientMedicalAlertsUseCase(
        flagsService(repo),
        repo,
        patientsInClinic('p-1', 'p-2'),
      );

    it('paciente de otra clínica (o inexistente) → 404', async () => {
      await expect(uc().execute('ajeno')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('banderas, vigencia, fecha de caducidad y la última revisión', async () => {
      repo.seedSnapshot('p-1', {
        ...premedication,
        createdAt: new Date('2025-11-01T10:00:00.000Z'),
      });
      const view = await uc().execute('p-1');
      expect(view).toMatchObject({
        requiresPremedication: true,
        anamnesisStatus: 'CURRENT',
        validityMonths: 12,
        anamnesisExpiresOn: '2026-11-01',
        today: '2026-10-20',
        timeZone: 'America/Bogota',
        lastReview: {
          kind: 'UPDATED',
          at: new Date('2025-11-01T10:00:00.000Z'),
        },
      });
    });

    it('sin anamnesis: MISSING, sin caducidad ni revisión', async () => {
      const view = await uc().execute('p-2');
      expect(view).toMatchObject({
        anamnesisStatus: 'MISSING',
        anamnesisExpiresOn: null,
        lastReview: null,
      });
    });
  });

  describe('ConfirmAnamnesisNoChangesUseCase («Sin cambios hoy»)', () => {
    const uc = () =>
      new ConfirmAnamnesisNoChangesUseCase(
        repo,
        patientsInClinic('p-1', 'p-2'),
      );

    it('guarda quién y cuándo, sobre la versión vigente', async () => {
      const snapshot = repo.seedSnapshot('p-1', {
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      repo.names.set('u-dentist', 'Dra. Ruiz');
      const result = await uc().execute('p-1', 'u-dentist');
      expect(result).toMatchObject({
        patientId: 'p-1',
        medicalHistoryVersionId: snapshot.versionId,
        reviewedById: 'u-dentist',
        reviewedByName: 'Dra. Ruiz',
        reviewedAt: NOW,
      });
      // Y reinicia la vigencia: deja de estar caducada.
      const after = await flagsService(repo).forPatient('p-1', TODAY);
      expect(after.anamnesisStatus).toBe('CURRENT');
      expect(after.anamnesisReviewedAt).toEqual(NOW);
    });

    it('sin anamnesis no hay nada que confirmar → 409', async () => {
      await expect(uc().execute('p-2', 'u-1')).rejects.toThrow(
        new ConflictException(NO_ANAMNESIS_TO_CONFIRM_MESSAGE),
      );
      expect(repo.confirmations).toHaveLength(0);
    });

    it('paciente de otra clínica → 404 y no escribe', async () => {
      await expect(uc().execute('ajeno', 'u-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.confirmations).toHaveLength(0);
    });
  });

  describe('Vigencia de la clínica', () => {
    it('lee la vigencia de la clínica', async () => {
      repo.validityMonths = 18;
      await expect(
        new GetAnamnesisSettingsUseCase(repo).execute(),
      ).resolves.toEqual({ anamnesisValidityMonths: 18 });
    });

    it('cambiarla queda en la auditoría con antes y después (sin pacientes)', async () => {
      const uc = new UpdateAnamnesisSettingsUseCase(
        repo,
        audit as unknown as RecordAuditEventUseCase,
      );
      await expect(
        uc.execute({ anamnesisValidityMonths: 6 }, ctx),
      ).resolves.toEqual({
        anamnesisValidityMonths: 6,
      });
      expect(repo.validityMonths).toBe(6);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'MEDICAL_HISTORY',
          patient: null,
          actor: { kind: 'user', userId: 'u-admin', role: 'ADMIN' },
          metadata: {
            reason: 'ANAMNESIS_VALIDITY_SETTINGS',
            statusChange: { from: 'MONTHS_12', to: 'MONTHS_6' },
          },
        }),
      );
    });

    it('fuera de 1..60 → 400 y no cambia nada', async () => {
      const uc = new UpdateAnamnesisSettingsUseCase(
        repo,
        audit as unknown as RecordAuditEventUseCase,
      );
      await expect(
        uc.execute({ anamnesisValidityMonths: 0 }, ctx),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.validityMonths).toBe(12);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
