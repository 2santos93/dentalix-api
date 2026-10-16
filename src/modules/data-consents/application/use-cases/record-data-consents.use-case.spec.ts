import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RecordDataConsentsUseCase } from './record-data-consents.use-case';
import { GetPatientDataConsentsUseCase } from './get-patient-data-consents.use-case';
import { InMemoryDataConsentRepository } from './__fixtures__/in-memory-data-consents';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';

const POLICY = 'pol-1';

describe('RecordDataConsentsUseCase / GetPatientDataConsentsUseCase', () => {
  let repo: InMemoryDataConsentRepository;
  let record: RecordDataConsentsUseCase;
  let get: GetPatientDataConsentsUseCase;

  beforeEach(() => {
    repo = new InMemoryDataConsentRepository();
    const patients = patientsInClinic('p1');
    record = new RecordDataConsentsUseCase(repo, patients);
    get = new GetPatientDataConsentsUseCase(repo, patients);
  });

  it('registra una fila por decisión con quién y la evidencia de la petición', async () => {
    const res = await record.execute(
      'p1',
      {
        policyVersionId: POLICY,
        decisions: [
          { scope: 'GENERAL', granted: true },
          { scope: 'SENSITIVE_HEALTH', granted: true },
        ],
      },
      'user-1',
      { ipAddress: '10.0.0.1', userAgent: 'jest' },
    );
    expect(repo.commands).toEqual([
      {
        patientId: 'p1',
        policyVersionId: POLICY,
        decisions: [
          { scope: 'GENERAL', granted: true },
          { scope: 'SENSITIVE_HEALTH', granted: true },
        ],
        recordedById: 'user-1',
        evidence: { ipAddress: '10.0.0.1', userAgent: 'jest' },
      },
    ]);
    expect(res.history).toHaveLength(2);
    expect(res.current.map((c) => [c.scope, c.granted])).toEqual([
      ['GENERAL', true],
      ['SENSITIVE_HEALTH', true],
      ['MARKETING', null],
    ]);
  });

  it('revocar MARKETING añade una fila granted=false que pasa a ser el estado vigente', async () => {
    await record.execute(
      'p1',
      {
        policyVersionId: POLICY,
        decisions: [{ scope: 'MARKETING', granted: true }],
      },
      'user-1',
      {},
    );
    const res = await record.execute(
      'p1',
      {
        policyVersionId: POLICY,
        decisions: [{ scope: 'MARKETING', granted: false }],
      },
      'user-1',
      {},
    );
    expect(res.history.map((r) => r.granted)).toEqual([false, true]);
    expect(res.current.find((c) => c.scope === 'MARKETING')?.granted).toBe(
      false,
    );
  });

  it('sin decisiones explícitas no registra nada (400)', async () => {
    await expect(
      record.execute(
        'p1',
        { policyVersionId: POLICY, decisions: [] },
        'user-1',
        {},
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.commands).toHaveLength(0);
  });

  it('un paciente de otra clínica (o inexistente) da 404 sin escribir', async () => {
    await expect(
      record.execute(
        'p-otra',
        {
          policyVersionId: POLICY,
          decisions: [{ scope: 'GENERAL', granted: true }],
        },
        'user-1',
        {},
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(get.execute('p-otra')).rejects.toThrow(NotFoundException);
    expect(repo.commands).toHaveLength(0);
  });

  it('GET de un paciente sin filas: tres scopes sin decisión e historial vacío', async () => {
    const res = await get.execute('p1');
    expect(res.history).toEqual([]);
    expect(res.current.every((c) => c.granted === null)).toBe(true);
  });
});
