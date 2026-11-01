import { TEST_AUDIT } from '../../../audit/application/__fixtures__/test-audit-context';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateInventoryItemUseCase } from './create-inventory-item.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('CreateInventoryItemUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryInventoryRepository();
    return { repo, uc: new CreateInventoryItemUseCase(repo) };
  }

  it('creates an item with the given fields and default minStock 0', async () => {
    const { uc } = makeUseCase();

    const item = await uc.execute({ name: 'Gasas', unit: 'caja' }, TEST_AUDIT);

    expect(item.name).toBe('Gasas');
    expect(item.unit).toBe('caja');
    expect(item.minStock).toBe(0);
    expect(item.sku).toBeNull();
    expect(item.notes).toBeNull();
  });

  it('trims name/unit/sku and persists an explicit minStock', async () => {
    const { uc } = makeUseCase();

    const item = await uc.execute(
      {
        name: '  Guantes  ',
        unit: ' caja ',
        sku: ' GT-100 ',
        minStock: 5,
        notes: 'stock crítico',
      },
      TEST_AUDIT,
    );

    expect(item.name).toBe('Guantes');
    expect(item.unit).toBe('caja');
    expect(item.sku).toBe('GT-100');
    expect(item.minStock).toBe(5);
    expect(item.notes).toBe('stock crítico');
  });

  it('takes createdById from the audit actor, never from input', async () => {
    const { uc, repo } = makeUseCase();

    const item = await uc.execute(
      { name: 'Anestesia', unit: 'ml' },
      TEST_AUDIT,
    );

    expect(item.createdById).toBe(TEST_AUDIT.actor.userId);
    const stored = await repo.findItemById(item.id);
    expect(stored?.createdById).toBe(TEST_AUDIT.actor.userId);
  });

  it('rejects a blank name with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: '   ', unit: 'unidad' }, TEST_AUDIT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank unit with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: 'Gasas', unit: '   ' }, TEST_AUDIT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative minStock with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({ name: 'Gasas', unit: 'caja', minStock: -1 }, TEST_AUDIT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-finite minStock with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute(
        { name: 'Gasas', unit: 'caja', minStock: Infinity },
        TEST_AUDIT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // DX-042 (DB-011): el nombre es único por SEDE y sin distinguir mayúsculas
  // (índice de expresión en la base). Prisma no puede nombrar ese índice en el
  // P2002 bajo el rol de la app, así que el caso de uso lo traduce a un 409
  // con mensaje propio.
  it('maps a duplicate name in the same location (P2002) to a 409 with a clear message', async () => {
    const { repo, uc } = makeUseCase();
    jest.spyOn(repo, 'createItem').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    );

    await expect(
      uc.execute({ name: 'guantes', unit: 'caja' }, TEST_AUDIT),
    ).rejects.toThrow(
      new ConflictException('Ya existe un insumo con ese nombre en esta sede.'),
    );
  });

  it('does not mask other repository errors', async () => {
    const { repo, uc } = makeUseCase();
    jest.spyOn(repo, 'createItem').mockRejectedValue(new Error('boom'));

    await expect(
      uc.execute({ name: 'Gasas', unit: 'caja' }, TEST_AUDIT),
    ).rejects.toThrow('boom');
  });
});
