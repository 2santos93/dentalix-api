import { Inject, Injectable } from '@nestjs/common';
import { PatientMedicalAlertFlags } from '../../medical-history/application/patient-medical-alert-flags';
import { orderPending, type CheckInPending } from '../domain/check-in-rules';
import {
  CHECK_IN_REPOSITORY,
  type CheckInRepository,
} from '../domain/ports/check-in-repository.port';

/** El día civil (y su zona) en que se evalúa la anamnesis: el de la cita en su sede. */
export interface PendingDay {
  date: string;
  timeZone: string;
}

/**
 * DX-265: qué tiene pendiente cada paciente al llegar, sin datos de salud ni
 * importes: anamnesis ausente o caducada (la MISMA regla de DX-247 que la
 * agenda y «En clínica»), autorización de datos o consentimiento por firmar y
 * datos obligatorios incompletos. El retraso no depende del paciente: lo
 * añade quien conoce la llegada (`isLateArrival`). Por lote, sin N+1.
 */
@Injectable()
export class CheckInPendingService {
  constructor(
    @Inject(CHECK_IN_REPOSITORY) private readonly repo: CheckInRepository,
    private readonly medicalAlerts: PatientMedicalAlertFlags,
  ) {}

  async forPatients(
    patientIds: readonly string[],
    day: PendingDay,
    now: Date = new Date(),
  ): Promise<Map<string, CheckInPending[]>> {
    const ids = [...new Set(patientIds)];
    const out = new Map<string, CheckInPending[]>();
    if (ids.length === 0) return out;
    const [alerts, facts] = await Promise.all([
      this.medicalAlerts.forPatients(ids, day),
      this.repo.pendingFacts(ids, now),
    ]);
    for (const id of ids) {
      const pending: CheckInPending[] = [];
      const anamnesis = alerts.get(id)?.anamnesisStatus ?? 'MISSING';
      if (anamnesis !== 'CURRENT') pending.push('ANAMNESIS');
      const f = facts.get(id);
      if (!f || f.consentPending) pending.push('CONSENT');
      if (!f || f.missingData) pending.push('PATIENT_DATA');
      out.set(id, orderPending(pending));
    }
    return out;
  }
}
