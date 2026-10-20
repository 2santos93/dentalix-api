import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CashSessionStatus, PaymentMethod } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  civilDateIn,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import { arqueo, centsOf, fromCents } from '../../domain/arqueo';
import {
  CASH_MAX_AMOUNT,
  CASH_MAX_CURRENCIES,
  type CashActor,
  type CashAdjustmentView,
  type CashSessionDetail,
  type CashSessionSummary,
  type CashSettings,
} from '../../domain/cash-session.entity';
import {
  CASH_SESSION_REPOSITORY,
  type CashSessionRepository,
  type CashSessionScope,
  type ClosingDraft,
} from '../../domain/ports/cash-session-repository.port';
import {
  CASH_SESSIONS_CLOCK,
  type CashSessionsClock,
} from '../cash-sessions-clock';

export const SESSION_NOT_FOUND_MESSAGE = 'Caja no encontrada.';
export const UNKNOWN_LOCATION_MESSAGE = 'La sede no es de esta clínica.';
export const ALREADY_OPEN_MESSAGE =
  'Ya tienes una caja abierta en esta sede: ciérrala antes de abrir otra.';
export const SESSION_CLOSED_MESSAGE =
  'Esta caja ya está cerrada: un cierre no se edita. Para corregirlo, un administrador puede reabrirla o registrar un ajuste.';
export const DIFFERENCE_REASON_REQUIRED_MESSAGE =
  'El arqueo no cuadra: explica el motivo de la diferencia antes de cerrar.';
export const NOT_CLOSED_MESSAGE =
  'La caja no está cerrada: mientras está abierta, el arqueo del cierre lo recoge todo.';
export const REOPEN_CONFLICT_MESSAGE =
  'Quien abrió esta caja ya tiene otra abierta en la sede: tiene que cerrarla antes de reabrir esta.';
export const DUPLICATE_CURRENCY_MESSAGE =
  'Cada moneda va una sola vez en el fondo inicial.';
export const DUPLICATE_COUNT_MESSAGE =
  'Cada moneda y método va una sola vez en el arqueo.';
export const TOO_MANY_CURRENCIES_MESSAGE = `El fondo inicial admite como mucho ${CASH_MAX_CURRENCIES} monedas.`;
export const AMOUNT_PRECISION_MESSAGE =
  'Los importes admiten como mucho 2 decimales.';
export const ZERO_ADJUSTMENT_MESSAGE = 'El ajuste no puede ser 0.';
export const INVALID_PERIOD_MESSAGE =
  'El período no es válido: fechas AAAA-MM-DD, la inicial antes de la final y como mucho 366 días.';

const MAX_PERIOD_DAYS = 366;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const scopeFor = (actor: CashActor): CashSessionScope =>
  actor.isAdmin ? {} : { openedById: actor.userId };

const unknownCurrencies = (codes: string[]) =>
  `Monedas desconocidas: ${codes.join(', ')}.`;

const trimmed = (value?: string | null): string | null =>
  value?.trim() ? value.trim() : null;

/**
 * Céntimos exactos de un importe que ya pasó la validación del DTO. Tiene 2
 * decimales como mucho si `céntimos / 100` vuelve al MISMO número: comparar
 * `amount * 100` con un entero falla por el error del coma flotante en
 * importes grandes (555555555.55 × 100 = 55555555554.999…).
 */
function exactCents(amount: number): number {
  const cents = centsOf(amount);
  if (
    !Number.isFinite(amount) ||
    fromCents(cents) !== amount ||
    Math.abs(amount) > CASH_MAX_AMOUNT
  ) {
    throw new BadRequestException(AMOUNT_PRECISION_MESSAGE);
  }
  return cents;
}

async function assertCurrencies(
  repo: CashSessionRepository,
  codes: string[],
): Promise<void> {
  if (codes.length === 0) return;
  const missing = await repo.missingCurrencies([...new Set(codes)]);
  if (missing.length > 0) {
    throw new BadRequestException(unknownCurrencies(missing));
  }
}

// ---------------------------------------------------------------------------
// Ajustes de caja de la clínica
// ---------------------------------------------------------------------------

@Injectable()
export class GetCashSettingsUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
  ) {}

  execute(): Promise<CashSettings> {
    return this.repo.getSettings();
  }
}

@Injectable()
export class UpdateCashSettingsUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
  ) {}

  execute(settings: CashSettings): Promise<CashSettings> {
    return this.repo.updateSettings(settings);
  }
}

// ---------------------------------------------------------------------------
// Detalle (y lo que puede hacer quien consulta)
// ---------------------------------------------------------------------------

/**
 * Una caja con su arqueo. RECEPTION solo ve las suyas (404 si no). Con
 * «arqueo ciego» y la caja abierta, quien no es ADMIN no ve el esperado ni la
 * lista de abonos del turno: cuenta antes de verlos.
 */
@Injectable()
export class GetCashSessionUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(id: string, actor: CashActor): Promise<CashSessionDetail> {
    const [record, settings] = await Promise.all([
      this.repo.detail(id, scopeFor(actor)),
      this.repo.getSettings(),
    ]);
    if (!record) throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    // DX-089: una caja de una sede no permitida es 403 (no 404: existe).
    this.tenantContext.assertLocationAllowed(record.location.id);
    const open = record.status === 'OPEN';
    const blindHidden = open && settings.blindClose && !actor.isAdmin;
    return {
      ...record,
      blindHidden,
      expected: blindHidden ? null : record.expected,
      payments: blindHidden ? null : record.payments,
      can: {
        close: open && (actor.isAdmin || record.openedBy.id === actor.userId),
        reopen: !open && actor.isAdmin,
        adjust: !open && actor.isAdmin,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Caja actual de quien consulta
// ---------------------------------------------------------------------------

export interface CurrentCashSession {
  locationId: string;
  settings: CashSettings;
  session: CashSessionDetail | null;
}

@Injectable()
export class GetCurrentCashSessionUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
    private readonly getSession: GetCashSessionUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    actor: CashActor,
    locationId?: string,
  ): Promise<CurrentCashSession> {
    if (locationId) this.tenantContext.assertLocationAllowed(locationId);
    const location = await this.repo.resolveLocation(
      locationId ?? this.tenantContext.getLocationId(),
    );
    if (!location) throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
    const [settings, openId] = await Promise.all([
      this.repo.getSettings(),
      this.repo.findOpenId(location, actor.userId),
    ]);
    return {
      locationId: location,
      settings,
      session: openId ? await this.getSession.execute(openId, actor) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Abrir
// ---------------------------------------------------------------------------

export interface OpenCashSessionInput {
  locationId?: string;
  floats: { currency: string; amount: number }[];
  notes?: string | null;
}

/**
 * Abre la caja de quien llama (del token, nunca del cuerpo) en la sede pedida,
 * la activa o la principal, con su fondo por moneda. Una por (sede, usuario).
 */
@Injectable()
export class OpenCashSessionUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
    private readonly getSession: GetCashSessionUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    input: OpenCashSessionInput,
    actor: CashActor,
  ): Promise<CashSessionDetail> {
    const floats = input.floats.map((float) => ({
      currency: float.currency.trim().toUpperCase(),
      cents: exactCents(float.amount),
    }));
    const currencies = floats.map((f) => f.currency);
    if (new Set(currencies).size !== currencies.length) {
      throw new BadRequestException(DUPLICATE_CURRENCY_MESSAGE);
    }
    if (floats.length > CASH_MAX_CURRENCIES) {
      throw new BadRequestException(TOO_MANY_CURRENCIES_MESSAGE);
    }
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const locationId = await this.repo.resolveLocation(
      input.locationId ?? this.tenantContext.getLocationId(),
    );
    if (!locationId) throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
    await assertCurrencies(this.repo, currencies);

    const opened = await this.repo.open({
      locationId,
      openedById: actor.userId,
      floats,
      notes: trimmed(input.notes),
    });
    if (opened === 'ALREADY_OPEN') {
      throw new ConflictException(ALREADY_OPEN_MESSAGE);
    }
    return this.getSession.execute(opened.id, actor);
  }
}

// ---------------------------------------------------------------------------
// Listar
// ---------------------------------------------------------------------------

export interface ListCashSessionsInput {
  locationId?: string;
  from?: string;
  to?: string;
  status?: CashSessionStatus;
  page?: number;
  pageSize?: number;
}

export interface CashSessionPage {
  items: CashSessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** ADMIN ve todas; RECEPTION solo las suyas. Más recientes primero. */
@Injectable()
export class ListCashSessionsUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    input: ListCashSessionsInput,
    actor: CashActor,
  ): Promise<CashSessionPage> {
    const from =
      input.from === undefined ? undefined : parseCivilDate(input.from);
    const to = input.to === undefined ? undefined : parseCivilDate(input.to);
    if (from === null || to === null) {
      throw new BadRequestException(INVALID_PERIOD_MESSAGE);
    }
    if (from && to) {
      const days = civilDaysInclusive(from, to);
      if (days < 1 || days > MAX_PERIOD_DAYS) {
        throw new BadRequestException(INVALID_PERIOD_MESSAGE);
      }
    }
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE),
    );
    // DX-089: sede explícita (permitida), la del request o las permitidas.
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const result = await this.repo.list({
      ...scopeFor(actor),
      locationIds: input.locationId
        ? [input.locationId]
        : this.tenantContext.scopeLocationIds(),
      from,
      to,
      status: input.status,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { ...result, page, pageSize };
  }
}

// ---------------------------------------------------------------------------
// Cerrar
// ---------------------------------------------------------------------------

export interface CloseCashSessionInput {
  counts: { currency: string; method: PaymentMethod; counted: number }[];
  differenceReason?: string | null;
  notes?: string | null;
}

/**
 * Cierra con arqueo: el esperado lo calcula el repositorio con la caja
 * bloqueada; aquí se compara con lo contado. Una diferencia distinta de 0
 * exige motivo (el mensaje no dice cuánto: con arqueo ciego, quien cuenta aún
 * no ha visto el esperado). ADMIN cierra cualquiera; RECEPTION, las suyas.
 */
@Injectable()
export class CloseCashSessionUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
    private readonly getSession: GetCashSessionUseCase,
    @Inject(CASH_SESSIONS_CLOCK) private readonly now: CashSessionsClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    id: string,
    input: CloseCashSessionInput,
    actor: CashActor,
  ): Promise<CashSessionDetail> {
    const counts = input.counts.map((count) => ({
      currency: count.currency.trim().toUpperCase(),
      method: count.method,
      cents: exactCents(count.counted),
    }));
    await assertCurrencies(
      this.repo,
      counts.map((c) => c.currency),
    );
    const reason = trimmed(input.differenceReason);
    const notes = trimmed(input.notes);
    const now = this.now();

    const outcome = await this.repo.close(
      id,
      scopeFor(actor),
      actor.userId,
      (context): ClosingDraft => {
        // DX-089: con la caja bloqueada; el 403 deshace la transacción.
        this.tenantContext.assertLocationAllowed(context.locationId);
        let result: ReturnType<typeof arqueo>;
        try {
          result = arqueo(context.expected, counts);
        } catch (error) {
          if (error instanceof RangeError) {
            throw new BadRequestException(DUPLICATE_COUNT_MESSAGE);
          }
          throw error;
        }
        if (result.hasDifference && reason === null) {
          throw new BadRequestException(DIFFERENCE_REASON_REQUIRED_MESSAGE);
        }
        return {
          lines: result.lines,
          hasDifference: result.hasDifference,
          differenceReason: result.hasDifference ? reason : null,
          notes,
          blind: context.blind,
          suggestedLockDate: civilDateIn(now, context.timeZone),
        };
      },
    );
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    }
    if (outcome === 'NOT_OPEN') {
      throw new ConflictException(SESSION_CLOSED_MESSAGE);
    }
    return this.getSession.execute(id, actor);
  }
}

// ---------------------------------------------------------------------------
// Reabrir (solo ADMIN, a nivel de ruta)
// ---------------------------------------------------------------------------

@Injectable()
export class ReopenCashSessionUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
    private readonly getSession: GetCashSessionUseCase,
  ) {}

  async execute(
    id: string,
    reason: string,
    actor: CashActor,
  ): Promise<CashSessionDetail> {
    const outcome = await this.repo.reopen(id, actor.userId, reason.trim());
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    }
    if (outcome === 'NOT_CLOSED') {
      throw new ConflictException(NOT_CLOSED_MESSAGE);
    }
    if (outcome === 'ALREADY_OPEN') {
      throw new ConflictException(REOPEN_CONFLICT_MESSAGE);
    }
    return this.getSession.execute(id, actor);
  }
}

// ---------------------------------------------------------------------------
// Corregir un cierre (solo ADMIN, a nivel de ruta)
// ---------------------------------------------------------------------------

export interface AddCashAdjustmentInput {
  currency: string;
  method: PaymentMethod;
  amount: number;
  reason: string;
}

/**
 * Un cierre no se edita: la corrección es un ajuste con motivo y autor, que
 * cuenta en la caja abierta de quien la hace en esa sede (o en la siguiente
 * que se abra) y enlaza la caja cerrada.
 */
@Injectable()
export class AddCashAdjustmentUseCase {
  constructor(
    @Inject(CASH_SESSION_REPOSITORY)
    private readonly repo: CashSessionRepository,
  ) {}

  async execute(
    id: string,
    input: AddCashAdjustmentInput,
    actor: CashActor,
  ): Promise<CashAdjustmentView> {
    const cents = exactCents(input.amount);
    if (cents === 0) throw new BadRequestException(ZERO_ADJUSTMENT_MESSAGE);
    const currency = input.currency.trim().toUpperCase();
    await assertCurrencies(this.repo, [currency]);
    const outcome = await this.repo.addCorrection(id, {
      currency,
      method: input.method,
      cents,
      reason: input.reason.trim(),
      createdById: actor.userId,
    });
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'NOT_CLOSED') {
      throw new ConflictException(NOT_CLOSED_MESSAGE);
    }
    return outcome.adjustment;
  }
}
