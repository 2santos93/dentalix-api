import { Inject, Injectable } from '@nestjs/common';
import {
  PLAN_OPTIONS_REPOSITORY,
  type PlanOptionsRepository,
} from '../../domain/ports/plan-options-repository.port';
import { daysSince } from '../../domain/plan-options';
import { whatsAppDigits } from '../../../../shared/phone/phone-number';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';

export const FOLLOW_UP_DEFAULT_DAYS = 7;
export const FOLLOW_UP_DEFAULT_PAGE_SIZE = 20;
export const FOLLOW_UP_MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ListPendingFollowUpInput {
  olderThanDays?: number;
  page?: number;
  pageSize?: number;
}

/** Un presupuesto presentado y sin aceptar, listo para llamar al paciente. */
export interface PendingFollowUpItem {
  planId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  /** E.164 sin `+` para `https://wa.me/…`; null si el teléfono no sirve. */
  patientWhatsApp: string | null;
  optionGroupId: string | null;
  optionLabel: string | null;
  presentedAt: Date;
  presentedLocationId: string;
  daysSincePresented: number;
  currency: string;
  total: number;
  itemCount: number;
}

export interface PendingFollowUpPage {
  items: PendingFollowUpItem[];
  total: number;
  page: number;
  pageSize: number;
}

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

@Injectable()
export class ListPendingFollowUpUseCase {
  constructor(
    @Inject(PLAN_OPTIONS_REPOSITORY)
    private readonly repo: PlanOptionsRepository,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  /**
   * Presupuestos por seguir (DX-040): planes PRESENTED hace más de N días
   * (7 por defecto) cuyo paciente no tiene cita futura, paginados (tope 100
   * por página) y con su monto en la moneda del plan. D2: la página es de
   * GRUPOS de opciones (A/B del mismo plan), así que puede traer más filas
   * que `pageSize`; `total` cuenta grupos.
   */
  async execute(input: ListPendingFollowUpInput): Promise<PendingFollowUpPage> {
    const now = this.now();
    const days = wholeOrDefault(input.olderThanDays, FOLLOW_UP_DEFAULT_DAYS, 0);
    const page = wholeOrDefault(input.page, 1, 1);
    const pageSize = Math.min(
      wholeOrDefault(input.pageSize, FOLLOW_UP_DEFAULT_PAGE_SIZE, 1),
      FOLLOW_UP_MAX_PAGE_SIZE,
    );
    const { rows, total } = await this.repo.listPendingFollowUp({
      presentedBefore: new Date(now.getTime() - days * DAY_MS),
      now,
      page,
      pageSize,
    });
    return {
      items: rows.map((row) => ({
        planId: row.planId,
        patientId: row.patientId,
        patientName: `${row.patientFirstName} ${row.patientLastName}`.trim(),
        patientPhone: row.patientPhone,
        // Misma lectura que el enlace de confirmación de citas: la región de
        // la sede del plan, nunca el país del paciente (DX-329, P1).
        patientWhatsApp: whatsAppDigits(
          row.patientPhone,
          row.presentedLocationPhoneRegion,
        ),
        optionGroupId: row.optionGroupId,
        optionLabel: row.optionLabel,
        presentedAt: row.presentedAt,
        presentedLocationId: row.presentedLocationId,
        daysSincePresented: daysSince(row.presentedAt, now),
        currency: row.currency,
        total: row.total,
        itemCount: row.itemCount,
      })),
      total,
      page,
      pageSize,
    };
  }
}
