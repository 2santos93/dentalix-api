import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { UpdateCatalogItemUseCase } from './update-catalog-item.use-case';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CreateDentalCatalogItemRepoInput,
  DentalCatalogRepository,
  UpdateDentalCatalogItemRepoInput,
} from '../../domain/ports/dental-catalog-repository.port';
import type { CatalogNoteTemplateReader } from '../../domain/ports/catalog-note-template-reader.port';

function fakeItem(
  overrides: Partial<DentalCatalogItem> = {},
): DentalCatalogItem {
  return {
    id: 'c1',
    tenantId: 't1',
    code: 'CAR-001',
    category: null,
    kind: CatalogKind.DIAGNOSIS,
    labelEs: 'Caries',
    labelEn: null,
    labelPt: null,
    color: '#FF0000',
    defaultPrice: null,
    allowDiscount: true,
    active: true,
    clinicalNoteTemplateId: null,
    suggestedClinicalNoteTemplateId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** DX-455: sin plantillas; los casos del vínculo traen su propio lector. */
const noTemplates: CatalogNoteTemplateReader = {
  find: () => Promise.resolve(null),
};

function makeRepo(
  overrides: Partial<DentalCatalogRepository> = {},
): DentalCatalogRepository {
  return {
    create: (input: CreateDentalCatalogItemRepoInput) =>
      Promise.reject(
        new Error(
          `not implemented in this fake: create(${JSON.stringify(input)})`,
        ),
      ),
    findById: (): Promise<DentalCatalogItem | null> => Promise.resolve(null),
    list: (): Promise<DentalCatalogItem[]> => Promise.resolve([]),
    findByIds: () => Promise.resolve([]),
    listDirectory: () =>
      Promise.reject(new Error('not implemented in this fake')),
    update: (): Promise<DentalCatalogItem> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('UpdateCatalogItemUseCase', () => {
  it('updates fields and returns the updated entity', async () => {
    const existing = fakeItem();
    const updated = fakeItem({ labelEs: 'Caries profunda', active: false });
    let receivedId: string | undefined;
    let receivedPatch: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        receivedId = id;
        receivedPatch = patch;
        return Promise.resolve(updated);
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    const result = await uc.execute(existing.id, {
      labelEs: 'Caries profunda',
      active: false,
    });

    expect(result).toBe(updated);
    expect(receivedId).toBe(existing.id);
    expect(receivedPatch).toEqual({
      labelEs: 'Caries profunda',
      active: false,
    });
  });

  it('throws NotFoundException when the item does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findById: () => Promise.resolve(null),
      update: () => Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    await expect(
      uc.execute('missing-id', { active: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an invalid hex color in the patch', async () => {
    const existing = fakeItem();
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: () => Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    await expect(
      uc.execute(existing.id, { color: 'not-a-color' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid kind in the patch', async () => {
    const existing = fakeItem();
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: () => Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    const maliciousPatch = {
      kind: 'NOT_A_KIND',
    } as unknown as Parameters<typeof uc.execute>[1];

    await expect(
      uc.execute(existing.id, maliciousPatch),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a patch without color/kind to pass through untouched', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        receivedPatch = patch;
        return Promise.resolve(fakeItem({ category: 'X' }));
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    await uc.execute(existing.id, { category: 'X' });

    expect(receivedPatch).toEqual({ category: 'X' });
  });

  it('normalizes code (trim) in the patch when present', async () => {
    const existing = fakeItem();
    let receivedPatch: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string) =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        receivedPatch = patch;
        return Promise.resolve(fakeItem({ code: 'CAR-002' }));
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    await uc.execute(existing.id, { code: '  CAR-002  ' });

    expect(receivedPatch?.code).toBe('CAR-002');
  });
});

describe('UpdateCatalogItemUseCase · allowDiscount (DX-105)', () => {
  it('pasa allowDiscount al repositorio y devuelve la entidad actualizada', async () => {
    let received: UpdateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      findById: () => Promise.resolve(fakeItem()),
      update: (_id: string, patch: UpdateDentalCatalogItemRepoInput) => {
        received = patch;
        return Promise.resolve(
          fakeItem({ allowDiscount: patch.allowDiscount ?? true }),
        );
      },
    });
    const uc = new UpdateCatalogItemUseCase(repo, noTemplates);

    const result = await uc.execute('c1', { allowDiscount: false });

    expect(received).toEqual({ allowDiscount: false });
    expect(result.allowDiscount).toBe(false);
  });
});

describe('UpdateCatalogItemUseCase — plantilla de evolución (DX-455)', () => {
  const templates = (
    rows: { id: string; name: string; active: boolean }[],
  ): CatalogNoteTemplateReader => ({
    find: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
  });
  const procedure = fakeItem({ kind: CatalogKind.PROCEDURE });

  function capture() {
    const patches: UpdateDentalCatalogItemRepoInput[] = [];
    const repo = makeRepo({
      findById: () => Promise.resolve(procedure),
      update: (_id, patch) => {
        patches.push(patch);
        return Promise.resolve(procedure);
      },
    });
    return { repo, patches };
  }

  it('liga una plantilla activa de la clínica', async () => {
    const { repo, patches } = capture();
    const uc = new UpdateCatalogItemUseCase(
      repo,
      templates([{ id: 'tpl-1', name: 'Resina', active: true }]),
    );
    await uc.execute('c1', { clinicalNoteTemplateId: 'tpl-1' });
    expect(patches).toEqual([{ clinicalNoteTemplateId: 'tpl-1' }]);
  });

  it('null quita el vínculo sin leer la plantilla', async () => {
    const { repo, patches } = capture();
    const uc = new UpdateCatalogItemUseCase(repo, {
      find: () => Promise.reject(new Error('no debe leerse')),
    });
    await uc.execute('c1', { clinicalNoteTemplateId: null });
    expect(patches).toEqual([{ clinicalNoteTemplateId: null }]);
  });

  it('404 si no existe o es de otra clínica', async () => {
    const { repo, patches } = capture();
    const uc = new UpdateCatalogItemUseCase(repo, templates([]));
    await expect(
      uc.execute('c1', { clinicalNoteTemplateId: 'tpl-x' }),
    ).rejects.toThrow(
      new NotFoundException(
        'Plantilla de evolución no encontrada en esta clínica',
      ),
    );
    expect(patches).toEqual([]);
  });

  it('400 si la plantilla está desactivada', async () => {
    const { repo, patches } = capture();
    const uc = new UpdateCatalogItemUseCase(
      repo,
      templates([{ id: 'tpl-1', name: 'Resina', active: false }]),
    );
    await expect(
      uc.execute('c1', { clinicalNoteTemplateId: 'tpl-1' }),
    ).rejects.toThrow(
      'La plantilla «Resina» está desactivada: actívala en Ajustes → Plantillas de evolución o elige otra.',
    );
    expect(patches).toEqual([]);
  });

  it('400 en un diagnóstico, o al pasar a diagnóstico con el vínculo puesto', async () => {
    const diagnosis = fakeItem({ kind: CatalogKind.DIAGNOSIS });
    const reader = templates([{ id: 'tpl-1', name: 'Resina', active: true }]);
    const onDiagnosis = new UpdateCatalogItemUseCase(
      makeRepo({ findById: () => Promise.resolve(diagnosis) }),
      reader,
    );
    await expect(
      onDiagnosis.execute('c1', { clinicalNoteTemplateId: 'tpl-1' }),
    ).rejects.toThrow(/Solo un procedimiento/);

    const linked = fakeItem({
      kind: CatalogKind.PROCEDURE,
      clinicalNoteTemplateId: 'tpl-1',
    });
    const toDiagnosis = new UpdateCatalogItemUseCase(
      makeRepo({ findById: () => Promise.resolve(linked) }),
      reader,
    );
    await expect(
      toDiagnosis.execute('c1', { kind: CatalogKind.DIAGNOSIS }),
    ).rejects.toThrow(BadRequestException);
  });
});
