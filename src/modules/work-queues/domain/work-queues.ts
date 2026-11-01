import { ClinicRole } from '@prisma/client';

/**
 * «Mi día» (DX-503): las listas de trabajo que ya existen, cada una con su
 * recuento de siempre. No hay listas nuevas: cada clave es una lista con su
 * pantalla y su `/count` (o su `total`) en la API.
 *
 * El orden es el de la bandeja (lo que cierra el día primero, luego lo que se
 * llama, luego el material).
 */
export const WORK_QUEUE_KEYS = [
  'CLOSING_QUEUE',
  'ANAMNESIS_REVIEW',
  'QUOTE_FOLLOW_UP',
  'ACCEPTED_UNSCHEDULED',
  'WAITLIST',
  'RECEIVABLES',
  'LOW_STOCK',
] as const;

export type WorkQueueKey = (typeof WORK_QUEUE_KEYS)[number];

/**
 * Qué listas son trabajo de cada rol. Cada entrada COPIA el `@Roles(...)` del
 * endpoint que alimenta la lista, o lo ACOTA cuando el dato no es trabajo de
 * ese rol (aceptados sin agendar y la lista de espera los lee cualquiera, pero
 * los agenda el mostrador). Nunca lo amplía: `work-queues-summary.use-case.spec.ts` comprueba
 * que cada conjunto está dentro del de su endpoint. Es la misma matriz que el
 * bloque «Pendientes» de Inicio (`inicio-roles.ts` en la web).
 */
export const WORK_QUEUE_ROLES: Record<WorkQueueKey, readonly ClinicRole[]> = {
  // GET /closing-queue/count — CLOSING_QUEUE_ROLES.
  CLOSING_QUEUE: [ClinicRole.ADMIN, ClinicRole.DENTIST, ClinicRole.RECEPTION],
  // GET /medical-history/submissions/summary — CLINICAL_ROLES.
  ANAMNESIS_REVIEW: [
    ClinicRole.ADMIN,
    ClinicRole.DENTIST,
    ClinicRole.ASSISTANT,
  ],
  // GET /treatment-plans/pending-follow-up/count — TREATMENT_PLAN_FOLLOW_UP_ROLES.
  QUOTE_FOLLOW_UP: [ClinicRole.ADMIN, ClinicRole.RECEPTION],
  // GET /treatment-plans/unscheduled/count — los 4 roles; lo agenda el mostrador.
  ACCEPTED_UNSCHEDULED: [ClinicRole.ADMIN, ClinicRole.RECEPTION],
  // GET /waitlist (total) — APPOINTMENT_ROLES; lo agenda el mostrador.
  WAITLIST: [ClinicRole.ADMIN, ClinicRole.RECEPTION],
  // GET /receivables/aging/summary — RECEIVABLES_ROLES.
  RECEIVABLES: [ClinicRole.ADMIN, ClinicRole.RECEPTION],
  // GET /inventory/items?lowStockOnly (total) — INVENTORY_ROLES.
  LOW_STOCK: [ClinicRole.ADMIN, ClinicRole.ASSISTANT],
};

/** Las listas del rol, en el orden de la bandeja. */
export function workQueuesFor(role: ClinicRole): WorkQueueKey[] {
  return WORK_QUEUE_KEYS.filter((key) => WORK_QUEUE_ROLES[key].includes(role));
}

/** Lo vencido de una moneda de la cartera (sin convertir ni sumar monedas). */
export interface OverdueAmount {
  currency: string;
  amount: number;
}

/** Lo que devuelve la fuente de una lista. */
export interface WorkQueueValue {
  count: number;
  /** Solo RECEIVABLES: lo vencido por moneda (las que tienen algo). */
  overdue?: OverdueAmount[];
}

export type WorkQueueItem =
  | ({ key: WorkQueueKey; status: 'OK' } & WorkQueueValue)
  | { key: WorkQueueKey; status: 'ERROR'; count: null };

export interface WorkQueuesSummary {
  /** Instante del cálculo (todas las listas, a la vez). */
  generatedAt: string;
  items: WorkQueueItem[];
}
