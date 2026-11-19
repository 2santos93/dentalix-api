import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ClinicPaymentMethodEntity } from '../domain/payment-method.entity';
import type { PaymentMethodRepository } from '../domain/ports/payment-method-repository.port';
import { INITIAL_KIND_LOCKED_MESSAGE } from '../domain/payment-method-rules';
import {
  CreatePaymentMethodUseCase,
  GATEWAY_FEE_PERCENT_MESSAGE,
  SetPaymentMethodGatewayFeeUseCase,
  UpdatePaymentMethodUseCase,
} from './payment-methods.use-cases';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';

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
    proofPolicy: 'NONE',
    allowInPaymentLink: false,
    gatewayFeePercent: null,
    adjustments: [],
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
  const setGatewayFee = jest.fn((_id: string, percent: number | null) =>
    Promise.resolve(row ? { ...row, gatewayFeePercent: percent } : null),
  );
  const repo: PaymentMethodRepository = {
    list: jest.fn(),
    findById: jest.fn().mockResolvedValue(row),
    findByLegacyMethod: jest.fn(),
    nameTaken: jest.fn().mockResolvedValue(false),
    create: jest.fn(),
    update,
    createAdjustment: jest.fn(),
    updateAdjustment: jest.fn(),
    setGatewayFee,
  };
  return { repo, update, setGatewayFee };
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

describe('«Pide comprobante» (DX-389)', () => {
  it('un medio nuevo nace en NONE y admite elegir OPTIONAL o REQUIRED', async () => {
    const { repo } = repoWith(null);
    const create = jest.fn().mockResolvedValue(method({}));
    repo.create = create;
    const useCase = new CreatePaymentMethodUseCase(repo);

    await useCase.execute({ name: 'Zelle', kind: 'DIGITAL' }, 'u-1');
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ proofPolicy: 'NONE' }),
      'u-1',
    );
    await useCase.execute(
      { name: 'Pago móvil', kind: 'TRANSFER', proofPolicy: 'REQUIRED' },
      'u-1',
    );
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ proofPolicy: 'REQUIRED' }),
      'u-1',
    );
  });

  it('se cambia con el resto de los ajustes del medio, también en uno inicial', async () => {
    const { repo, update } = repoWith(method({ legacyMethod: 'TRANSFER' }));
    const useCase = new UpdatePaymentMethodUseCase(repo);

    const updated = await useCase.execute(
      'pm-1',
      { proofPolicy: 'OPTIONAL' },
      'u-1',
    );
    expect(update).toHaveBeenCalledWith(
      'pm-1',
      expect.objectContaining({ proofPolicy: 'OPTIONAL' }),
      'u-1',
    );
    expect(updated.proofPolicy).toBe('OPTIONAL');
  });
});

describe('SetPaymentMethodGatewayFeeUseCase (DX-018-bis)', () => {
  const ctx = {} as AuditRequestContext;

  it('guarda un % en (0, 100] con hasta 2 decimales, y null lo quita', async () => {
    const { repo, setGatewayFee } = repoWith(method({ kind: 'CARD' }));
    const useCase = new SetPaymentMethodGatewayFeeUseCase(repo);
    await expect(useCase.execute('pm-1', 3.5, ctx)).resolves.toMatchObject({
      gatewayFeePercent: 3.5,
    });
    await expect(useCase.execute('pm-1', null, ctx)).resolves.toMatchObject({
      gatewayFeePercent: null,
    });
    expect(setGatewayFee).toHaveBeenCalledWith('pm-1', 3.5, ctx);
  });

  it.each([0, -1, 100.01, 2.555, Number.NaN])(
    '%p no vale (400 en español, sin escribir)',
    async (percent) => {
      const { repo, setGatewayFee } = repoWith(method({}));
      const useCase = new SetPaymentMethodGatewayFeeUseCase(repo);
      await expect(useCase.execute('pm-1', percent, ctx)).rejects.toThrow(
        new BadRequestException(GATEWAY_FEE_PERCENT_MESSAGE),
      );
      expect(setGatewayFee).not.toHaveBeenCalled();
    },
  );

  it('medio de otra clínica o inexistente: 404', async () => {
    const { repo } = repoWith(null);
    await expect(
      new SetPaymentMethodGatewayFeeUseCase(repo).execute('x', 2, ctx),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
