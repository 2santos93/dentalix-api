import { InMemoryAgreementRepository } from '../../agreements/application/__fixtures__/in-memory-agreements';
import { InMemoryPatientAgreementRepository } from './__fixtures__/in-memory-patient-agreements';
import { NO_AGREEMENT, PatientAgreementFlags } from './patient-agreement-flags';

describe('PatientAgreementFlags', () => {
  let agreements: InMemoryAgreementRepository;
  let repo: InMemoryPatientAgreementRepository;
  let flags: PatientAgreementFlags;
  let agreementId: string;

  beforeEach(() => {
    agreements = new InMemoryAgreementRepository();
    repo = new InMemoryPatientAgreementRepository(agreements);
    repo.today = '2026-10-20';
    flags = new PatientAgreementFlags(
      repo,
      () => new Date('2026-10-20T15:00:00Z'),
    );
    agreementId = agreements.seed({
      name: 'Convenio Sura',
      payer: { id: 'payer-sura', name: 'Sura', type: 'EPS_CO' },
    }).id;
  });

  const callsOf = (name: string) => repo.calls.filter((c) => c === name).length;

  it('300 ids son UNA lectura de asignaciones y UN cálculo de «hoy»', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `p-${i}`);
    repo.seed({ patientId: 'p-1', agreementId });
    const map = await flags.forPatients(ids);
    expect(map.size).toBe(300);
    expect(callsOf('listCurrentByPatients')).toBe(1);
    expect(callsOf('clinicToday')).toBe(1);
  });

  it('ids repetidos no multiplican nada y sin ids no hay consultas', async () => {
    expect((await flags.forPatients(['a', 'a', 'a'])).size).toBe(1);
    expect(callsOf('listCurrentByPatients')).toBe(1);
    repo.calls.length = 0;
    expect((await flags.forPatients([])).size).toBe(0);
    expect(repo.calls).toEqual([]);
  });

  it('sin asignación es NONE y ni siquiera pregunta por «hoy»', async () => {
    const map = await flags.forPatients(['p-1']);
    expect(map.get('p-1')).toEqual(NO_AGREEMENT);
    expect(callsOf('clinicToday')).toBe(0);
  });

  it.each([
    ['vigente', '2026-01-01', '2026-12-31', 'ACTIVE'],
    ['indefinida', null, null, 'ACTIVE'],
    ['termina hoy', null, '2026-10-20', 'ACTIVE'],
    ['venció ayer', null, '2026-10-19', 'EXPIRED'],
    ['empieza mañana', '2026-10-21', null, 'NOT_STARTED'],
  ])('asignación %s → %s', async (_n, validFrom, validTo, status) => {
    repo.seed({ patientId: 'p-1', agreementId, validFrom, validTo });
    expect(await flags.forPatient('p-1')).toEqual({
      status,
      agreementName: 'Convenio Sura',
      payerName: 'Sura',
    });
  });

  it('la vigencia del convenio también cuenta, y un convenio inactivo gana', async () => {
    const expired = agreements.seed({
      name: 'Vencido',
      payer: { id: 'p', name: 'Sura', type: 'EPS_CO' },
      validTo: '2026-10-19',
    });
    repo.seed({ patientId: 'p-1', agreementId: expired.id });
    const inactive = agreements.seed({
      name: 'Apagado',
      payer: { id: 'p', name: 'Sura', type: 'EPS_CO' },
      active: false,
      validTo: '2026-10-19',
    });
    repo.seed({ patientId: 'p-2', agreementId: inactive.id });
    const map = await flags.forPatients(['p-1', 'p-2']);
    expect(map.get('p-1')?.status).toBe('EXPIRED');
    expect(map.get('p-2')?.status).toBe('INACTIVE');
  });

  it('«hoy» sale del repositorio (la zona de la sede), no del reloj UTC', async () => {
    repo.seed({ patientId: 'p-1', agreementId, validTo: '2026-10-20' });
    repo.today = '2026-10-21';
    expect((await flags.forPatient('p-1')).status).toBe('EXPIRED');
  });

  it('ignora las asignaciones retiradas', async () => {
    repo.seed({ patientId: 'p-1', agreementId, retiredAt: new Date() });
    expect(await flags.forPatient('p-1')).toEqual(NO_AGREEMENT);
  });
});
