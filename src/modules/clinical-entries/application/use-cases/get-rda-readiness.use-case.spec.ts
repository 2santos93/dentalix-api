import { NotFoundException } from '@nestjs/common';
import { GetRdaReadinessUseCase } from './get-rda-readiness.use-case';
import { InMemoryClinicalEntryRepository } from '../__fixtures__/in-memory-clinical-entries';
import type { RdaFacts } from '../../domain/rda-readiness';

const facts: RdaFacts = {
  country: 'CO',
  location: { id: 'loc', name: 'Sede', repsHabilitationCode: '110010123401' },
  patient: { id: 'p1', docNumber: '123' },
  hasPrincipalDiagnosis: true,
  performedItems: [{ catalogItemId: 'ci', name: 'Resina', cupsCode: null }],
  author: { userId: 'u1', name: 'Dra. A', professionalLicense: 'TP-1' },
};

describe('GetRdaReadinessUseCase (DX-212)', () => {
  it('calcula los faltantes de la evolución', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    repo.rdaFacts.set('ce-1', facts);
    const result = await new GetRdaReadinessUseCase(repo).execute('ce-1');
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      {
        code: 'PROCEDURE_CUPS',
        label: 'Código CUPS de «Resina»',
        resourceId: 'ci',
      },
    ]);
  });

  it('evolución de otra clínica o inexistente: 404', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    await expect(
      new GetRdaReadinessUseCase(repo).execute('nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
