import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { formatMoney } from '../../../shared/money/format-money';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  CANCELLATION_FEE_MESSAGES,
  blockMessage,
  canManageFee,
  chargeBlockReason,
  hasActiveEpsCoverage,
  isFeeEligible,
  normalizeWaiveReason,
  resolveChargeAmount,
  voidBlockMessage,
  waiveBlockReason,
  type FeeBlockReason,
} from '../domain/cancellation-fee';
import {
  CANCELLATION_FEE_REPOSITORY,
  type CancellationFeeContext,
  type CancellationFeeRecord,
  type CancellationFeeRepository,
  type FeeWriteOutcome,
} from '../domain/ports/cancellation-fee-repository.port';

/** Bloqueo por EPS_CO (lo fija la plataforma; ver `epsCoBlockEnabled`). */
export const CANCELLATION_FEE_EPS_CO_BLOCK = Symbol(
  'CANCELLATION_FEE_EPS_CO_BLOCK',
);

/** Quién pide: el usuario y su rol en la clínica. */
export interface FeeActor {
  userId: string;
  role: ClinicRole;
}

/** El cargo de una cita tal como lo ve recepción/administración. */
export interface CancellationFeeView {
  appointmentId: string;
  patientId: string;
  /** NO_SHOW o cancelación tardía. */
  eligible: boolean;
  /** SEC-050: VOIDED = el cargo se generó y después se anuló con motivo. */
  status: 'NONE' | 'CHARGED' | 'WAIVED' | 'VOIDED';
  /** Por qué no se puede generar el cargo ahora (o `null`). */
  chargeBlock: FeeBlockReason | null;
  chargeBlockMessage: string | null;
  /** El usuario puede generar o condonar (ADMIN, o RECEPTION si se permite). */
  canManage: boolean;
  communicated: {
    policyVersionId: string;
    version: number;
    noticeHours: number;
    suggestedFee: number | null;
    currency: string | null;
  } | null;
  fee: CancellationFeeRecord | null;
}

const STALE =
  'La cita cambió mientras tanto. Vuelve a abrirla e inténtalo de nuevo.';

/** Común a los tres casos de uso: cita del tenant (404) y sede permitida (403). */
async function loadFor(
  repo: CancellationFeeRepository,
  tenantContext: TenantContextService,
  appointmentId: string,
): Promise<CancellationFeeContext> {
  const ctx = await repo.loadContext(appointmentId);
  if (!ctx)
    throw new NotFoundException(CANCELLATION_FEE_MESSAGES.appointmentNotFound);
  // DX-089: la cita de una sede no permitida es 403 (existe).
  tenantContext.assertLocationAllowed(ctx.appointment.locationId);
  return ctx;
}

function toView(
  ctx: CancellationFeeContext,
  actor: FeeActor,
  epsCoBlock: boolean,
  now: Date,
): CancellationFeeView {
  const block = chargeBlockReason({
    appointment: ctx.appointment,
    communicated: ctx.communicated,
    locationCountry: ctx.locationCountry,
    hasActiveEpsCo: hasActiveEpsCoverage(
      ctx.coverages,
      civilDateIn(now, ctx.locationTimeZone),
    ),
    epsCoBlockEnabled: epsCoBlock,
    existing: ctx.fee?.status ?? null,
  });
  return {
    appointmentId: ctx.appointment.id,
    patientId: ctx.appointment.patientId,
    eligible: isFeeEligible(ctx.appointment),
    status: ctx.fee?.voidedAt ? 'VOIDED' : (ctx.fee?.status ?? 'NONE'),
    chargeBlock: block,
    chargeBlockMessage: block ? blockMessage(block) : null,
    canManage: canManageFee(actor.role, ctx.receptionCanCharge),
    communicated: ctx.communicated
      ? {
          policyVersionId: ctx.communicated.id,
          version: ctx.communicated.version,
          noticeHours: ctx.communicated.noticeHours,
          suggestedFee: ctx.communicated.suggestedFee,
          currency: ctx.communicated.currency,
        }
      : null,
    fee: ctx.fee,
  };
}

function assertCanManage(ctx: CancellationFeeContext, actor: FeeActor): void {
  if (!canManageFee(actor.role, ctx.receptionCanCharge))
    throw new ForbiddenException(CANCELLATION_FEE_MESSAGES.forbidden);
}

/**
 * OK → la vista releída (ya con el cargo o la condonación); EXISTS → 409 con
 * lo que ya hay (otra petición ganó); STALE → 409 «la cita cambió».
 */
async function settle(
  outcome: FeeWriteOutcome,
  reload: () => Promise<CancellationFeeView>,
): Promise<CancellationFeeView> {
  if (outcome.outcome === 'STALE') throw new ConflictException(STALE);
  const view = await reload();
  if (outcome.outcome === 'OK') return view;
  throw new ConflictException(
    view.status === 'WAIVED'
      ? CANCELLATION_FEE_MESSAGES.alreadyWaived
      : CANCELLATION_FEE_MESSAGES.alreadyCharged,
  );
}

/** `GET /appointments/:id/cancellation-fee` (DX-291). */
@Injectable()
export class GetCancellationFeeUseCase {
  constructor(
    @Inject(CANCELLATION_FEE_REPOSITORY)
    private readonly repo: CancellationFeeRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(CANCELLATION_FEE_EPS_CO_BLOCK) private readonly epsCoBlock: boolean,
  ) {}

  async execute(
    appointmentId: string,
    actor: FeeActor,
  ): Promise<CancellationFeeView> {
    const ctx = await loadFor(this.repo, this.tenantContext, appointmentId);
    return toView(ctx, actor, this.epsCoBlock, new Date());
  }
}

/**
 * `POST /appointments/:id/cancellation-fee` (DX-291): genera el cargo de una
 * inasistencia o cancelación tardía con el importe sugerido de la versión
 * COMUNICADA (editable a la baja). 409 sin política comunicada, con EPS_CO
 * activa en Colombia o si ya hay cargo/condonación; 400 por encima del
 * sugerido.
 */
@Injectable()
export class ChargeCancellationFeeUseCase {
  constructor(
    @Inject(CANCELLATION_FEE_REPOSITORY)
    private readonly repo: CancellationFeeRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(CANCELLATION_FEE_EPS_CO_BLOCK) private readonly epsCoBlock: boolean,
  ) {}

  async execute(
    appointmentId: string,
    amount: number | undefined,
    actor: FeeActor,
  ): Promise<CancellationFeeView> {
    const ctx = await loadFor(this.repo, this.tenantContext, appointmentId);
    assertCanManage(ctx, actor);
    const view = toView(ctx, actor, this.epsCoBlock, new Date());
    if (view.chargeBlock)
      throw new ConflictException(blockMessage(view.chargeBlock));
    // chargeBlockReason ya exige versión comunicada con importe y moneda.
    const communicated = ctx.communicated!;
    const currency = communicated.currency!;
    const resolved = resolveChargeAmount(
      amount,
      communicated.suggestedFee!,
      (value) => formatMoney(value, currency),
    );
    if (!resolved.ok) throw new BadRequestException(resolved.message);

    const outcome = await this.repo.charge({
      appointmentId,
      amount: resolved.amount,
      currency,
      expectedStatus: ctx.appointment.status,
      expectedPolicyVersionId: communicated.id,
      createdById: actor.userId,
    });
    return settle(outcome, async () =>
      toView(
        await loadFor(this.repo, this.tenantContext, appointmentId),
        actor,
        this.epsCoBlock,
        new Date(),
      ),
    );
  }
}

/**
 * `POST /appointments/:id/cancellation-fee/waive` (DX-291): condona (no se
 * cobrará) con motivo. Solo antes de cobrar y una vez.
 */
@Injectable()
export class WaiveCancellationFeeUseCase {
  constructor(
    @Inject(CANCELLATION_FEE_REPOSITORY)
    private readonly repo: CancellationFeeRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(CANCELLATION_FEE_EPS_CO_BLOCK) private readonly epsCoBlock: boolean,
  ) {}

  async execute(
    appointmentId: string,
    rawReason: string | undefined,
    actor: FeeActor,
  ): Promise<CancellationFeeView> {
    const reason = normalizeWaiveReason(rawReason);
    if (!reason)
      throw new BadRequestException(CANCELLATION_FEE_MESSAGES.waiveReason);
    const ctx = await loadFor(this.repo, this.tenantContext, appointmentId);
    assertCanManage(ctx, actor);
    const block = waiveBlockReason(ctx.appointment, ctx.fee?.status ?? null);
    if (block) throw new ConflictException(blockMessage(block));
    const outcome = await this.repo.waive({
      appointmentId,
      reason,
      expectedStatus: ctx.appointment.status,
      createdById: actor.userId,
    });
    return settle(outcome, async () =>
      toView(
        await loadFor(this.repo, this.tenantContext, appointmentId),
        actor,
        this.epsCoBlock,
        new Date(),
      ),
    );
  }
}

/**
 * `POST /appointments/:id/cancellation-fee/void` (SEC-050): anula un cargo ya
 * generado, con motivo. Es la ÚNICA forma de dejarlo sin efecto: desde el plan
 * su ítem no cambia de precio, descuento ni estado ni se quita (409 para todo
 * rol). Mismo permiso que generarlo (ADMIN, o RECEPTION si la política de la
 * sede lo permite) y sede permitida (DX-089).
 */
@Injectable()
export class VoidCancellationFeeUseCase {
  constructor(
    @Inject(CANCELLATION_FEE_REPOSITORY)
    private readonly repo: CancellationFeeRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(CANCELLATION_FEE_EPS_CO_BLOCK) private readonly epsCoBlock: boolean,
  ) {}

  async execute(
    appointmentId: string,
    rawReason: string | undefined,
    actor: FeeActor,
  ): Promise<CancellationFeeView> {
    const reason = normalizeWaiveReason(rawReason);
    if (!reason)
      throw new BadRequestException(CANCELLATION_FEE_MESSAGES.voidReason);
    const ctx = await loadFor(this.repo, this.tenantContext, appointmentId);
    assertCanManage(ctx, actor);
    const blocked = voidBlockMessage(ctx.fee);
    if (blocked) throw new ConflictException(blocked);
    const outcome = await this.repo.voidFee({
      appointmentId,
      reason,
      voidedById: actor.userId,
    });
    switch (outcome.outcome) {
      case 'OK':
        return toView(
          await loadFor(this.repo, this.tenantContext, appointmentId),
          actor,
          this.epsCoBlock,
          new Date(),
        );
      case 'STALE':
        throw new ConflictException(STALE);
      case 'NOT_CHARGED':
        throw new ConflictException(CANCELLATION_FEE_MESSAGES.notCharged);
      case 'ALREADY_VOIDED':
        throw new ConflictException(CANCELLATION_FEE_MESSAGES.alreadyVoided);
      case 'PAID':
        throw new ConflictException(CANCELLATION_FEE_MESSAGES.voidPaid);
    }
  }
}
