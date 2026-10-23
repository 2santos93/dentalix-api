import { NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  LocationAttendance,
  PatientIncidentCounts,
} from '../../domain/attendance';
import { attendanceWindowStart } from '../../domain/attendance';
import type { PatientAttendanceRepository } from '../../domain/ports/patient-attendance-repository.port';
import {
  GetPatientAttendanceUseCase,
  PatientAttendanceFlags,
} from './patient-attendance';

const NOW = new Date('2026-10-23T15:00:00.000Z');

class FakeRepo implements PatientAttendanceRepository {
  calls: {
    since: Date;
    locationIds: readonly string[] | undefined;
  }[] = [];

  constructor(private readonly rows: LocationAttendance[] = []) {}

  patientExists(patientId: string) {
    return Promise.resolve(patientId === 'p1');
  }

  countsByPatients(
    _ids: readonly string[],
    since: Date,
    locationIds: readonly string[] | undefined,
  ) {
    this.calls.push({ since, locationIds });
    return Promise.resolve(
      new Map<string, PatientIncidentCounts>([
        ['p1', { noShows: 2, lateCancellations: 1 }],
      ]),
    );
  }

  summaryByLocation(
    _patientId: string,
    since: Date,
    _until: Date,
    locationIds: readonly string[] | undefined,
  ) {
    this.calls.push({ since, locationIds });
    return Promise.resolve(
      this.rows.filter(
        (r) => locationIds === undefined || locationIds.includes(r.locationId),
      ),
    );
  }
}

const NORTE: LocationAttendance = {
  locationId: 'norte',
  locationName: 'Sede Norte',
  appointments: 3,
  noShows: 1,
  lateCancellations: 0,
};
const PRINCIPAL: LocationAttendance = {
  locationId: 'principal',
  locationName: 'Sede principal',
  appointments: 5,
  noShows: 1,
  lateCancellations: 1,
};

describe('Asistencia del paciente (DX-279)', () => {
  it('la ventana es de 12 meses de calendario en UTC', () => {
    expect(attendanceWindowStart(NOW).toISOString()).toBe(
      '2025-10-23T15:00:00.000Z',
    );
  });

  it('suma las sedes en el total (sin restricción: todas)', async () => {
    const repo = new FakeRepo([NORTE, PRINCIPAL]);
    const useCase = new GetPatientAttendanceUseCase(
      repo,
      new TenantContextService(),
    );
    const summary = await useCase.execute('p1', NOW);
    expect(summary.totals).toEqual({
      appointments: 8,
      noShows: 2,
      lateCancellations: 1,
    });
    expect(summary.byLocation).toEqual([NORTE, PRINCIPAL]);
    expect(repo.calls[0].locationIds).toBeUndefined();
  });

  it('un miembro restringido (DX-089) solo cuenta sus sedes, aunque mande otra sede activa', async () => {
    const repo = new FakeRepo([NORTE, PRINCIPAL]);
    const tenantContext = new TenantContextService();
    const useCase = new GetPatientAttendanceUseCase(repo, tenantContext);
    const summary = await tenantContext.run(
      't1',
      'norte',
      () => useCase.execute('p1', NOW),
      ['norte'],
    );
    expect(summary.byLocation).toEqual([NORTE]);
    expect(summary.totals).toEqual({
      appointments: 3,
      noShows: 1,
      lateCancellations: 0,
    });
  });

  it('un paciente que no es de la clínica: 404', async () => {
    const useCase = new GetPatientAttendanceUseCase(
      new FakeRepo(),
      new TenantContextService(),
    );
    await expect(useCase.execute('otro', NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la insignia de la agenda: un mapa para todo el lote, con ceros para los que no tienen', async () => {
    const repo = new FakeRepo();
    const flags = new PatientAttendanceFlags(repo, new TenantContextService());
    const map = await flags.forPatients(['p1', 'p2', 'p1'], NOW);
    expect([...map.entries()]).toEqual([
      ['p1', { noShows: 2, lateCancellations: 1 }],
      ['p2', { noShows: 0, lateCancellations: 0 }],
    ]);
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].since.toISOString()).toBe('2025-10-23T15:00:00.000Z');
  });
});
