import { Injectable } from '@nestjs/common';
import { ClinicRole, PaymentPromiseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { loadTenantZones } from '../../../shared/locations/reference-location';
import { isLocationAllowed } from '../../../shared/tenancy/location-access';
import { loadLedgersOf } from '../../receivables/infrastructure/prisma-receivables.repository';
import type { PatientLedger } from '../../receivables/domain/entities/receivables.entity';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { CollectionsRepository } from '../domain/ports/collections-repository.port';
import {
  countsTowardPromise,
  statusAfterVoid,
  type PromiseStatus,
} from '../domain/payment-promise-rule';
import { lockPatientPromises } from './payment-promise-lock';
import type {
  CollectionNoteView,
  NewCollectionNote,
  NewPaymentPromise,
  OpenPromise,
  PatientCollectionRows,
  PatientPayment,
  PaymentPromiseRow,
  StaffRef,
} from '../domain/collections.entity';

const NOTE_SELECT = {
  id: true,
  patientId: true,
  locationId: true,
  channel: true,
  outcome: true,
  text: true,
  authorId: true,
  createdAt: true,
} as const satisfies Prisma.CollectionNoteSelect;

const PROMISE_SELECT = {
  id: true,
  patientId: true,
  locationId: true,
  amount: true,
  currency: true,
  dueDate: true,
  status: true,
  createdById: true,
  createdAt: true,
  settledAt: true,
  reopenedAt: true,
} as const satisfies Prisma.PaymentPromiseSelect;

const PAYMENT_SELECT = {
  patientId: true,
  amount: true,
  currency: true,
  paidAt: true,
  createdAt: true,
} as const satisfies Prisma.PaymentSelect;

type NoteRow = Prisma.CollectionNoteGetPayload<{ select: typeof NOTE_SELECT }>;
type PromiseDbRow = Prisma.PaymentPromiseGetPayload<{
  select: typeof PROMISE_SELECT;
}>;

/** DATE de Postgres -> día civil (Prisma lo trae a medianoche UTC). */
const civilOf = (date: Date): string => date.toISOString().slice(0, 10);

function toOpenPromise(
  row: PromiseDbRow,
  zoneOf: (locationId: string) => string,
): OpenPromise {
  return {
    id: row.id,
    patientId: row.patientId,
    amount: row.amount.toNumber(),
    currency: row.currency,
    dueDate: civilOf(row.dueDate),
    createdAt: row.createdAt,
    timeZone: zoneOf(row.locationId),
  };
}

/**
 * Abonos VIVOS de estos pacientes registrados desde `since` (en una consulta,
 * por payments (tenantId, patientId)); los anulados y borrados no cuentan.
 */
async function livePayments(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientIds: readonly string[],
  since: Date,
  currency?: string,
): Promise<PatientPayment[]> {
  const rows = await tx.payment.findMany({
    where: {
      tenantId,
      patientId: { in: [...patientIds] },
      deletedAt: null,
      voidedAt: null,
      createdAt: { gte: since },
      ...(currency ? { currency } : {}),
    },
    select: PAYMENT_SELECT,
  });
  return rows.map((r) => ({ ...r, amount: r.amount.toNumber() }));
}

/** Quién anula el abono y desde dónde (para el `audit_event`). */
export interface PromiseVoidContext {
  tenantId: string;
  paymentId: string;
  /** Instante de la anulación: decide si el día del compromiso ya pasó. */
  now: Date;
  actor: { userId: string; role: ClinicRole | null };
  locationId: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface PromiseReopening {
  promiseId: string;
  to: Exclude<PromiseStatus, 'KEPT'>;
}

/**
 * DX-215 (BE-032): dentro de la transacción que ANULA un abono, vuelve a
 * evaluar los compromisos CUMPLIDOS del paciente en la moneda del abono para
 * los que ese abono contaba (normalmente uno: el último; pero un abono que
 * cumplió un compromiso anterior sigue contando para él aunque después se
 * cumpliera otro). Del más reciente al más antiguo. Ya no cubierto: OPEN si su
 * día no ha pasado en la zona de su sede, BROKEN si pasó (o si el paciente ya
 * tiene otro abierto: uno por paciente, y el vigente es el más reciente).
 * Bajo el candado del paciente (lo comparte con el cierre del barrido y del
 * abono) y con la transición condicional `WHERE status = 'KEPT'`: dos
 * anulaciones, o una anulación y un barrido, no lo cambian ni lo auditan dos
 * veces. El `audit_event` (UPDATE de PAYMENT_PROMISE, estado anterior y
 * nuevo, el abono anulado; sin importes ni textos) va en la MISMA transacción.
 * El trigger de payment_promises solo admite esta transición si la
 * transacción anuló un abono que contaba para el compromiso.
 */
export async function reopenPromiseOnVoid(
  tx: Prisma.TransactionClient,
  input: PromiseVoidContext,
): Promise<PromiseReopening[]> {
  const { tenantId } = input;
  const voided = await tx.payment.findFirst({
    where: { id: input.paymentId, tenantId },
    select: PAYMENT_SELECT,
  });
  if (!voided) return [];
  await lockPatientPromises(tx, tenantId, voided.patientId);
  // Solo los hechos hasta el alta del abono (si no, no contaba para ellos).
  // Por payment_promises_tenant_patient_created_idx.
  const kept = await tx.paymentPromise.findMany({
    where: {
      tenantId,
      patientId: voided.patientId,
      currency: voided.currency,
      status: PaymentPromiseStatus.KEPT,
      createdAt: { lte: voided.createdAt },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: PROMISE_SELECT,
  });
  if (kept.length === 0) return [];
  const zoneOf = await resolveLocationTimeZones(
    tx,
    tenantId,
    kept.map((k) => k.locationId),
  );
  const payment = { ...voided, amount: voided.amount.toNumber() };
  const counted = kept
    .map((row) => ({ row, terms: toOpenPromise(row, zoneOf) }))
    .filter(({ terms }) => countsTowardPromise(terms, payment, terms.timeZone));
  if (counted.length === 0) return [];
  // Los vivos desde el más antiguo de ellos: cada uno filtra los suyos.
  const remaining = await livePayments(
    tx,
    tenantId,
    [voided.patientId],
    counted[counted.length - 1].row.createdAt,
    voided.currency,
  );
  let anotherOpen =
    (await tx.paymentPromise.count({
      where: {
        tenantId,
        patientId: voided.patientId,
        status: PaymentPromiseStatus.OPEN,
      },
    })) > 0;
  const reopened: PromiseReopening[] = [];
  for (const { row, terms } of counted) {
    const to = statusAfterVoid(terms, remaining, {
      now: input.now,
      timeZone: terms.timeZone,
      anotherOpen,
    });
    if (to === 'KEPT') continue;
    const updated = await tx.paymentPromise.updateMany({
      where: { id: row.id, tenantId, status: PaymentPromiseStatus.KEPT },
      data: { status: to, settledAt: to === 'OPEN' ? null : input.now },
    });
    if (updated.count !== 1) continue;
    if (to === 'OPEN') anotherOpen = true;
    await writeAuditEvent(tx, {
      tenantId,
      locationId: input.locationId,
      actor: {
        kind: 'user',
        userId: input.actor.userId,
        role: input.actor.role,
      },
      action: 'UPDATE',
      resourceType: 'PAYMENT_PROMISE',
      resourceId: row.id,
      patient: { kind: 'patient', id: row.patientId },
      requestId: input.requestId,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: {
        reason: 'PAYMENT_VOIDED',
        params: { paymentId: input.paymentId },
        statusChange: { from: 'KEPT', to },
      },
    });
    reopened.push({ promiseId: row.id, to });
  }
  return reopened;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Cobranza (DX-150). Todo con `runWithTenant` (RLS FORCE) y `tenantId`
 * explícito. Las listas resuelven los nombres del personal en una consulta
 * fija (sin N+1). El texto de las notas nunca se registra en logs.
 */
@Injectable()
export class PrismaCollectionsRepository implements CollectionsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async patientExists(patientId: string): Promise<boolean> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, tenantId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async locationExists(locationId: string): Promise<boolean> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  defaultLocationFor(patientId: string): Promise<string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const ledger = await tx.patientLedger.findFirst({
        where: { tenantId, patientId, locationId: { not: null } },
        select: { locationId: true },
      });
      // La sede de la deuda puede estar ya retirada, o no ser de las del
      // miembro (DX-089): entonces, la de escritura de la sesión (la
      // principal, o la primera permitida).
      if (
        ledger?.locationId &&
        isLocationAllowed(
          this.tenantContext.getAllowedLocationIds(),
          ledger.locationId,
        )
      ) {
        const alive = await tx.location.findFirst({
          where: { id: ledger.locationId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (alive) return alive.id;
      }
      return this.tenantContext.writeLocationId(tx);
    });
  }

  timeZoneOf(locationId: string): Promise<string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) =>
      (await resolveLocationTimeZones(tx, tenantId, [locationId]))(locationId),
    );
  }

  async currencyExists(code: string): Promise<boolean> {
    const row = await this.prisma.currency.findUnique({
      where: { code },
      select: { code: true },
    });
    return row !== null;
  }

  createNote(input: NewCollectionNote): Promise<CollectionNoteView> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.collectionNote.create({
        data: { tenantId, ...input },
        select: NOTE_SELECT,
      });
      const names = await this.staffNames(tx, [row.authorId]);
      return this.toNote(row, names);
    });
  }

  async createPromise(
    input: NewPaymentPromise,
  ): Promise<PaymentPromiseRow | null> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // Con el candado del paciente: una reapertura simultánea (DX-215) ve
        // este compromiso abierto, o este choca con el reabierto (409).
        await lockPatientPromises(tx, tenantId, input.patientId);
        const row = await tx.paymentPromise.create({
          data: {
            tenantId,
            patientId: input.patientId,
            locationId: input.locationId,
            amount: input.amount,
            currency: input.currency,
            dueDate: new Date(`${input.dueDate}T00:00:00.000Z`),
            createdById: input.createdById,
          },
          select: PROMISE_SELECT,
        });
        const names = await this.staffNames(tx, [row.createdById]);
        const zoneOf = await resolveLocationTimeZones(tx, tenantId, [
          row.locationId,
        ]);
        return this.toPromise(row, names, zoneOf);
      });
    } catch (error) {
      // payment_promises_open_patient_key: ya hay uno abierto.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  listForPatient(patientId: string): Promise<PatientCollectionRows> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Por collection_notes_tenant_patient_created_idx y
      // payment_promises_tenant_patient_created_idx.
      const notes = await tx.collectionNote.findMany({
        where: { tenantId, patientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: NOTE_SELECT,
      });
      const promises = await tx.paymentPromise.findMany({
        where: { tenantId, patientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: PROMISE_SELECT,
      });
      const names = await this.staffNames(tx, [
        ...notes.map((n) => n.authorId),
        ...promises.map((p) => p.createdById),
      ]);
      const zoneOf = await resolveLocationTimeZones(
        tx,
        tenantId,
        promises.map((p) => p.locationId),
      );
      return {
        notes: notes.map((n) => this.toNote(n, names)),
        promises: promises.map((p) => this.toPromise(p, names, zoneOf)),
      };
    });
  }

  async tenantIds(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  openPromises(tenantId: string, patientId?: string): Promise<OpenPromise[]> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Por payment_promises_open_patient_key (parcial, status = 'OPEN').
      const rows = await tx.paymentPromise.findMany({
        where: {
          tenantId,
          status: PaymentPromiseStatus.OPEN,
          ...(patientId ? { patientId } : {}),
        },
        select: PROMISE_SELECT,
      });
      const zoneOf = await resolveLocationTimeZones(
        tx,
        tenantId,
        rows.map((r) => r.locationId),
      );
      return rows.map((r) => toOpenPromise(r, zoneOf));
    });
  }

  async paymentsSince(
    tenantId: string,
    patientIds: readonly string[],
    since: Date,
  ): Promise<PatientPayment[]> {
    const ids = [...new Set(patientIds)];
    if (ids.length === 0) return [];
    return this.prisma.runWithTenant(tenantId, (tx) =>
      livePayments(tx, tenantId, ids, since),
    );
  }

  closePromise(
    tenantId: string,
    promiseId: string,
    decide: (promise: OpenPromise, payments: PatientPayment[]) => PromiseStatus,
  ): Promise<Exclude<PromiseStatus, 'OPEN'> | null> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const target = await tx.paymentPromise.findFirst({
        where: { id: promiseId, tenantId },
        select: { patientId: true },
      });
      if (!target) return null;
      await lockPatientPromises(tx, tenantId, target.patientId);
      // Releído con el candado: una anulación confirmada antes ya se ve.
      const row = await tx.paymentPromise.findFirst({
        where: { id: promiseId, tenantId, status: PaymentPromiseStatus.OPEN },
        select: PROMISE_SELECT,
      });
      if (!row) return null;
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [
        row.locationId,
      ]);
      const status = decide(
        toOpenPromise(row, zoneOf),
        await livePayments(tx, tenantId, [row.patientId], row.createdAt),
      );
      if (status === 'OPEN') return null;
      const result = await tx.paymentPromise.updateMany({
        where: { id: promiseId, tenantId, status: PaymentPromiseStatus.OPEN },
        data: { status, settledAt: new Date() },
      });
      return result.count === 1 ? status : null;
    });
  }

  ledgersOf(patientIds: readonly string[]): Promise<PatientLedger[]> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return Promise.resolve([]);
    return this.prisma.runWithTenant((tx) =>
      loadLedgersOf(tx, tenantId, patientIds),
    );
  }

  locationTimeZones(): Promise<(locationId: string | null) => string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) => loadTenantZones(tx, tenantId));
  }

  /** Nombre de cada miembro de la clínica (bajo RLS), en una consulta. */
  private async staffNames(
    tx: Prisma.TransactionClient,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const members = await tx.clinicMembership.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, user: { select: { fullName: true } } },
    });
    return new Map(members.map((m) => [m.userId, m.user.fullName]));
  }

  private staff(id: string, names: Map<string, string>): StaffRef {
    return { id, fullName: names.get(id) ?? null };
  }

  private toNote(row: NoteRow, names: Map<string, string>): CollectionNoteView {
    return {
      id: row.id,
      patientId: row.patientId,
      locationId: row.locationId,
      channel: row.channel,
      outcome: row.outcome,
      text: row.text,
      author: this.staff(row.authorId, names),
      createdAt: row.createdAt,
    };
  }

  private toPromise(
    row: PromiseDbRow,
    names: Map<string, string>,
    zoneOf: (locationId: string) => string,
  ): PaymentPromiseRow {
    return {
      id: row.id,
      patientId: row.patientId,
      locationId: row.locationId,
      amount: row.amount.toNumber(),
      currency: row.currency,
      dueDate: civilOf(row.dueDate),
      status: row.status,
      createdBy: this.staff(row.createdById, names),
      createdAt: row.createdAt,
      settledAt: row.settledAt,
      reopenedAt: row.reopenedAt,
      timeZone: zoneOf(row.locationId),
    };
  }
}
