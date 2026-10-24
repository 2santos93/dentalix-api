import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ChargeCancellationFeeUseCase,
  GetCancellationFeeUseCase,
  WaiveCancellationFeeUseCase,
  type FeeActor,
} from './cancellation-fee.use-cases';
import type {
  CancellationFeeContext,
  CancellationFeeRepository,
  ChargeFeeInput,
  FeeWriteOutcome,
  WaiveFeeInput,
} from '../domain/ports/cancellation-fee-repository.port';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPT = '22222222-2222-4222-8222-222222222222';
const ADMIN: FeeActor = { userId: 'u-admin', role: 'ADMIN' };
const RECEPTION: FeeActor = { userId: 'u-rec', role: 'RECEPTION' };

/** Doble en memoria de UNA cita: el repositorio real lo prueban int y e2e. */
class FakeFeeRepo implements CancellationFeeRepository {
  ctx: CancellationFeeContext | null = {
    appointment: {
      id: APPT,
      patientId: 'p-1',
      locationId: 'loc-1',
      start: new Date('2026-10-24T15:00:00Z'),
      status: 'NO_SHOW',
      lateCancellation: null,
      policyVersionId: 'v1',
    },
    communicated: {
      id: 'v1',
      version: 1,
      noticeHours: 24,
      suggestedFee: 50000,
      currency: 'COP',
    },
    receptionCanCharge: false,
    locationCountry: 'CO',
    locationTimeZone: 'America/Bogota',
    coverages: [],
    fee: null,
  };
  charges: ChargeFeeInput[] = [];
  waives: WaiveFeeInput[] = [];
  next: FeeWriteOutcome['outcome'] = 'OK';

  loadContext() {
    return Promise.resolve(this.ctx);
  }

  charge(input: ChargeFeeInput): Promise<FeeWriteOutcome> {
    this.charges.push(input);
    if (this.next !== 'OK') return Promise.resolve({ outcome: this.next });
    this.ctx!.fee = {
      id: 'fee-1',
      status: 'CHARGED',
      amount: input.amount,
      currency: input.currency,
      planId: 'plan-1',
      planItemId: 'item-1',
      planItemRemoved: false,
      waiveReason: null,
      policyVersionId: input.expectedPolicyVersionId,
      createdAt: new Date(),
      createdByName: 'Admin',
    };
    return Promise.resolve({ outcome: 'OK', fee: this.ctx!.fee });
  }

  waive(input: WaiveFeeInput): Promise<FeeWriteOutcome> {
    this.waives.push(input);
    this.ctx!.fee = {
      id: 'fee-2',
      status: 'WAIVED',
      amount: null,
      currency: null,
      planId: null,
      planItemId: null,
      planItemRemoved: false,
      waiveReason: input.reason,
      policyVersionId: null,
      createdAt: new Date(),
      createdByName: 'Admin',
    };
    return Promise.resolve({ outcome: 'OK', fee: this.ctx!.fee });
  }
}

describe('casos de uso del cargo por inasistencia (DX-291)', () => {
  let repo: FakeFeeRepo;
  let ctx: TenantContextService;
  const run = <T>(fn: () => Promise<T>, allowed?: string[]) =>
    ctx.run(TENANT, undefined, fn, allowed);
  const charge = (amount?: number, actor = ADMIN, epsBlock = true) =>
    run(() =>
      new ChargeCancellationFeeUseCase(repo, ctx, epsBlock).execute(
        APPT,
        amount,
        actor,
      ),
    );

  beforeEach(() => {
    repo = new FakeFeeRepo();
    ctx = new TenantContextService();
  });

  it('genera el cargo con el importe sugerido de la versión comunicada', async () => {
    const view = await charge();
    expect(repo.charges).toEqual([
      {
        appointmentId: APPT,
        amount: 50000,
        currency: 'COP',
        expectedStatus: 'NO_SHOW',
        expectedPolicyVersionId: 'v1',
        createdById: 'u-admin',
      },
    ]);
    expect(view).toMatchObject({
      status: 'CHARGED',
      patientId: 'p-1',
      chargeBlock: 'ALREADY_CHARGED',
      fee: { amount: 50000, planId: 'plan-1' },
    });
  });

  it('editable a la baja; por encima del sugerido: 400 y no se escribe', async () => {
    await expect(charge(60000)).rejects.toThrow(BadRequestException);
    expect(repo.charges).toHaveLength(0);
    await charge(20000);
    expect(repo.charges[0].amount).toBe(20000);
  });

  it('sin política comunicada: 409 «No consta…»', async () => {
    repo.ctx!.appointment.policyVersionId = null;
    repo.ctx!.communicated = null;
    await expect(charge()).rejects.toThrow(
      new ConflictException(
        'No consta que el paciente fuera informado de la política.',
      ),
    );
  });

  it('EPS_CO activa en Colombia: 409 (Ley 1438); con el bloqueo apagado por la plataforma, se cobra', async () => {
    repo.ctx!.coverages = [
      { payerType: 'EPS_CO', validFrom: null, validTo: null },
    ];
    await expect(charge()).rejects.toThrow(/Ley 1438/);
    await expect(charge(undefined, ADMIN, false)).resolves.toMatchObject({
      status: 'CHARGED',
    });
  });

  it('RECEPTION: 403 si la política no lo permite; con permiso, cobra', async () => {
    await expect(charge(undefined, RECEPTION)).rejects.toThrow(
      ForbiddenException,
    );
    repo.ctx!.receptionCanCharge = true;
    await expect(charge(undefined, RECEPTION)).resolves.toMatchObject({
      status: 'CHARGED',
    });
  });

  it('otra petición ganó la carrera: 409 «ya tiene su cargo»', async () => {
    repo.next = 'EXISTS';
    repo.ctx!.fee = null;
    const promise = charge();
    // El doble relee: simulamos que la otra petición dejó el cargo.
    repo.ctx!.fee = {
      id: 'fee-x',
      status: 'CHARGED',
      amount: 50000,
      currency: 'COP',
      planId: 'p',
      planItemId: 'i',
      planItemRemoved: false,
      waiveReason: null,
      policyVersionId: 'v1',
      createdAt: new Date(),
      createdByName: null,
    };
    await expect(promise).rejects.toThrow(
      new ConflictException('Esta cita ya tiene su cargo generado.'),
    );
  });

  it('cita de otra clínica: 404; de una sede no permitida: 403', async () => {
    repo.ctx = null;
    await expect(charge()).rejects.toThrow(NotFoundException);
    repo = new FakeFeeRepo();
    await expect(
      run(
        () =>
          new GetCancellationFeeUseCase(repo, ctx, true).execute(APPT, ADMIN),
        ['otra-sede'],
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('condonar exige motivo (400), queda WAIVED y luego cobrar da 409', async () => {
    const waive = (reason?: string) =>
      run(() =>
        new WaiveCancellationFeeUseCase(repo, ctx, true).execute(
          APPT,
          reason,
          ADMIN,
        ),
      );
    await expect(waive('  ')).rejects.toThrow(BadRequestException);
    const view = await waive('  Hospitalización  ');
    expect(repo.waives[0].reason).toBe('Hospitalización');
    expect(view.status).toBe('WAIVED');
    await expect(charge()).rejects.toThrow(
      new ConflictException('El cargo de esta cita ya se condonó.'),
    );
    await expect(waive('Otra vez')).rejects.toThrow(ConflictException);
  });

  it('la vista dice si se puede cobrar y si el usuario puede decidir', async () => {
    const view = await run(() =>
      new GetCancellationFeeUseCase(repo, ctx, true).execute(APPT, RECEPTION),
    );
    expect(view).toMatchObject({
      eligible: true,
      status: 'NONE',
      chargeBlock: null,
      canManage: false,
      communicated: { suggestedFee: 50000, currency: 'COP', version: 1 },
    });
  });
});
