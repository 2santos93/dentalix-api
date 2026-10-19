import { BadRequestException, NotFoundException } from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { CreateClinicalEntryUseCase } from './create-clinical-entry.use-case';
import { InMemoryClinicalEntryRepository } from '../__fixtures__/in-memory-clinical-entries';
import { InMemoryClinicalNoteTemplateRepository } from '../../../clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';

function setup() {
  const repo = new InMemoryClinicalEntryRepository();
  const uc = new CreateClinicalEntryUseCase(
    repo,
    patientsInClinic('p1'),
    new InMemoryClinicalNoteTemplateRepository(),
  );
  return { repo, uc };
}

describe('CreateClinicalEntryUseCase · diagnósticos CIE-10 (DX-212)', () => {
  it('guarda el principal y el relacionado (con diente) junto con la evolución', async () => {
    const { repo, uc } = setup();
    const entry = await uc.execute(
      'p1',
      {
        notes: 'Resina oclusal en 36',
        diagnoses: [
          { icd10Code: 'K02.1', kind: 'PRINCIPAL' },
          { icd10Code: 'k05.1', kind: 'RELACIONADO', toothFdi: '36' },
        ],
      },
      'u1',
    );
    expect(
      entry.diagnoses.map((d) => [d.icd10Code, d.kind, d.toothFdi]),
    ).toEqual([
      ['K02.1', 'PRINCIPAL', null],
      ['K05.1', 'RELACIONADO', '36'],
    ]);
    expect(repo.rows).toHaveLength(1);
  });

  it('sin diagnóstico sigue permitida', async () => {
    const { uc } = setup();
    const entry = await uc.execute('p1', { notes: 'Control' }, 'u1');
    expect(entry.diagnoses).toEqual([]);
  });

  it('un segundo PRINCIPAL: 400 en español y no se guarda nada', async () => {
    const { repo, uc } = setup();
    await expect(
      uc.execute(
        'p1',
        {
          notes: 'x',
          diagnoses: [
            { icd10Code: 'K02.1', kind: 'PRINCIPAL' },
            { icd10Code: 'K05.1', kind: 'PRINCIPAL' },
          ],
        },
        'u1',
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'Solo puede haber un diagnóstico principal por evolución',
      ),
    );
    expect(repo.rows).toHaveLength(0);
  });

  it('un código que no está en la tabla CIE-10: 400 «Código CIE-10 no válido»', async () => {
    const { repo, uc } = setup();
    await expect(
      uc.execute(
        'p1',
        { notes: 'x', diagnoses: [{ icd10Code: 'K99.9', kind: 'PRINCIPAL' }] },
        'u1',
      ),
    ).rejects.toThrow(
      new BadRequestException('Código CIE-10 no válido: «K99.9»'),
    );
    expect(repo.rows).toHaveLength(0);
  });

  it('paciente de otra clínica: 404 antes de mirar los diagnósticos', async () => {
    const { uc } = setup();
    await expect(
      uc.execute(
        'p-otra',
        { notes: 'x', diagnoses: [{ icd10Code: 'K99.9', kind: 'PRINCIPAL' }] },
        'u1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
