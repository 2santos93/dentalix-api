import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CollectionChannel, CollectionOutcome } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  addCivilDays,
  civilDateIn,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import {
  COLLECTIONS_REPOSITORY,
  type CollectionsRepository,
} from '../../domain/ports/collections-repository.port';
import {
  COLLECTION_NOTE_TEXT_MAX,
  type CollectionNoteView,
  type PatientCollections,
  type PaymentPromiseRow,
  type PaymentPromiseView,
} from '../../domain/collections.entity';
import { evaluatePromise } from '../../domain/payment-promise-rule';
import { COLLECTIONS_CLOCK, type CollectionsClock } from '../collections-clock';

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado.';
export const NOTE_TEXT_TOO_LONG_MESSAGE = `La nota admite hasta ${COLLECTION_NOTE_TEXT_MAX} caracteres.`;
export const UNKNOWN_CURRENCY_MESSAGE = 'La moneda no existe.';
export const UNKNOWN_LOCATION_MESSAGE = 'La sede no es de esta clínica.';
export const PROMISE_IN_PAST_MESSAGE =
  'La fecha del compromiso no puede ser anterior a hoy.';
export const PROMISE_TOO_FAR_MESSAGE =
  'La fecha del compromiso no puede estar a más de un año.';
export const PROMISE_ALREADY_OPEN_MESSAGE =
  'El paciente ya tiene un compromiso de pago abierto: se cierra solo al cumplirse o al vencer.';

/** Máximo de días hasta la fecha de un compromiso. */
export const PROMISE_MAX_DAYS_AHEAD = 365;

export interface CreateCollectionNoteInput {
  channel: CollectionChannel;
  outcome: CollectionOutcome;
  text?: string | null;
}

export interface CreatePaymentPromiseInput {
  amount: number;
  currency: string;
  /** Día civil YYYY-MM-DD en la zona de la sede. */
  dueDate: string;
  /** Sede del compromiso; sin ella, la activa o la de la deuda. */
  locationId?: string;
}

/**
 * Registrar una gestión de cobro (DX-150). Append-only: no hay editar ni
 * borrar; una corrección es otra nota. El texto es opcional y corto; nunca va
 * a logs ni a la auditoría (el evento solo lleva los nombres de los campos).
 */
@Injectable()
export class CreateCollectionNoteUseCase {
  constructor(
    @Inject(COLLECTIONS_REPOSITORY)
    private readonly repo: CollectionsRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    patientId: string,
    input: CreateCollectionNoteInput,
    authorId: string,
  ): Promise<CollectionNoteView> {
    const text = input.text?.trim() ? input.text.trim() : null;
    if (text !== null && text.length > COLLECTION_NOTE_TEXT_MAX) {
      throw new BadRequestException(NOTE_TEXT_TOO_LONG_MESSAGE);
    }
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    return this.repo.createNote({
      patientId,
      locationId: this.tenantContext.getLocationId() ?? null,
      channel: input.channel,
      outcome: input.outcome,
      text,
      authorId,
    });
  }
}

/**
 * Compromiso de pago (DX-150): importe, moneda y día en la zona de su sede.
 * Uno abierto por paciente. Nace OPEN; solo lo cierra el barrido de cobranza
 * o el abono que lo cubre (SettlePaymentPromises).
 */
@Injectable()
export class CreatePaymentPromiseUseCase {
  constructor(
    @Inject(COLLECTIONS_REPOSITORY)
    private readonly repo: CollectionsRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(COLLECTIONS_CLOCK) private readonly now: CollectionsClock,
  ) {}

  async execute(
    patientId: string,
    input: CreatePaymentPromiseInput,
    createdById: string,
  ): Promise<PaymentPromiseView> {
    const dueDate = parseCivilDate(input.dueDate);
    if (dueDate === null) {
      throw new BadRequestException(
        'dueDate debe ser una fecha válida (AAAA-MM-DD).',
      );
    }
    const currency = input.currency.trim().toUpperCase();
    if (!(await this.repo.currencyExists(currency))) {
      throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
    }
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const requested = input.locationId ?? this.tenantContext.getLocationId();
    if (requested && !(await this.repo.locationExists(requested))) {
      throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
    }
    const locationId =
      requested ?? (await this.repo.defaultLocationFor(patientId));

    const today = civilDateIn(
      this.now(),
      await this.repo.timeZoneOf(locationId),
    );
    if (dueDate < today) {
      throw new BadRequestException(PROMISE_IN_PAST_MESSAGE);
    }
    if (dueDate > addCivilDays(today, PROMISE_MAX_DAYS_AHEAD)) {
      throw new BadRequestException(PROMISE_TOO_FAR_MESSAGE);
    }

    const created = await this.repo.createPromise({
      patientId,
      locationId,
      amount: input.amount,
      currency,
      dueDate,
      createdById,
    });
    if (!created) throw new ConflictException(PROMISE_ALREADY_OPEN_MESSAGE);
    return withoutZone(created, 0);
  }
}

function withoutZone(
  row: PaymentPromiseRow,
  covered: number,
): PaymentPromiseView {
  const { timeZone: _zone, ...view } = row;
  void _zone;
  return { ...view, covered };
}

/**
 * Bloque «Cobranza» de la ficha (DX-150): notas y compromisos del paciente,
 * más recientes primero, con lo cubierto de cada compromiso. Consultas fijas:
 * notas, compromisos, nombres, zonas y abonos desde el compromiso más antiguo.
 */
@Injectable()
export class GetPatientCollectionsUseCase {
  constructor(
    @Inject(COLLECTIONS_REPOSITORY)
    private readonly repo: CollectionsRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(COLLECTIONS_CLOCK) private readonly now: CollectionsClock,
  ) {}

  async execute(patientId: string): Promise<PatientCollections> {
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const rows = await this.repo.listForPatient(patientId);
    if (rows.promises.length === 0) {
      return { notes: rows.notes, promises: [] };
    }
    const since = new Date(
      Math.min(...rows.promises.map((p) => p.createdAt.getTime())),
    );
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const payments = await this.repo.paymentsSince(
      tenantId,
      [patientId],
      since,
    );
    const now = this.now();
    return {
      notes: rows.notes,
      promises: rows.promises.map((p) =>
        withoutZone(
          p,
          evaluatePromise(p, payments, { now, timeZone: p.timeZone }).covered,
        ),
      ),
    };
  }
}
