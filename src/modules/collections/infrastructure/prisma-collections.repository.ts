import { Injectable } from '@nestjs/common';
import { PaymentPromiseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  loadLocationTimeZones,
  resolveLocationTimeZones,
} from '../../../shared/locations/location-time-zone';
import { resolveDefaultLocationId } from '../../../shared/locations/default-location';
import { loadLedgersOf } from '../../receivables/infrastructure/prisma-receivables.repository';
import type { PatientLedger } from '../../receivables/domain/entities/receivables.entity';
import type { CollectionsRepository } from '../domain/ports/collections-repository.port';
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
} as const satisfies Prisma.PaymentPromiseSelect;

type NoteRow = Prisma.CollectionNoteGetPayload<{ select: typeof NOTE_SELECT }>;
type PromiseDbRow = Prisma.PaymentPromiseGetPayload<{
  select: typeof PROMISE_SELECT;
}>;

/** DATE de Postgres -> día civil (Prisma lo trae a medianoche UTC). */
const civilOf = (date: Date): string => date.toISOString().slice(0, 10);

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
      // La sede de la deuda puede estar ya retirada: entonces, la principal.
      if (ledger?.locationId) {
        const alive = await tx.location.findFirst({
          where: { id: ledger.locationId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (alive) return alive.id;
      }
      return resolveDefaultLocationId(tx);
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
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patientId,
        amount: r.amount.toNumber(),
        currency: r.currency,
        dueDate: civilOf(r.dueDate),
        createdAt: r.createdAt,
        timeZone: zoneOf(r.locationId),
      }));
    });
  }

  async paymentsSince(
    tenantId: string,
    patientIds: readonly string[],
    since: Date,
  ): Promise<PatientPayment[]> {
    const ids = [...new Set(patientIds)];
    if (ids.length === 0) return [];
    // Por payments (tenantId, patientId); los anulados y borrados no cuentan.
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.payment.findMany({
        where: {
          tenantId,
          patientId: { in: ids },
          deletedAt: null,
          voidedAt: null,
          createdAt: { gte: since },
        },
        select: {
          patientId: true,
          amount: true,
          currency: true,
          paidAt: true,
          createdAt: true,
        },
      }),
    );
    return rows.map((r) => ({ ...r, amount: r.amount.toNumber() }));
  }

  async closePromise(
    tenantId: string,
    promiseId: string,
    status: Exclude<PaymentPromiseStatus, 'OPEN'>,
  ): Promise<boolean> {
    const result = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.paymentPromise.updateMany({
        where: { id: promiseId, tenantId, status: PaymentPromiseStatus.OPEN },
        data: { status, settledAt: new Date() },
      }),
    );
    return result.count === 1;
  }

  ledgersOf(patientIds: readonly string[]): Promise<PatientLedger[]> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return Promise.resolve([]);
    return this.prisma.runWithTenant((tx) =>
      loadLedgersOf(tx, tenantId, patientIds),
    );
  }

  locationTimeZones(): Promise<Map<string, string>> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      loadLocationTimeZones(tx, tenantId),
    );
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
      timeZone: zoneOf(row.locationId),
    };
  }
}
