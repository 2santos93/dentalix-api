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
  VoidCancellationFeeUseCase,
  WaiveCancellationFeeUseCase,
  type FeeActor,
} from './cancellation-fee.use-cases';
import type {
  CancellationFeeContext,
  CancellationFeeRepository,
  CancellationFeeRecord,
  ChargeFeeInput,
  FeeVoidOutcome,
  FeeWriteOutcome,
  VoidFeeInput,
  WaiveFeeInput,
} from '../domain/ports/cancellation-fee-repository.port';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPT = '22222222-2222-4222-8222-222222222222';
const ADMIN: FeeActor = { userId: 'u-admin', role: 'ADMIN' };
const RECEPTION: FeeActor = { userId: 'u-rec', role: 'RECEPTION' };

/** Campos de SEC-050 de un cargo sin anular, con el ítem cobrando lo suyo. */
const LIVE = {
  itemAmount: null,
  itemMismatch: false,
  voidedAt: null,
  voidedByName: null,
  voidReason: null,
} satisfies Partial<CancellationFeeRecord>;

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
    locationLocale: 'es-CO',
    locationHourCycle: 'h23',
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
      ...LIVE,
      itemAmount: input.amount,
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
      ...LIVE,
    };
    return Promise.resolve({ outcome: 'OK', fee: this.ctx!.fee });
  }

  voids: VoidFeeInput[] = [];
  nextVoid: FeeVoidOutcome['outcome'] = 'OK';

  voidFee(input: VoidFeeInput): Promise<FeeVoidOutcome> {
    this.voids.push(input);
    if (this.nextVoid !== 'OK')
      return Promise.resolve({ outcome: this.nextVoid });
    this.ctx!.fee = {
      ...this.ctx!.fee!,
      planItemRemoved: true,
      itemAmount: null,
      voidedAt: new Date(),
      voidedByName: 'Admin',
      voidReason: input.reason,
    };
    return Promise.resolve({ outcome: 'OK', fee: this.ctx!.fee });
  }
}

describe('casos de uso del cargo por inasistencia (DX-291)', () => {
  let repo: FakeFeeRepo;
  let ctx: TenantContextService;
  const run = <T>(fn: () => Promise<T>, allowed?: string[]) =>
    ctx.run(TENANT, undefined, fn, allowed);
  const charge = (amount?: number, actor = ADMIN) =>
    run(() =>
      new ChargeCancellationFeeUseCase(repo, ctx).execute(APPT, amount, actor),
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

  it('cancellation fee 400 uses the location format', async () => {
    repo.ctx!.locationLocale = 'en-US';
    repo.ctx!.locationHourCycle = 'h12';
    repo.ctx!.communicated!.currency = 'JPY';
    await expect(charge(60000)).rejects.toThrow(
      new BadRequestException(
        'El importe no puede superar el sugerido por la política comunicada (¥50,000).',
      ),
    );
    repo.ctx!.locationLocale = 'de-DE';
    repo.ctx!.locationHourCycle = 'h23';
    repo.ctx!.communicated!.currency = 'EUR';
    await expect(charge(60000)).rejects.toThrow(
      new BadRequestException(
        'El importe no puede superar el sugerido por la política comunicada (50.000,00\u00a0€).',
      ),
    );
    // Sin reloj: el 409 solo al pintar el importe; un cargo válido se cobra.
    repo.ctx!.locationHourCycle = null;
    const err = await charge(60000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
      locationId: 'loc-1',
    });
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

  it('charge succeeds for a patient with an active coverage of any payer type', async () => {
    // DX-321: el contexto ya no carga coberturas ni el país o la zona de la
    // sede; el cargo se decide igual para cualquier paciente.
    await expect(
      run(() => new GetCancellationFeeUseCase(repo, ctx).execute(APPT, ADMIN)),
    ).resolves.toMatchObject({ chargeBlock: null });
    await expect(charge()).resolves.toMatchObject({ status: 'CHARGED' });
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
      ...LIVE,
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
        () => new GetCancellationFeeUseCase(repo, ctx).execute(APPT, ADMIN),
        ['otra-sede'],
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('condonar exige motivo (400), queda WAIVED y luego cobrar da 409', async () => {
    const waive = (reason?: string) =>
      run(() =>
        new WaiveCancellationFeeUseCase(repo, ctx).execute(APPT, reason, ADMIN),
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
      new GetCancellationFeeUseCase(repo, ctx).execute(APPT, RECEPTION),
    );
    expect(view).toMatchObject({
      eligible: true,
      status: 'NONE',
      chargeBlock: null,
      canManage: false,
      communicated: { suggestedFee: 50000, currency: 'COP', version: 1 },
    });
  });

  describe('anular el cargo (SEC-050)', () => {
    const voidFee = (reason?: string, actor = ADMIN, allowed?: string[]) =>
      run(
        () =>
          new VoidCancellationFeeUseCase(repo, ctx).execute(
            APPT,
            reason,
            actor,
          ),
        allowed,
      );

    it('ADMIN anula con motivo: queda VOIDED con quién y por qué, y el ítem fuera del plan', async () => {
      await charge();
      const view = await voidFee('  Cargo generado por error  ');
      expect(repo.voids).toEqual([
        {
          appointmentId: APPT,
          reason: 'Cargo generado por error',
          voidedById: 'u-admin',
        },
      ]);
      expect(view).toMatchObject({
        status: 'VOIDED',
        fee: {
          voidReason: 'Cargo generado por error',
          planItemRemoved: true,
        },
      });
      // Una decisión por cita: ni otro cargo ni condonar.
      await expect(charge()).rejects.toThrow(ConflictException);
    });

    it('sin motivo (o de más de 500): 400 y no se escribe', async () => {
      await charge();
      await expect(voidFee('  ')).rejects.toThrow(
        new BadRequestException(
          'Indica el motivo de la anulación (entre 3 y 500 caracteres).',
        ),
      );
      await expect(voidFee('x'.repeat(501))).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.voids).toHaveLength(0);
    });

    it('RECEPTION: 403 si la política no lo permite; con permiso, anula', async () => {
      await charge();
      await expect(voidFee('Error', RECEPTION)).rejects.toThrow(
        ForbiddenException,
      );
      repo.ctx!.receptionCanCharge = true;
      await expect(voidFee('Error', RECEPTION)).resolves.toMatchObject({
        status: 'VOIDED',
      });
    });

    it('sede no permitida (DX-089): 403; de otra clínica: 404', async () => {
      await charge();
      await expect(voidFee('Error', ADMIN, ['otra-sede'])).rejects.toThrow(
        ForbiddenException,
      );
      repo.ctx = null;
      await expect(voidFee('Error')).rejects.toThrow(NotFoundException);
      expect(repo.voids).toHaveLength(0);
    });

    it('sin cargo, condonado o ya anulado: 409 en español', async () => {
      await expect(voidFee('Error')).rejects.toThrow(
        new ConflictException(
          'Esta cita no tiene un cargo generado que anular.',
        ),
      );
      await charge();
      await voidFee('Error');
      await expect(voidFee('Otra vez')).rejects.toThrow(
        new ConflictException('El cargo de esta cita ya se anuló.'),
      );
    });

    it('ya cobrado (PAID) u otra petición ganó (ALREADY_VOIDED): 409', async () => {
      await charge();
      repo.nextVoid = 'PAID';
      await expect(voidFee('Error')).rejects.toThrow(/Anula antes el abono/);
      repo.nextVoid = 'ALREADY_VOIDED';
      await expect(voidFee('Error')).rejects.toThrow(/ya se anuló/);
    });

    it('con abonos sin convertir a la moneda del plan (UNCONVERTED): 409 con el mensaje en español (DX-382)', async () => {
      await charge();
      repo.nextVoid = 'UNCONVERTED';
      await expect(voidFee('Error')).rejects.toThrow(
        new ConflictException(
          'Hay abonos sin convertir; registra la tasa del día antes de anular',
        ),
      );
    });
  });
});
