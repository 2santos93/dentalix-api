import type { PatientMedicalAlertFlags } from '../../medical-history/application/patient-medical-alert-flags';
import type { MedicalAlertFlags } from '../../medical-history/domain/medical-alert-flags';
import type {
  CheckInRepository,
  PendingPatientFacts,
} from '../domain/ports/check-in-repository.port';
import { CheckInPendingService } from './check-in-pending.service';

const DAY = { date: '2027-03-10', timeZone: 'America/Caracas' };

function flags(anamnesisStatus: 'CURRENT' | 'EXPIRED' | 'MISSING') {
  return {
    hasCriticalAlert: false,
    requiresPremedication: false,
    anamnesisStatus,
    alerts: [],
    anamnesisReviewedAt: null,
  } as MedicalAlertFlags;
}

function service(
  alerts: Record<string, MedicalAlertFlags>,
  facts: PendingPatientFacts[],
) {
  const repo = {
    pendingFacts: () =>
      Promise.resolve(new Map(facts.map((f) => [f.patientId, f]))),
  } as unknown as CheckInRepository;
  const medical = {
    forPatients: () => Promise.resolve(new Map(Object.entries(alerts))),
  } as unknown as PatientMedicalAlertFlags;
  return new CheckInPendingService(repo, medical);
}

describe('DX-265 · pendientes al llegar', () => {
  it('al día y con todo: nada pendiente («Tome asiento»)', async () => {
    const out = await service({ p1: flags('CURRENT') }, [
      { patientId: 'p1', missingData: false, consentPending: false },
    ]).forPatients(['p1'], DAY);
    expect(out.get('p1')).toEqual([]);
  });

  it('anamnesis caducada o ausente (regla DX-247), consentimiento y datos', async () => {
    const out = await service({ p1: flags('EXPIRED'), p2: flags('CURRENT') }, [
      { patientId: 'p1', missingData: false, consentPending: true },
      { patientId: 'p2', missingData: true, consentPending: false },
      { patientId: 'p3', missingData: false, consentPending: false },
    ]).forPatients(['p1', 'p2', 'p3'], DAY);
    expect(out.get('p1')).toEqual(['ANAMNESIS', 'CONSENT']);
    expect(out.get('p2')).toEqual(['PATIENT_DATA']);
    // Sin banderas médicas: sin anamnesis.
    expect(out.get('p3')).toEqual(['ANAMNESIS']);
  });

  it('sin pacientes, ninguna consulta', async () => {
    const forPatients = jest.fn();
    const pendingFacts = jest.fn();
    const out = await new CheckInPendingService(
      { pendingFacts } as unknown as CheckInRepository,
      { forPatients } as unknown as PatientMedicalAlertFlags,
    ).forPatients([], DAY);
    expect(out.size).toBe(0);
    expect(forPatients).not.toHaveBeenCalled();
    expect(pendingFacts).not.toHaveBeenCalled();
  });
});
