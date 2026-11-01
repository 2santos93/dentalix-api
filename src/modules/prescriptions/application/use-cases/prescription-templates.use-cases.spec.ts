import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InMemoryPrescriptionTemplateRepository } from '../__fixtures__/in-memory-prescriptions';
import {
  CreatePrescriptionTemplateUseCase,
  DeletePrescriptionTemplateUseCase,
  ListPrescriptionTemplatesUseCase,
  UpdatePrescriptionTemplateUseCase,
} from './prescription-templates.use-cases';

const USER: AuditRequestContext = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  locationId: null,
  actor: { userId: '00000000-0000-4000-8000-0000000000ad', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

describe('Plantillas de receta', () => {
  let repo: InMemoryPrescriptionTemplateRepository;

  beforeEach(() => {
    repo = new InMemoryPrescriptionTemplateRepository();
  });

  it('crea con nombre y medicamentos recortados, y lista por nombre', async () => {
    const create = new CreatePrescriptionTemplateUseCase(repo);
    await create.execute(
      {
        name: '  Post-exodoncia ',
        notes: '  ',
        items: [
          {
            activeIngredient: ' Ibuprofeno ',
            concentration: ' 600 mg ',
            durationDays: 3,
          },
        ],
      },
      USER,
    );
    await create.execute(
      { name: 'Analgesia', items: [{ activeIngredient: 'Paracetamol' }] },
      USER,
    );
    const list = await new ListPrescriptionTemplatesUseCase(repo).execute();
    expect(list.map((t) => t.name)).toEqual(['Analgesia', 'Post-exodoncia']);
    expect(list[1]).toMatchObject({
      notes: null,
      items: [
        {
          activeIngredient: 'Ibuprofeno',
          concentration: '600 mg',
          durationDays: 3,
          brandName: null,
          route: null,
        },
      ],
    });
  });

  it.each([
    [
      { name: ' ', items: [{ activeIngredient: 'X' }] },
      'El nombre de la plantilla es obligatorio',
    ],
    [{ name: 'A', items: [] }, 'La plantilla necesita al menos un medicamento'],
    [
      { name: 'A', items: [{ activeIngredient: ' ' }] },
      'Medicamento 1: falta el principio activo (DCI)',
    ],
    [
      { name: 'A', items: [{ activeIngredient: 'X', totalQuantity: 0 }] },
      'Medicamento 1: la cantidad total debe ser un número entero entre 1 y 9999',
    ],
  ])('400 en español: %j', async (body, message) => {
    const promise = new CreatePrescriptionTemplateUseCase(repo).execute(
      body,
      USER,
    );
    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.toThrow(message);
  });

  it('edita (404 si no existe) y retira en blando', async () => {
    const created = await new CreatePrescriptionTemplateUseCase(repo).execute(
      { name: 'A', items: [{ activeIngredient: 'X' }] },
      USER,
    );
    const update = new UpdatePrescriptionTemplateUseCase(repo);
    await expect(
      update.execute('nope', { name: 'B' }, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await update.execute(created.id, { name: ' B ' }, USER)).name).toBe(
      'B',
    );

    const remove = new DeletePrescriptionTemplateUseCase(repo);
    await remove.execute(created.id, USER);
    expect(await new ListPrescriptionTemplatesUseCase(repo).execute()).toEqual(
      [],
    );
    await expect(remove.execute(created.id, USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
