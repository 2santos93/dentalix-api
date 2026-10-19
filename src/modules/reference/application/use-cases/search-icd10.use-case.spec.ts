import {
  SearchIcd10UseCase,
  ICD10_SEARCH_LIMIT,
} from './search-icd10.use-case';
import type { ReferenceRepository } from '../../domain/ports/reference-repository.port';

describe('SearchIcd10UseCase (DX-212)', () => {
  it('pasa el texto tal cual y SIEMPRE con el tope de 20', async () => {
    const searchIcd10 = jest.fn().mockResolvedValue([]);
    const repo = { searchIcd10 } as unknown as ReferenceRepository;
    await new SearchIcd10UseCase(repo).execute('caries');
    expect(ICD10_SEARCH_LIMIT).toBe(20);
    expect(searchIcd10).toHaveBeenCalledWith('caries', 20);
  });
});
