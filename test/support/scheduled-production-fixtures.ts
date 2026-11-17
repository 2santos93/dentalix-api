import { randomUUID } from 'node:crypto';
import {
  AppointmentStatus,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { ReportSeeder } from './reports-fixtures';

/**
 * DX-567: citas, presupuestos y vínculos fijos para la «Producción agendada y
 * previsión del mes», sembrados por `raw` (DIRECT_URL, owner) con los
 * triggers apagados (`session_replication_role = replica`): así se fijan
 * citas pasadas en cualquier estado y vínculos a ítems ya realizados sin
 * montar el flujo de la agenda. Los CHECK y las EXCLUDE siguen activos (cada
 * cita va en su propia media hora del día). Las sedes están en
 * America/Caracas (UTC−4 fijo) salvo que el test cambie la zona; la clínica
 * tiene el catálogo en USD y las tasas MANUALES sin plazo (solo las del día).
 */

/** Instante de la hora de pared `hhmm` del día `day` en Caracas. */
export function caracas(day: string, hhmm = '11:00'): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + 4, min));
}

export interface ScheduledClinic {
  tenantId: string;
  seed: ReportSeeder;
  main: string;
  norte: string;
  patientId: string;
  dentist: { id: string; userId: string };
  otherDentistId: string;
}

export interface ItemSpec {
  price: number;
  discount?: number;
  status?: TreatmentPlanItemStatus;
  /** Solo DONE: cuándo, dónde y quién lo realizó (DX-050). */
  completedAt?: Date | null;
  performedLocationId?: string | null;
  performedById?: string | null;
  deletedAt?: Date;
}

export function scheduledProductionSeeding(raw: PrismaClient) {
  function withoutTriggers<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return raw.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        return fn(tx);
      },
      { timeout: 300_000 },
    );
  }

  async function clinic(
    subdomain: string,
    opts: { rateSource?: 'MANUAL' | 'AUTOMATIC' } = {},
  ): Promise<ScheduledClinic> {
    const manual = (opts.rateSource ?? 'MANUAL') === 'MANUAL';
    const tenant = await raw.tenant.create({
      data: {
        name: subdomain,
        subdomain,
        catalogCurrency: 'USD',
        exchangeRateSource: manual ? 'MANUAL' : 'AUTOMATIC',
        ...(manual
          ? {
              manualExchangeRatesSince: new Date('2026-01-01T00:00:00Z'),
              // Sin plazo: un día sin tasa propia no hereda la del anterior.
              manualRateMaxAgeDays: 0,
            }
          : {}),
      },
    });
    const seed = new ReportSeeder(raw, tenant.id);
    const main = await seed.location('Sede principal');
    const norte = await seed.location('Sede Norte');
    const dentist = await seed.dentist();
    const otherDentistId = await seed.provider(`Dr. Otro ${subdomain}`);
    const patientId = await seed.patient(subdomain);
    return {
      tenantId: tenant.id,
      seed,
      main,
      norte,
      patientId,
      dentist,
      otherDentistId,
    };
  }

  const catalogItems = new Map<string, string>();
  async function catalogItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const known = catalogItems.get(tenantId);
    if (known) return known;
    const created = await tx.dentalCatalogItem.create({
      data: {
        tenantId,
        code: `RES-${tenantId.slice(0, 8)}`,
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    catalogItems.set(tenantId, created.id);
    return created.id;
  }

  /** Un plan ACCEPTED con sus ítems; devuelve los ids de los ítems. */
  async function plan(
    c: ScheduledClinic,
    items: ItemSpec[],
    opts: { currency?: string; deletedAt?: Date; patientId?: string } = {},
  ): Promise<string[]> {
    const id = randomUUID();
    const patientId = opts.patientId ?? c.patientId;
    const ids = items.map(() => randomUUID());
    await withoutTriggers(async (tx) => {
      await tx.treatmentPlan.create({
        data: {
          id,
          tenantId: c.tenantId,
          patientId,
          status: 'ACCEPTED',
          currency: opts.currency ?? 'USD',
          acceptedAt: new Date('2026-10-01T15:00:00Z'),
          createdById: c.dentist.userId,
          deletedAt: opts.deletedAt ?? null,
        },
      });
      const catalogItemId = await catalogItem(tx, c.tenantId);
      for (const [n, item] of items.entries()) {
        // La FK compuesta de DX-050: quien lo realizó, con su membresía.
        const membership = item.performedById
          ? await tx.clinicMembership.findFirstOrThrow({
              where: { tenantId: c.tenantId, userId: item.performedById },
              select: { id: true },
            })
          : null;
        await tx.treatmentPlanItem.create({
          data: {
            id: ids[n],
            tenantId: c.tenantId,
            planId: id,
            patientId,
            toothNumber: String(11 + n),
            catalogItemId,
            price: item.price,
            discount: item.discount ?? 0,
            status: item.status ?? 'ACCEPTED',
            completedAt: item.completedAt ?? null,
            performedLocationId: item.performedLocationId ?? null,
            performedById: item.performedById ?? null,
            performedByMembershipId: membership?.id ?? null,
            deletedAt: item.deletedAt ?? null,
          },
        });
      }
    });
    return ids;
  }

  // Cada cita en su media hora del día (por clínica): sin solapes de
  // profesional ni de paciente.
  const slots = new Map<string, number>();
  /** Una cita del día civil `day` (Caracas) con esos ítems vinculados. */
  async function appointment(
    c: ScheduledClinic,
    day: string,
    opts: {
      items?: string[];
      status?: AppointmentStatus;
      locationId?: string;
      providerId?: string;
      patientId?: string;
      deleted?: boolean;
      /** Vínculos borrados (a estos ítems). */
      deletedLinks?: string[];
      /** Hora UTC exacta (para cruzar zonas). */
      start?: Date;
    } = {},
  ): Promise<string> {
    const key = `${c.tenantId}|${day}`;
    const n = slots.get(key) ?? 0;
    slots.set(key, n + 1);
    const start =
      opts.start ?? new Date(caracas(day, '07:00').getTime() + n * 30 * 60_000);
    const patientId = opts.patientId ?? c.patientId;
    const id = randomUUID();
    await withoutTriggers(async (tx) => {
      await tx.appointment.create({
        data: {
          id,
          tenantId: c.tenantId,
          locationId: opts.locationId ?? c.main,
          patientId,
          providerId: opts.providerId ?? c.dentist.userId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: opts.status ?? 'SCHEDULED',
          deletedAt: opts.deleted ? new Date() : null,
        },
      });
      for (const [itemId, deleted] of [
        ...(opts.items ?? []).map((i) => [i, false] as const),
        ...(opts.deletedLinks ?? []).map((i) => [i, true] as const),
      ]) {
        await tx.appointmentPlanItem.create({
          data: {
            tenantId: c.tenantId,
            patientId,
            appointmentId: id,
            planItemId: itemId,
            deletedAt: deleted ? new Date() : null,
          },
        });
      }
    });
    return id;
  }

  /** Una tasa manual del día (unidades de `currency` por 1 USD). */
  async function manualRate(
    c: ScheduledClinic,
    day: string,
    currency: string,
    rate: string,
  ): Promise<void> {
    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: c.tenantId, userId: c.dentist.userId },
      select: { id: true },
    });
    await raw.manualExchangeRate.create({
      data: {
        tenantId: c.tenantId,
        date: new Date(`${day}T00:00:00Z`),
        currency,
        rate: new Prisma.Decimal(rate),
        createdById: c.dentist.userId,
        createdByMembershipId: membership.id,
      },
    });
  }

  return { withoutTriggers, clinic, plan, appointment, manualRate };
}
