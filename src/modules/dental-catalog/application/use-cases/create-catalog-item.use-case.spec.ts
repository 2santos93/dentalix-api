import { BadRequestException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { CreateCatalogItemUseCase } from './create-catalog-item.use-case';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CreateDentalCatalogItemRepoInput,
  DentalCatalogRepository,
} from '../../domain/ports/dental-catalog-repository.port';
import type { CatalogNoteTemplateReader } from '../../domain/ports/catalog-note-template-reader.port';

function fakeItemFrom(
  id: string,
  input: CreateDentalCatalogItemRepoInput,
  tenantId = 't1',
): DentalCatalogItem {
  return {
    id,
    tenantId,
    code: input.code,
    category: input.category ?? null,
    kind: input.kind,
    labelEs: input.labelEs,
    labelEn: input.labelEn ?? null,
    labelPt: input.labelPt ?? null,
    color: input.color,
    defaultPrice: input.defaultPrice ?? null,
    allowDiscount: input.allowDiscount ?? true,
    active: input.active ?? true,
    clinicalNoteTemplateId: input.clinicalNoteTemplateId ?? null,
    suggestedClinicalNoteTemplateId: input.clinicalNoteTemplateId ?? null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
      Promise.resolve(fakeItemFrom('c1', input)),
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

describe('CreateCatalogItemUseCase', () => {
  it('creates a catalog item and returns the mapped entity', async () => {
    const repo = makeRepo();
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    const result = await uc.execute({
      code: 'CAR-001',
      kind: CatalogKind.DIAGNOSIS,
      labelEs: 'Caries',
      color: '#FF0000',
    });

    expect(result.id).toBe('c1');
    expect(result.code).toBe('CAR-001');
    expect(result.kind).toBe(CatalogKind.DIAGNOSIS);
    expect(result.color).toBe('#FF0000');
  });

  it('allowDiscount: false llega al repositorio; omitido, no se envía (el default es true en la BD)', async () => {
    const captured: CreateDentalCatalogItemRepoInput[] = [];
    const repo = makeRepo({
      create: (input) => {
        captured.push(input);
        return Promise.resolve(fakeItemFrom('c3', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);
    const base = {
      code: 'PRO-001',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Limpieza',
      color: '#00FF00',
    };

    const off = await uc.execute({ ...base, allowDiscount: false });
    const unset = await uc.execute(base);

    expect(captured[0].allowDiscount).toBe(false);
    expect(off.allowDiscount).toBe(false);
    expect(captured[1].allowDiscount).toBeUndefined();
    expect(unset.allowDiscount).toBe(true);
  });

  it('normalizes code (trim) before persisting', async () => {
    let captured: CreateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakeItemFrom('c2', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    await uc.execute({
      code: '  CAR-002  ',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Obturacion',
      color: '#00FF00',
    });

    expect(captured?.code).toBe('CAR-002');
  });

  it.each([
    'red',
    '#GGG',
    '123456',
    '#12',
    '#1234567890',
    '',
    '#12345',
    '#1234567',
  ])('rejects an invalid hex color (%s)', async (color) => {
    const repo = makeRepo();
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    await expect(
      uc.execute({
        code: 'CAR-003',
        kind: CatalogKind.DIAGNOSIS,
        labelEs: 'Caries',
        color,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    '#FFF',
    '#FFFF',
    '#FFFFFF',
    '#FFFFFFFF',
    '#000',
    '#1234',
    '#12345678',
  ])('accepts a valid hex color (%s)', async (color) => {
    const repo = makeRepo();
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    const result = await uc.execute({
      code: 'CAR-004',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Limpieza',
      color,
    });

    expect(result.color).toBe(color);
  });

  it('rejects a kind that is not a valid CatalogKind enum value', async () => {
    const repo = makeRepo();
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    // Bypass the type system deliberately: prove the use case validates at
    // runtime even though CreateCatalogItemInput['kind'] is typed as
    // CatalogKind for every legitimate caller.
    const maliciousInput = {
      code: 'CAR-005',
      kind: 'NOT_A_KIND',
      labelEs: 'Caries',
      color: '#FFFFFF',
    } as unknown as Parameters<typeof uc.execute>[0];

    await expect(uc.execute(maliciousInput)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never forwards a tenantId sneaked into the input to the repository (tenant comes from context, not input)', async () => {
    let captured:
      (CreateDentalCatalogItemRepoInput & { tenantId?: string }) | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakeItemFrom('c6', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    const maliciousInput = {
      code: 'CAR-006',
      kind: CatalogKind.DIAGNOSIS,
      labelEs: 'Caries',
      color: '#ABCDEF',
      tenantId: 'sneaky-tenant',
    } as unknown as Parameters<typeof uc.execute>[0];

    const result = await uc.execute(maliciousInput);

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(result.tenantId).toBe('t1'); // comes from the repo/context, not input
  });

  it('passes optional fields (category, i18n labels, defaultPrice, active) through untouched', async () => {
    let captured: CreateDentalCatalogItemRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakeItemFrom('c7', input));
      },
    });
    const uc = new CreateCatalogItemUseCase(repo, noTemplates);

    await uc.execute({
      code: 'CAR-007',
      category: 'Restaurativa',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Obturacion',
      labelEn: 'Filling',
      labelPt: 'Obturacao',
      color: '#123ABC',
      defaultPrice: 45000,
      active: false,
    });

    expect(captured).toMatchObject({
      category: 'Restaurativa',
      labelEn: 'Filling',
      labelPt: 'Obturacao',
      defaultPrice: 45000,
      active: false,
    });
  });

  it.each(['', '   ', '\t\n'])(
    'rejects a whitespace-only code (%j)',
    async (code) => {
      const repo = makeRepo();
      const uc = new CreateCatalogItemUseCase(repo, noTemplates);

      await expect(
        uc.execute({
          code,
          kind: CatalogKind.DIAGNOSIS,
          labelEs: 'Caries',
          color: '#FFFFFF',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});

describe('CreateCatalogItemUseCase — plantilla de evolución (DX-455)', () => {
  const input = {
    code: 'RES-01',
    kind: CatalogKind.PROCEDURE,
    labelEs: 'Resina',
    color: '#123456',
  };
  const reader = (active: boolean): CatalogNoteTemplateReader => ({
    find: (id) =>
      Promise.resolve(id === 'tpl-1' ? { id, name: 'Resina', active } : null),
  });
  const repo = () =>
    makeRepo({ create: (i) => Promise.resolve(fakeItemFrom('c1', i)) });

  it('da de alta el procedimiento con su plantilla', async () => {
    const created = await new CreateCatalogItemUseCase(
      repo(),
      reader(true),
    ).execute({ ...input, clinicalNoteTemplateId: 'tpl-1' });
    expect(created.clinicalNoteTemplateId).toBe('tpl-1');
  });

  it('404 con una plantilla ajena y 400 con una desactivada', async () => {
    await expect(
      new CreateCatalogItemUseCase(repo(), reader(true)).execute({
        ...input,
        clinicalNoteTemplateId: 'tpl-otra',
      }),
    ).rejects.toThrow(/no encontrada en esta clínica/);
    await expect(
      new CreateCatalogItemUseCase(repo(), reader(false)).execute({
        ...input,
        clinicalNoteTemplateId: 'tpl-1',
      }),
    ).rejects.toThrow(/está desactivada/);
  });
});
