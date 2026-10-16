import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { AddTreatmentPlanItemUseCase } from './add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from './update-treatment-plan-item.use-case';
import { RemoveTreatmentPlanItemUseCase } from './remove-treatment-plan-item.use-case';
import { UpdateTreatmentPlanUseCase } from './update-treatment-plan.use-case';
import { GetTreatmentPlanUseCase } from './get-treatment-plan.use-case';
import { SIGNED_PLAN_LOCKED_MESSAGE } from './signed-plan-lock';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../../../dental-catalog/domain/entities/dental-catalog-item.entity';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';

const CATALOG_ITEM: DentalCatalogItem = {
  id: 'cat1',
  tenantId: 't1',
  code: 'OBT-001',
  category: null,
  kind: CatalogKind.PROCEDURE,
  labelEs: 'Obturación',
  labelEn: null,
  labelPt: null,
  color: '#FFFFFF',
  defaultPrice: 200,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function catalog(): DentalCatalogRepository {
  const findById = (id: string) =>
    Promise.resolve(id === CATALOG_ITEM.id ? CATALOG_ITEM : null);
  const unused = () => Promise.reject(new Error('no usado en este spec'));
  return {
    create: unused,
    list: unused,
    listDirectory: unused,
    findById,
    update: unused,
  };
}

const whitelist: CurrencyWhitelist = { has: () => Promise.resolve(true) };

const SIGNED = {
  signerName: 'Ana Pérez',
  acceptedAt: new Date('2026-10-16T15:00:00.000Z'),
};

function setup(acceptance: typeof SIGNED | null) {
  const repo = new InMemoryTreatmentPlanRepository();
  const plan = repo.seedPlan({
    id: 'plan1',
    status: acceptance
      ? TreatmentPlanStatus.ACCEPTED
      : TreatmentPlanStatus.DRAFT,
    acceptance,
  });
  const item = repo.seedItem({
    id: 'item1',
    planId: plan.id,
    price: 200,
    discount: 20,
    status: acceptance
      ? TreatmentPlanItemStatus.ACCEPTED
      : TreatmentPlanItemStatus.PROPOSED,
  });
  return {
    repo,
    plan,
    item,
    add: new AddTreatmentPlanItemUseCase(repo, catalog()),
    update: new UpdateTreatmentPlanItemUseCase(repo, catalog()),
    remove: new RemoveTreatmentPlanItemUseCase(repo),
    updatePlan: new UpdateTreatmentPlanUseCase(
      repo,
      whitelist,
      () => new Date('2026-10-16T15:00:00.000Z'),
    ),
    get: new GetTreatmentPlanUseCase(repo),
  };
}

const DENTIST = { role: ClinicRole.DENTIST };

describe('Descuento por ítem (DX-012)', () => {
  it('el total del plan es Σ(precio − descuento)', async () => {
    const { get, add } = setup(null);
    await add.execute('plan1', {
      toothNumber: '21',
      catalogItemId: 'cat1',
      price: 100,
      discount: 15.5,
    });
    const detail = await get.execute('plan1');
    expect(detail.items.map((i) => i.discount)).toEqual([20, 15.5]);
    expect(detail.total).toBe(264.5);
  });

  it('el descuento se guarda (0 si se omite) y nunca supera el precio (400)', async () => {
    const { add, update } = setup(null);
    const created = await add.execute('plan1', {
      toothNumber: '21',
      catalogItemId: 'cat1',
    });
    expect(created.discount).toBe(0);
    await expect(
      add.execute('plan1', {
        toothNumber: '21',
        catalogItemId: 'cat1',
        price: 100,
        discount: 100.01,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Bajar el precio por debajo del descuento ya guardado (20) tampoco vale.
    await expect(update.execute('item1', { price: 10 })).rejects.toThrow(
      'El descuento no puede ser mayor que el precio',
    );
    await expect(
      update.execute('item1', { discount: 201 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await update.execute('item1', { discount: 50 })).discount).toBe(50);
  });
});

describe('Plan aceptado con firma: ítems congelados (DX-012)', () => {
  it('sin firma, todo sigue editable como antes', async () => {
    const { add, update, remove, updatePlan } = setup(null);
    await add.execute('plan1', { toothNumber: '21', catalogItemId: 'cat1' });
    await update.execute('item1', { price: 300, surfaces: ['MESIAL'] });
    await remove.execute('item1');
    await updatePlan.execute(
      'plan1',
      { currency: 'EUR', status: TreatmentPlanStatus.DRAFT },
      DENTIST,
    );
  });

  it('no admite ítems nuevos (409)', async () => {
    const { add } = setup(SIGNED);
    await expect(
      add.execute('plan1', { toothNumber: '21', catalogItemId: 'cat1' }),
    ).rejects.toThrow(SIGNED_PLAN_LOCKED_MESSAGE);
  });

  it('no admite cambiar precio, descuento, caras ni notas, ni volver a propuesto (409)', async () => {
    const { update } = setup(SIGNED);
    for (const patch of [
      { price: 300 },
      { discount: 0 },
      { surfaces: ['MESIAL' as const] },
      { notes: 'otra' },
      { status: TreatmentPlanItemStatus.PROPOSED },
    ]) {
      await expect(update.execute('item1', patch)).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
  });

  it('sí deja avanzar el tratamiento: marcar el ítem como realizado', async () => {
    const { update } = setup(SIGNED);
    const done = await update.execute('item1', {
      status: TreatmentPlanItemStatus.DONE,
    });
    expect(done.status).toBe(TreatmentPlanItemStatus.DONE);
  });

  it('no admite quitar un ítem (409)', async () => {
    const { remove } = setup(SIGNED);
    await expect(remove.execute('item1')).rejects.toThrow(
      SIGNED_PLAN_LOCKED_MESSAGE,
    );
  });

  it('el plan no cambia de moneda ni vuelve a borrador (409); sí se cierra y se anotan notas', async () => {
    const { updatePlan } = setup(SIGNED);
    await expect(
      updatePlan.execute('plan1', { currency: 'EUR' }, DENTIST),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      updatePlan.execute(
        'plan1',
        { status: TreatmentPlanStatus.DRAFT },
        DENTIST,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Repetir la moneda que ya tiene no es un cambio.
    await updatePlan.execute(
      'plan1',
      { currency: 'usd', notes: 'Seguimiento' },
      DENTIST,
    );
    const closed = await updatePlan.execute(
      'plan1',
      { status: TreatmentPlanStatus.COMPLETED },
      DENTIST,
    );
    expect(closed.status).toBe(TreatmentPlanStatus.COMPLETED);
  });

  it('el detalle del plan dice quién firmó y cuándo', async () => {
    const { get } = setup(SIGNED);
    expect((await get.execute('plan1')).acceptance).toEqual(SIGNED);
  });
});
