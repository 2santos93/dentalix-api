import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  NO_INCIDENTS,
  attendanceWindowStart,
  summarize,
  type PatientAttendanceSummary,
  type PatientIncidentCounts,
} from '../../domain/attendance';
import {
  PATIENT_ATTENDANCE_REPOSITORY,
  type PatientAttendanceRepository,
} from '../../domain/ports/patient-attendance-repository.port';

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado';

/**
 * Sedes que cuentan para el usuario del request (DX-089): las permitidas,
 * SIN mirar la sede activa de la cabecera — el resumen es del paciente, no de
 * la sede en la que se trabaja. `undefined` = todas.
 */
function allowedLocations(
  tenantContext: TenantContextService,
): readonly string[] | undefined {
  const allowed = tenantContext.getAllowedLocationIds();
  return allowed === 'ALL' ? undefined : allowed;
}

/**
 * DX-279: insignia de la agenda — inasistencias y cancelaciones tardías de
 * los últimos 12 meses de un LOTE de pacientes, en una consulta (molde
 * `PatientBalanceFlags`, DX-150). Misma regla que el resumen del paciente.
 */
@Injectable()
export class PatientAttendanceFlags {
  constructor(
    @Inject(PATIENT_ATTENDANCE_REPOSITORY)
    private readonly repo: PatientAttendanceRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async forPatients(
    patientIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, PatientIncidentCounts>> {
    const counts = await this.repo.countsByPatients(
      patientIds,
      attendanceWindowStart(now),
      allowedLocations(this.tenantContext),
    );
    return new Map(
      [...new Set(patientIds)].map((id) => [
        id,
        counts.get(id) ?? NO_INCIDENTS,
      ]),
    );
  }
}

/**
 * DX-279: `GET /patients/:id/attendance-summary` — citas, inasistencias y
 * cancelaciones tardías de los últimos 12 meses, por sede y en total. Un
 * paciente de otra clínica: 404.
 */
@Injectable()
export class GetPatientAttendanceUseCase {
  constructor(
    @Inject(PATIENT_ATTENDANCE_REPOSITORY)
    private readonly repo: PatientAttendanceRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    patientId: string,
    now: Date = new Date(),
  ): Promise<PatientAttendanceSummary> {
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const since = attendanceWindowStart(now);
    const byLocation = await this.repo.summaryByLocation(
      patientId,
      since,
      now,
      allowedLocations(this.tenantContext),
    );
    return summarize(patientId, since, now, byLocation);
  }
}
