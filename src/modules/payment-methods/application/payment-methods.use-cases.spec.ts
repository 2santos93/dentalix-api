import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ClinicPaymentMethodEntity } from '../domain/payment-method.entity';
import type { PaymentMethodRepository } from '../domain/ports/payment-method-repository.port';
import { INITIAL_KIND_LOCKED_MESSAGE } from '../domain/payment-method-rules';
import { UpdatePaymentMethodUseCase } from './payment-methods.use-cases';

function method(
  overrides: Partial<ClinicPaymentMethodEntity>,
): ClinicPaymentMethodEntity {
  return {
    id: 'pm-1',
    tenantId: 't-1',
    name: 'Efectivo',
    kind: 'CASH',
    active: true,
    requiresReference: false,
    legacyMethod: 'CASH',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function repoWith(row: ClinicPaymentMethodEntity | null) {
  const update = jest
    .fn()
    .mockImplementation((_id: string, data: object) =>
      Promise.resolve(row ? { ...row, ...data } : null),
    );
  const repo: PaymentMethodRepository = {
    list: jest.fn(),
    findById: jest.fn().mockResolvedValue(row),
    findByLegacyMethod: jest.fn(),
    nameTaken: jest.fn().mockResolvedValue(false),
    create: jest.fn(),
    update,
  };
  return { repo, update };
}

describe('UpdatePaymentMethodUseCase (DX-377)', () => {
  it('rechaza cambiar el tipo base de un medio inicial: los clientes anteriores lo usan por su método antiguo', async () => {
    const { repo, update } = repoWith(
      method({ legacyMethod: 'CASH', kind: 'CASH' }),
    );
    const useCase = new UpdatePaymentMethodUseCase(repo);

    await expect(
      useCase.execute('pm-1', { kind: 'CARD' }, 'u-1'),
    ).rejects.toThrow(new BadRequestException(INITIAL_KIND_LOCKED_MESSAGE));
    expect(update).not.toHaveBeenCalled();
  });

  it('un medio inicial admite el mismo tipo base, el nombre, activo y «pide referencia»', async () => {
    const { repo, update } = repoWith(
      method({ legacyMethod: 'TRANSFER', kind: 'TRANSFER' }),
    );
    const useCase = new UpdatePaymentMethodUseCase(repo);

    await useCase.execute(
      'pm-1',
      {
        kind: 'TRANSFER',
        name: 'Transferencia bancaria',
        requiresReference: true,
      },
      'u-1',
    );
    expect(update).toHaveBeenCalled();
  });

  it('un medio creado por la clínica puede cambiar de tipo base', async () => {
    const { repo, update } = repoWith(
      method({ legacyMethod: null, kind: 'DIGITAL' }),
    );
    const useCase = new UpdatePaymentMethodUseCase(repo);

    await useCase.execute('pm-1', { kind: 'TRANSFER' }, 'u-1');
    expect(update).toHaveBeenCalledWith(
      'pm-1',
      expect.objectContaining({ kind: 'TRANSFER' }),
      'u-1',
    );
  });

  it('404 si el medio no es de esta clínica', async () => {
    const { repo } = repoWith(null);
    const useCase = new UpdatePaymentMethodUseCase(repo);

    await expect(
      useCase.execute('pm-1', { kind: 'CARD' }, 'u-1'),
    ).rejects.toThrow(NotFoundException);
  });
});
