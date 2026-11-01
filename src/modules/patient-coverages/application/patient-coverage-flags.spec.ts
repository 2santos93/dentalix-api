import { InMemoryPayerRepository } from '../../payers/application/__fixtures__/in-memory-payers';
import { InMemoryPatientCoverageRepository } from './__fixtures__/in-memory-patient-coverages';
import { NO_COVERAGE, PatientCoverageFlags } from './patient-coverage-flags';

describe('PatientCoverageFlags', () => {
  let payers: InMemoryPayerRepository;
  let repo: InMemoryPatientCoverageRepository;
  let flags: PatientCoverageFlags;
  let payerId: string;

  beforeEach(() => {
    payers = new InMemoryPayerRepository();
    repo = new InMemoryPatientCoverageRepository(payers);
    repo.today = '2026-10-20';
    flags = new PatientCoverageFlags(
      repo,
      () => new Date('2026-10-20T15:00:00Z'),
    );
    payerId = payers.seed({ name: 'Surco' }).id;
  });

  const callsOf = (name: string) => repo.calls.filter((c) => c === name).length;

  it('300 ids son UNA lectura de coberturas y UN cálculo de «hoy»', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `p-${i}`);
    repo.seed({ patientId: 'p-1', payerId, isPrimary: true });
    const map = await flags.forPatients(ids);
    expect(map.size).toBe(300);
    expect(callsOf('listPrimaryLiveByPatients')).toBe(1);
    expect(callsOf('clinicToday')).toBe(1);
  });

  it('ids repetidos no multiplican nada y sin ids no hay consultas', async () => {
    expect((await flags.forPatients(['a', 'a', 'a'])).size).toBe(1);
    expect(callsOf('listPrimaryLiveByPatients')).toBe(1);
    repo.calls.length = 0;
    expect((await flags.forPatients([])).size).toBe(0);
    expect(repo.calls).toEqual([]);
  });

  it('sin coberturas vivas es NONE y ni siquiera pregunta por «hoy»', async () => {
    const map = await flags.forPatients(['p-1']);
    expect(map.get('p-1')).toEqual(NO_COVERAGE);
    expect(callsOf('clinicToday')).toBe(0);
  });

  it.each([
    ['vigente', '2026-01-01', '2026-12-31', 'ACTIVE'],
    ['indefinida', null, null, 'ACTIVE'],
    ['termina hoy', null, '2026-10-20', 'ACTIVE'],
    ['venció ayer', null, '2026-10-19', 'EXPIRED'],
    ['empieza mañana', '2026-10-21', null, 'NOT_STARTED'],
  ])('%s → %s', async (_n, validFrom, validTo, status) => {
    repo.seed({
      patientId: 'p-1',
      payerId,
      isPrimary: true,
      validFrom,
      validTo,
    });
    const summary = await flags.forPatient('p-1');
    expect(summary.status).toBe(status);
    expect(summary.payerName).toBe('Surco');
    expect(summary.validTo).toBe(validTo);
  });

  it('«hoy» sale del repositorio (la zona de la sede), no del reloj UTC', async () => {
    repo.seed({
      patientId: 'p-1',
      payerId,
      isPrimary: true,
      validTo: '2026-10-20',
    });
    repo.today = '2026-10-21';
    expect((await flags.forPatient('p-1')).status).toBe('EXPIRED');
  });

  it('resume solo la principal viva y nunca expone el número de afiliado', async () => {
    repo.seed({
      patientId: 'p-1',
      payerId,
      isPrimary: true,
      planName: 'Plus',
      memberNumber: 'SECRETO-1',
      validTo: '2027-01-01',
    });
    repo.seed({
      patientId: 'p-1',
      payerId,
      isPrimary: false,
      validTo: '2020-01-01',
    });
    repo.seed({ patientId: 'p-2', payerId, isPrimary: false });
    const map = await flags.forPatients(['p-1', 'p-2']);
    expect(map.get('p-1')).toEqual({
      status: 'ACTIVE',
      payerName: 'Surco',
      planName: 'Plus',
      validTo: '2027-01-01',
    });
    expect(JSON.stringify([...map.values()])).not.toContain('SECRETO');
    expect(map.get('p-2')).toEqual(NO_COVERAGE);
  });
});
