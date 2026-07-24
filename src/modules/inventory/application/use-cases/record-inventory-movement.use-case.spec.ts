import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InventoryMovementType } from '@prisma/client';
import { RecordInventoryMovementUseCase } from './record-inventory-movement.use-case';
import { InMemoryInventoryRepository } from './__fixtures__/in-memory-inventory.repository';

describe('RecordInventoryMovementUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryInventoryRepository();
    return { repo, uc: new RecordInventoryMovementUseCase(repo) };
  }

  it('throws NotFoundException when the item is absent (or another tenant)', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        itemId: 'missing-id',
        type: InventoryMovementType.IN,
        quantity: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException for a movement on a soft-deleted item', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem({
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(
      uc.execute({
        itemId: item.id,
        type: InventoryMovementType.IN,
        quantity: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persists an IN movement with quantity > 0', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    const movement = await uc.execute(
      {
        itemId: item.id,
        type: InventoryMovementType.IN,
        quantity: 10,
        reason: 'restock',
      },
      'user-1',
    );

    expect(movement.type).toBe(InventoryMovementType.IN);
    expect(movement.quantity).toBe(10);
    expect(movement.reason).toBe('restock');
    expect(movement.createdById).toBe('user-1');
    const stock = await repo.sumSignedQuantity(item.id);
    expect(stock).toBe(10);
  });

  it('rejects IN with quantity <= 0 with 400', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    await expect(
      uc.execute({
        itemId: item.id,
        type: InventoryMovementType.IN,
        quantity: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.execute({
        itemId: item.id,
        type: InventoryMovementType.IN,
        quantity: -5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects OUT with quantity <= 0 with 400', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    await expect(
      uc.execute({
        itemId: item.id,
        type: InventoryMovementType.OUT,
        quantity: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.execute({
        itemId: item.id,
        type: InventoryMovementType.OUT,
        quantity: -1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects ADJUSTMENT with quantity === 0 with 400', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();

    await expect(
      uc.execute({
        itemId: item.id,
        type: InventoryMovementType.ADJUSTMENT,
        quantity: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a negative ADJUSTMENT quantity (correcting a past overcount)', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 10,
    });

    const movement = await uc.execute({
      itemId: item.id,
      type: InventoryMovementType.ADJUSTMENT,
      quantity: -3,
    });

    expect(movement.quantity).toBe(-3);
    const stock = await repo.sumSignedQuantity(item.id);
    expect(stock).toBe(7);
  });

  it('allows OUT to push stock negative (v1 permits shrinkage/mismatch)', async () => {
    const { repo, uc } = makeUseCase();
    const item = repo.seedItem();
    repo.seedMovement({
      itemId: item.id,
      type: InventoryMovementType.IN,
      quantity: 2,
    });

    await uc.execute({
      itemId: item.id,
      type: InventoryMovementType.OUT,
      quantity: 5,
    });

    const stock = await repo.sumSignedQuantity(item.id);
    expect(stock).toBe(-3);
  });
});
