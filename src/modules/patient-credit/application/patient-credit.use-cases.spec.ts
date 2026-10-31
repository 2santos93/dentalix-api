import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type {
  PatientCreditRepository,
  PlanCreditState,
} from '../domain/ports/patient-credit-repository.port';
import {
  RefundCreditUseCase,
  TransferCreditUseCase,
} from './patient-credit.use-cases';

const ADMIN = { userId: 'u-admin', role: ClinicRole.ADMIN };
const RECEPTION = { userId: 'u-recep', role: ClinicRole.RECEPTION };
const KEY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function plan(
  id: string,
  extra: Partial<PlanCreditState> = {},
): PlanCreditState {
  return {
    planId: id,
    patientId: 'pat-1',
    status: 'ACCEPTED',
    currency: 'COP',
    billableCents: 0,
    paidCents: 0,
    entriesCents: 0,
    creditCents: 0,
    ...extra,
  };
}

function repo(plans: PlanCreditState[], capCents = 0) {
  const byId = new Map(plans.map((p) => [p.planId, p]));
  const createTransfer = jest.fn((input: { sourcePlanId: string }) =>
    Promise.resolve({ id: 't-1', sourcePlanId: input.sourcePlanId }),
  );
  const createRefund = jest.fn(() => Promise.resolve({ id: 'r-1' }));
  const findTransferByKey = jest.fn(() => Promise.resolve(null));
  const mock = {
    readPlanCredit: (id: string) => Promise.resolve(byId.get(id) ?? null),
    receptionCapCents: () => Promise.resolve(capCents),
    updateReceptionCap: jest.fn(),
    findTransferByKey,
    findRefundByKey: () => Promise.resolve(null),
    createTransfer,
    createRefund,
    getRefund: jest.fn(),
    listByPatient: jest.fn(),
  } as unknown as PatientCreditRepository;
  return { mock, createTransfer, createRefund, findTransferByKey };
}

const origin = plan('origen', {
  status: 'CANCELLED',
  paidCents: 30_000_000,
  creditCents: 30_000_000,
});

describe('TransferCreditUseCase (DX-253)', () => {
  it('traspasa a un plan vivo del mismo paciente con el importe en céntimos', async () => {
    const r = repo([origin, plan('destino')]);
    await new TransferCreditUseCase(r.mock).execute(
      'origen',
      { targetPlanId: 'destino', amount: 200_000, currency: 'cop' },
      ADMIN,
      KEY,
    );
    expect(r.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 20_000_000,
        currency: 'COP',
        idempotencyKey: KEY,
      }),
    );
  });

  it.each([
    [
      'otro paciente',
      plan('destino', { patientId: 'pat-2' }),
      BadRequestException,
    ],
    ['otra moneda', plan('destino', { currency: 'USD' }), BadRequestException],
    [
      'plan cancelado',
      plan('destino', { status: 'CANCELLED' }),
      ConflictException,
    ],
  ])('destino de %s: rechazado sin guardar', async (_, target, error) => {
    const r = repo([origin, target]);
    await expect(
      new TransferCreditUseCase(r.mock).execute(
        'origen',
        { targetPlanId: 'destino', amount: 1, currency: 'COP' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(error);
    expect(r.createTransfer).not.toHaveBeenCalled();
  });

  it('el mismo plan, más que el saldo o un plan inexistente', async () => {
    const r = repo([origin, plan('destino')]);
    const uc = new TransferCreditUseCase(r.mock);
    await expect(
      uc.execute(
        'origen',
        { targetPlanId: 'origen', amount: 1, currency: 'COP' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.execute(
        'origen',
        { targetPlanId: 'destino', amount: 300_000.01, currency: 'COP' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.execute(
        'nada',
        { targetPlanId: 'destino', amount: 1, currency: 'COP' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la misma clave con otro cuerpo es 422', async () => {
    const r = repo([origin, plan('destino')]);
    r.findTransferByKey.mockResolvedValue({
      id: 't-0',
      idempotencyFingerprint: 'otra',
    } as never);
    await expect(
      new TransferCreditUseCase(r.mock).execute(
        'origen',
        { targetPlanId: 'destino', amount: 1, currency: 'COP' },
        ADMIN,
        KEY,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('RefundCreditUseCase (DX-253)', () => {
  const body = {
    amount: 50_000,
    currency: 'COP',
    method: 'CASH' as const,
    reason: 'Se muda',
    paymentIds: ['p-1'],
  };

  it('RECEPTION: con el tope por defecto (0) 403; hasta el tope sí', async () => {
    await expect(
      new RefundCreditUseCase(repo([origin]).mock).execute(
        'origen',
        body,
        RECEPTION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const r = repo([origin], 5_000_000);
    await new RefundCreditUseCase(r.mock).execute('origen', body, RECEPTION);
    expect(r.createRefund).toHaveBeenCalled();
    await expect(
      new RefundCreditUseCase(repo([origin], 4_999_999).mock).execute(
        'origen',
        body,
        RECEPTION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['sin motivo', { reason: '  ' }],
    ['sin abonos de referencia', { paymentIds: [] }],
    ['otra moneda', { currency: 'USD' }],
    ['más que el saldo', { amount: 300_000.01 }],
  ])('%s: 400', async (_, extra) => {
    const r = repo([origin]);
    await expect(
      new RefundCreditUseCase(r.mock).execute(
        'origen',
        { ...body, ...extra },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(r.createRefund).not.toHaveBeenCalled();
  });

  it('Idempotency-Key que no es UUID: 400', async () => {
    await expect(
      new RefundCreditUseCase(repo([origin]).mock).execute(
        'origen',
        body,
        ADMIN,
        'x',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
