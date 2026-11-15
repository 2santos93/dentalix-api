import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AUDIT_CTX,
  InMemoryTreatmentPlanTemplateRepository,
} from '../__fixtures__/in-memory-treatment-plan-templates';
import {
  CreatePlanTemplateUseCase,
  GetPlanTemplateUseCase,
  ListPlanTemplatesUseCase,
  UpdatePlanTemplateUseCase,
} from './treatment-plan-templates.use-cases';
import {
  PLAN_TEMPLATE_CATALOG_ITEM_NOT_FOUND,
  PLAN_TEMPLATE_DUPLICATE_NAME,
  PLAN_TEMPLATE_NOT_A_PROCEDURE,
  PLAN_TEMPLATE_STALE,
} from '../plan-template-errors';

const ENDO = 'aaaaaaaa-0000-4000-8000-000000000001';
const CROWN = 'aaaaaaaa-0000-4000-8000-000000000002';
const CARIES = 'aaaaaaaa-0000-4000-8000-000000000003';
const OLD = 'aaaaaaaa-0000-4000-8000-000000000004';
const GONE = 'aaaaaaaa-0000-4000-8000-000000000005';

function setup() {
  const repo = new InMemoryTreatmentPlanTemplateRepository();
  repo.addCatalogItem({ id: ENDO, kind: 'PROCEDURE', labelEs: 'Endodoncia' });
  repo.addCatalogItem({ id: CROWN, kind: 'PROCEDURE', labelEs: 'Corona' });
  repo.addCatalogItem({ id: CARIES, kind: 'DIAGNOSIS', labelEs: 'Caries' });
  repo.addCatalogItem({
    id: OLD,
    kind: 'PROCEDURE',
    labelEs: 'Amalgama',
    active: false,
  });
  repo.addCatalogItem({
    id: GONE,
    kind: 'PROCEDURE',
    labelEs: 'Retirado',
    deleted: true,
  });
  return {
    repo,
    create: new CreatePlanTemplateUseCase(repo),
    update: new UpdatePlanTemplateUseCase(repo),
    list: new ListPlanTemplatesUseCase(repo),
    get: new GetPlanTemplateUseCase(repo),
  };
}

const ENDO_CROWN = {
  name: 'Endodoncia + corona',
  visitIntervals: { '2': 7, '3': 14 },
  lines: [
    { catalogItemId: ENDO, visit: 1 },
    { catalogItemId: ENDO, visit: 2 },
    { catalogItemId: CROWN, visit: 3, asksSurfaces: true },
  ],
};

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    const body = (error as { getResponse?: () => unknown }).getResponse?.();
    return (body as { code?: string })?.code ?? error;
  }
  return undefined;
}

describe('CRUD de plantillas de plan (DX-559)', () => {
  it('crea con valores por defecto (cantidad 1, visita 1, sin superficies, activa) y audita', async () => {
    const { repo, create } = setup();
    const created = await create.execute(
      { name: ' Limpieza ', lines: [{ catalogItemId: ENDO }] },
      AUDIT_CTX,
    );
    expect(created).toMatchObject({
      name: 'Limpieza',
      active: true,
      version: 1,
      visitIntervals: {},
    });
    expect(created.lines[0]).toMatchObject({
      quantity: 1,
      visit: 1,
      visitLabel: null,
      asksSurfaces: false,
    });
    expect(repo.events).toEqual([
      { action: 'CREATE', reason: 'PLAN_TEMPLATE_CREATED', id: created.id },
    ]);
  });

  it('una plantilla inválida da 400 en español y no escribe', async () => {
    const { repo, create } = setup();
    await expect(
      create.execute({ ...ENDO_CROWN, visitIntervals: { '9': 1 } }, AUDIT_CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.rows).toHaveLength(0);
  });

  it('un procedimiento de otra clínica, inexistente o retirado da 404; un diagnóstico, 422', async () => {
    const { repo, create } = setup();
    const other = 'bbbbbbbb-0000-4000-8000-000000000009';
    for (const id of [other, GONE]) {
      const promise = create.execute(
        { name: 'X', lines: [{ catalogItemId: ENDO }, { catalogItemId: id }] },
        AUDIT_CTX,
      );
      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await codeOf(
          create.execute(
            { name: 'X', lines: [{ catalogItemId: id }] },
            AUDIT_CTX,
          ),
        ),
      ).toBe(PLAN_TEMPLATE_CATALOG_ITEM_NOT_FOUND);
    }
    const diagnosis = create.execute(
      { name: 'X', lines: [{ catalogItemId: CARIES }] },
      AUDIT_CTX,
    );
    await expect(diagnosis).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(
      await codeOf(
        create.execute(
          { name: 'X', lines: [{ catalogItemId: CARIES }] },
          AUDIT_CTX,
        ),
      ),
    ).toBe(PLAN_TEMPLATE_NOT_A_PROCEDURE);
    expect(repo.rows).toHaveLength(0);
  });

  it('admite un procedimiento desactivado y lo marca al leer', async () => {
    const { create, get } = setup();
    const created = await create.execute(
      { name: 'Con inactivo', lines: [{ catalogItemId: OLD }] },
      AUDIT_CTX,
    );
    expect((await get.execute(created.id)).lines[0].catalogItemActive).toBe(
      false,
    );
  });

  it('un nombre repetido (sin mayúsculas) da 409', async () => {
    const { create } = setup();
    await create.execute(ENDO_CROWN, AUDIT_CTX);
    const promise = create.execute(
      { ...ENDO_CROWN, name: 'ENDODONCIA + CORONA' },
      AUDIT_CTX,
    );
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    expect(
      await codeOf(
        create.execute(
          { ...ENDO_CROWN, name: 'endodoncia + corona' },
          AUDIT_CTX,
        ),
      ),
    ).toBe(PLAN_TEMPLATE_DUPLICATE_NAME);
  });

  it('editar con otra versión da 409 PLAN_TEMPLATE_STALE sin escribir', async () => {
    const { repo, create, update } = setup();
    const created = await create.execute(ENDO_CROWN, AUDIT_CTX);
    expect(
      await codeOf(
        update.execute(created.id, { name: 'Otra', version: 2 }, AUDIT_CTX),
      ),
    ).toBe(PLAN_TEMPLATE_STALE);
    expect(repo.rows[0].name).toBe('Endodoncia + corona');
  });

  it('sustituye las líneas enteras y valida la plantilla resultante', async () => {
    const { create, update } = setup();
    const created = await create.execute(ENDO_CROWN, AUDIT_CTX);
    // Quitar las visitas 2 y 3 con sus intervalos vigentes no vale.
    await expect(
      update.execute(
        created.id,
        { lines: [{ catalogItemId: ENDO }], version: 1 },
        AUDIT_CTX,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    const updated = await update.execute(
      created.id,
      {
        lines: [{ catalogItemId: CROWN, quantity: 2 }],
        visitIntervals: {},
        version: 1,
      },
      AUDIT_CTX,
    );
    expect(updated.version).toBe(2);
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]).toMatchObject({
      catalogItemId: CROWN,
      quantity: 2,
    });
  });

  it('desactivar solo cambia `active`; la lista por defecto la oculta', async () => {
    const { create, update, list } = setup();
    const created = await create.execute(ENDO_CROWN, AUDIT_CTX);
    await update.execute(created.id, { active: false, version: 1 }, AUDIT_CTX);
    expect(await list.execute({})).toEqual([]);
    expect(await list.execute({ includeInactive: true })).toHaveLength(1);
  });

  it('una plantilla inexistente da 404', async () => {
    const { get, update } = setup();
    await expect(get.execute('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      update.execute('nope', { active: false, version: 1 }, AUDIT_CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
