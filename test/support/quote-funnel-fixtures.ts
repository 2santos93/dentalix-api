import { randomUUID } from 'node:crypto';
import {
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import { ReportSeeder } from './reports-fixtures';

/**
 * DX-558: presupuestos fijos para el «Embudo de presupuestos», sembrados por
 * `raw` (DIRECT_URL, owner) con los triggers apagados
 * (`session_replication_role = replica`) para poder fijar las fechas de
 * presentación y aceptación en el pasado, partir planes (DX-417) e imputar
 * abonos sin montar el flujo de cobro. Los CHECK siguen activos. Las sedes
 * están en America/Caracas (UTC−4 fijo); la clínica tiene el catálogo en USD.
 */

/** Instante de la hora de pared `hhmm` del día `day` en Caracas. */
export function caracas(day: string, hhmm = '11:00'): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + 4, min));
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const plusDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

export interface ItemSpec {
  id?: string;
  price: number;
  discount?: number;
  status?: TreatmentPlanItemStatus;
  /** Moneda del catálogo congelada en el ítem (DX-502). */
  catalogCurrency?: string;
  /** Tasa catálogo → plan (unidades por 1 USD), DX-513-ter. */
  rate?: { from: number; to: number };
  deletedAt?: Date;
}

export interface PlanSpec {
  id?: string;
  status: TreatmentPlanStatus;
  currency?: string;
  presentedAt?: Date | null;
  locationId?: string | null;
  createdById?: string | null;
  optionGroupId?: string;
  splitFromPlanId?: string;
  acceptedAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: TreatmentPlanRejectionReason;
  deletedAt?: Date;
  patientId?: string;
  items: ItemSpec[];
}

export interface FunnelClinic {
  tenantId: string;
  seed: ReportSeeder;
  main: string;
  norte: string;
  patientId: string;
  dentist: { id: string; userId: string };
  otherDentistId: string;
}

export function quoteFunnelSeeding(raw: PrismaClient) {
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

  async function clinic(subdomain: string): Promise<FunnelClinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain, catalogCurrency: 'USD' },
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

  /** Un plan con sus ítems; devuelve los ids (plan e ítems, en orden). */
  async function plan(
    c: FunnelClinic,
    spec: PlanSpec,
  ): Promise<{ id: string; items: string[] }> {
    const id = spec.id ?? randomUUID();
    const patientId = spec.patientId ?? c.patientId;
    const items = spec.items.map((i) => i.id ?? randomUUID());
    await withoutTriggers(async (tx) => {
      await tx.treatmentPlan.create({
        data: {
          id,
          tenantId: c.tenantId,
          patientId,
          status: spec.status,
          currency: spec.currency ?? 'USD',
          presentedAt: spec.presentedAt ?? null,
          presentedLocationId:
            spec.locationId === undefined ? c.main : spec.locationId,
          createdById:
            spec.createdById === undefined
              ? c.dentist.userId
              : spec.createdById,
          optionGroupId: spec.optionGroupId ?? null,
          splitFromPlanId: spec.splitFromPlanId ?? null,
          acceptedAt: spec.acceptedAt ?? null,
          rejectedAt: spec.rejectedAt ?? null,
          rejectionReason: spec.rejectionReason ?? null,
          rejectionNote:
            spec.rejectionReason === 'OTHER' ? 'Otro motivo' : null,
          deletedAt: spec.deletedAt ?? null,
        },
      });
      const catalogItemId = await catalogItem(tx, c.tenantId);
      for (const [n, item] of spec.items.entries()) {
        await tx.treatmentPlanItem.create({
          data: {
            id: items[n],
            tenantId: c.tenantId,
            planId: id,
            patientId,
            toothNumber: String(11 + n),
            catalogItemId,
            price: item.price,
            discount: item.discount ?? 0,
            status: item.status ?? 'PROPOSED',
            catalogCurrency: item.catalogCurrency ?? null,
            ...(item.rate
              ? {
                  catalogPrice: item.price,
                  referenceCurrency: item.catalogCurrency ?? 'USD',
                  referencePriceInPlan: item.price,
                  referenceRateFrom: item.rate.from,
                  referenceRateTo: item.rate.to,
                  referenceRateSource: 'MANUAL',
                  referenceRateDate: new Date('2026-07-01T00:00:00Z'),
                }
              : {}),
            deletedAt: item.deletedAt ?? null,
          },
        });
      }
    });
    return { id, items };
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

  let appointments = 0;
  /** Una cita (cualquier estado) con el ítem vinculado (DX-256). */
  async function scheduleItem(
    c: FunnelClinic,
    itemId: string,
    opts: {
      status?: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';
      appointmentDeleted?: boolean;
      linkDeleted?: boolean;
    } = {},
  ): Promise<void> {
    await withoutTriggers(async (tx) => {
      // Una hora distinta por cita: el mismo profesional no se solapa.
      const start = new Date(
        Date.UTC(2026, 10, 20, 14) + appointments++ * 60 * 60_000,
      );
      const appointment = await tx.appointment.create({
        data: {
          tenantId: c.tenantId,
          locationId: c.main,
          patientId: c.patientId,
          providerId: c.dentist.userId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: opts.status ?? 'SCHEDULED',
          deletedAt: opts.appointmentDeleted ? new Date() : null,
        },
      });
      await tx.appointmentPlanItem.create({
        data: {
          tenantId: c.tenantId,
          patientId: c.patientId,
          appointmentId: appointment.id,
          planItemId: itemId,
          deletedAt: opts.linkDeleted ? new Date() : null,
        },
      });
    });
  }

  /** Una imputación de un abono (en la moneda del plan) a un ítem. */
  async function allocate(
    c: FunnelClinic,
    planId: string,
    itemId: string,
    amount: number,
  ): Promise<void> {
    await withoutTriggers((tx) =>
      tx.paymentAllocation.create({
        data: {
          tenantId: c.tenantId,
          paymentId: randomUUID(),
          treatmentPlanId: planId,
          treatmentPlanItemId: itemId,
          amount,
          source: 'AUTO',
        },
      }),
    );
  }

  /** Un ex-miembro de la clínica (membresía borrada); devuelve su usuario. */
  async function formerMember(c: FunnelClinic, name: string): Promise<string> {
    const userId = await c.seed.provider(name);
    await raw.clinicMembership.updateMany({
      where: { tenantId: c.tenantId, userId },
      data: { deletedAt: new Date() },
    });
    return userId;
  }

  /** Un miembro con un rol y, opcional, permisos extra (DX-090). */
  async function member(
    c: FunnelClinic,
    name: string,
    role: ClinicRole,
  ): Promise<string> {
    const userId = await c.seed.provider(name);
    await raw.clinicMembership.updateMany({
      where: { tenantId: c.tenantId, userId },
      data: { role },
    });
    return userId;
  }

  return {
    withoutTriggers,
    clinic,
    plan,
    scheduleItem,
    allocate,
    formerMember,
    member,
  };
}
