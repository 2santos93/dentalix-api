import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GetBatchRdaReadinessUseCase } from './get-batch-rda-readiness.use-case';
import { InMemoryClinicalEntryRepository } from '../__fixtures__/in-memory-clinical-entries';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import type { RdaFacts } from '../../domain/rda-readiness';

const facts: RdaFacts = {
  country: 'CO',
  location: { id: 'loc', name: 'Sede B', repsHabilitationCode: null },
  patient: { id: 'p1', docNumber: '123' },
  hasPrincipalDiagnosis: true,
  performedItems: [],
  author: { userId: 'u1', name: 'Dra.', professionalLicense: 'TP' },
};

describe('GetBatchRdaReadinessUseCase (DX-232)', () => {
  const setup = () => {
    const repo = new InMemoryClinicalEntryRepository();
    const patients = patientsInClinic('p1');
    return { repo, useCase: new GetBatchRdaReadinessUseCase(repo, patients) };
  };
  it('40 evoluciones con las mismas reglas unitarias; salida ordenada y sin duplicados', async () => {
    const { repo, useCase } = setup();
    const ids = Array.from({ length: 40 }, (_, i) => `ce-${i}`);
    for (const id of ids) repo.rdaFacts.set(id, facts);
    const result = await useCase.execute('p1', [...ids, ids[0]]);
    expect(result.map((r) => r.entryId)).toEqual(ids);
    expect(result[0].missing).toEqual([
      {
        code: 'LOCATION_REPS',
        label: 'Código de habilitación (REPS) de «Sede B»',
        resourceId: 'loc',
      },
    ]);
  });
  it('rechaza más de50 ids incluso duplicados y vacíos', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(
        'p1',
        Array.from({ length: 51 }, () => 'ce-1'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(useCase.execute('p1', [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('404 si cualquier id no existe o es de otro paciente', async () => {
    const { repo, useCase } = setup();
    repo.rdaFacts.set('own', facts);
    repo.rdaFacts.set('other', {
      ...facts,
      patient: { id: 'p2', docNumber: '456' },
    });
    await expect(
      useCase.execute('p1', ['own', 'missing']),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      useCase.execute('p1', ['own', 'other']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
