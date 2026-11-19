import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BankReconciliationMatchEndReason,
  BankReconciliationMatchKind,
  PaymentAdjustmentType,
  PaymentMethodKind,
  PaymentReportStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { loadLocationZones } from '../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { LocationFormatSource } from '../../../shared/locations/location-regional';
import { collectedAmount } from '../../payment-methods/domain/payment-adjustments';
import { toCents } from '../../../shared/money/money';
import { normalizeReference } from '../../payment-methods/domain/payment-method-rules';
import { receiptNumberOf } from '../../payments/domain/receipt-number';
import {
  AUTO_MATCH_WINDOW_DAYS,
  CANDIDATE_WINDOW_DAYS,
  addDays,
  autoMatch,
  classifyPeriod,
  daysBetween,
  type MatchPair,
  type MovementForMatch,
  type PaymentForMatch,
} from '../domain/matching';
import type { StatementColumnMapping } from '../domain/statement-mapping';
import type { KeyedMovement } from '../domain/statement-parsing';

/**
 * DX-571: persistencia de la conciliación bancaria. Todo bajo RLS
 * (`runWithTenant`) y con `tenantId` explícito además. Las lecturas del
 * emparejado son por CONJUNTOS (un número constante de consultas, sin N+1):
 * movimientos por (cuenta, fecha), abonos por (medio, rango de paidAt) con
 * los índices de payments, emparejado en memoria e inserción en bloque.
 */

export class BankAccountNotFoundError extends Error {}
export class BankMovementNotFoundError extends Error {}
export class BankMatchNotFoundError extends Error {}
export class BankPaymentNotFoundError extends Error {}

/** 409 con código estable (la web muestra el mensaje tal cual). */
export class BankReconciliationConflict extends Error {
  constructor(
    readonly code:
      | 'BANK_ACCOUNT_NAME_TAKEN'
      | 'BANK_PAYMENT_METHOD_TAKEN'
      | 'BANK_PAYMENT_METHOD_INVALID'
      | 'BANK_CURRENCY_INVALID'
      | 'BANK_ACCOUNT_INACTIVE'
      | 'BANK_MOVEMENT_ALREADY_MATCHED'
      | 'BANK_PAYMENT_ALREADY_MATCHED'
      | 'BANK_PAYMENT_NOT_IN_ACCOUNT'
      | 'BANK_MATCH_ALREADY_ENDED',
    message: string,
  ) {
    super(message);
  }
}

export interface BankAccountView {
  id: string;
  name: string;
  currency: string;
  amountTolerance: number;
  active: boolean;
  columnMapping: unknown;
  paymentMethods: { id: string; name: string; kind: PaymentMethodKind }[];
  lastImport: BankImportView | null;
  createdAt: Date;
}

export interface BankImportView {
  id: string;
  fileSha256: string;
  fileFormat: string;
  totalRows: number;
  creditRows: number;
  createdRows: number;
  duplicateRows: number;
  ignoredRows: number;
  errorRows: number;
  matchedRows: number;
  periodFrom: string | null;
  periodTo: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string };
}

export interface AccountInput {
  name: string;
  currency: string;
  amountTolerance: number;
  paymentMethodIds: string[];
}

export interface ConfirmImportInput {
  accountId: string;
  fileSha256: string;
  fileFormat: 'CSV' | 'XLSX';
  totalRows: number;
  ignoredRows: number;
  errorRows: number;
  credits: KeyedMovement[];
  mapping: StatementColumnMapping;
  userId: string;
}

export interface ConfirmImportResult {
  id: string;
  fileSha256: string;
  rows: number;
  valid: number;
  created: number;
  duplicates: number;
  ignored: number;
  errors: number;
  matched: number;
  periodFrom: string | null;
  periodTo: string | null;
}

export type ReconciliationStatus =
  'CONCILIADO' | 'IMPORTE_DISTINTO' | 'MOVIMIENTO_SIN_ABONO' | 'SIN_MOVIMIENTO';

export interface MovementView {
  id: string;
  bookedOn: string;
  reference: string | null;
  amount: number;
  currency: string;
  description: string | null;
}

export interface PaymentView {
  id: string;
  paidOn: string;
  amount: number;
  collectedAmount: number;
  currency: string;
  reference: string | null;
  paymentMethod: { id: string; name: string } | null;
  receiptNumber: string | null;
  hasProof: boolean;
  patient: { id: string; fullName: string };
  location: { id: string; name: string };
  treatmentPlanId: string | null;
}

export interface ReconciliationItem {
  status: ReconciliationStatus;
  movement: MovementView | null;
  payment: PaymentView | null;
  match: {
    id: string;
    kind: BankReconciliationMatchKind;
    createdAt: Date;
  } | null;
}

export interface PeriodSummary {
  from: string;
  to: string;
  counts: Record<ReconciliationStatus, number>;
}

export interface PeriodPage extends PeriodSummary {
  status: ReconciliationStatus;
  total: number;
  page: number;
  pageSize: number;
  items: ReconciliationItem[];
}

export interface CandidatesView {
  movement: MovementView;
  payments: (PaymentView & { referenceMatches: boolean })[];
  reports: {
    id: string;
    amount: number;
    currency: string;
    reference: string | null;
    paidOn: string;
    paymentMethod: { id: string; name: string };
    patient: { id: string; fullName: string };
    referenceMatches: boolean;
  }[];
}

const LONG_TX = { timeout: 60_000, maxWait: 10_000 } as const;

interface MovementRow {
  id: string;
  bookedOn: Date;
  referenceNormalized: string | null;
  amount: Prisma.Decimal;
}

interface ActiveMatchRow {
  id: string;
  kind: BankReconciliationMatchKind;
  createdAt: Date;
  movementId: string;
  paymentId: string;
  bookedOn: Date;
}

interface PaymentRow {
  id: string;
  paidAt: Date;
  locationId: string;
  referenceNormalized: string | null;
  amount: Prisma.Decimal;
  adjustments: { type: PaymentAdjustmentType; amount: string }[];
}

/**
 * Las consultas del emparejado y de las listas, exportadas para que
 * test/bank-reconciliation.int-spec.ts explique (EXPLAIN) la SQL REAL. Cada
 * una es un rango sobre UN índice de UNA tabla; el resto se cruza en memoria
 * (por conjuntos, sin una consulta por fila).
 */
/**
 * Un instante como la hora de pared UTC que guardan las columnas
 * `timestamp(3)` (sin zona). Va como texto con `::timestamp`: un `Date` se
 * enviaría como timestamptz y la comparación convertiría la COLUMNA (con la
 * zona de la sesión), y el índice ya no serviría.
 */
function utcWall(instant: Date): string {
  return instant.toISOString().slice(0, 23).replace('T', ' ');
}

export function movementsInPeriodSql(
  tenantId: string,
  accountId: string,
  from: string,
  to: string,
): Prisma.Sql {
  // bank_movements_account_booked_idx (tenantId, bankAccountId, bookedOn).
  return Prisma.sql`
    SELECT m."id", m."bookedOn", m."referenceNormalized", m."amount"
      FROM "bank_movements" m
     WHERE m."tenantId" = ${tenantId}::uuid
       AND m."bankAccountId" = ${accountId}::uuid
       AND m."bookedOn" >= ${from}::date
       AND m."bookedOn" <= ${to}::date`;
}

export function activeMatchesInPeriodSql(
  tenantId: string,
  accountId: string,
  from: string,
  to: string,
): Prisma.Sql {
  // bank_reconciliation_matches_account_booked_active_idx (parcial, activos).
  return Prisma.sql`
    SELECT x."id", x."kind", x."createdAt", x."movementId", x."paymentId", x."bookedOn"
      FROM "bank_reconciliation_matches" x
     WHERE x."tenantId" = ${tenantId}::uuid
       AND x."bankAccountId" = ${accountId}::uuid
       AND x."bookedOn" >= ${from}::date
       AND x."bookedOn" <= ${to}::date
       AND x."endedAt" IS NULL`;
}

export function activeMatchedPaymentsSql(
  tenantId: string,
  fromInstant: Date,
  toInstant: Date,
): Prisma.Sql {
  // bank_reconciliation_matches_paid_active_idx (parcial, activos): los
  // abonos ya conciliados del rango, en cualquier cuenta.
  return Prisma.sql`
    SELECT x."paymentId"
      FROM "bank_reconciliation_matches" x
     WHERE x."tenantId" = ${tenantId}::uuid
       AND x."paidAt" >= ${utcWall(fromInstant)}::timestamp
       AND x."paidAt" < ${utcWall(toInstant)}::timestamp
       AND x."endedAt" IS NULL`;
}

export function paymentsInRangeSql(
  tenantId: string,
  methodIds: string[],
  currency: string,
  fromInstant: Date,
  toInstant: Date,
): Prisma.Sql {
  // payments_tenantId_paidAt_active_idx (tenantId, paidAt) WHERE deletedAt
  // IS NULL, o payments_tenant_method_reference_idx por el medio.
  return Prisma.sql`
    SELECT p."id", p."paidAt", p."locationId", p."referenceNormalized", p."amount",
           -- Sus ajustes por medio de pago (DX-516): subconsulta correlada por
           -- el único (tenantId, paymentId, position), sin otra ida a la BD.
           COALESCE((SELECT json_agg(json_build_object('type', a."type", 'amount', a."amount"::text)
                                      ORDER BY a."position")
                       FROM "payment_adjustments" a
                      WHERE a."tenantId" = p."tenantId" AND a."paymentId" = p."id"), '[]'::json)
             AS "adjustments"
      FROM "payments" p
     WHERE p."tenantId" = ${tenantId}::uuid
       AND p."deletedAt" IS NULL
       AND p."paymentMethodId" = ANY(${methodIds}::uuid[])
       AND p."currency" = ${currency}
       AND p."paidAt" >= ${utcWall(fromInstant)}::timestamp
       AND p."paidAt" < ${utcWall(toInstant)}::timestamp`;
}

const MAX_CANDIDATES = 20;
const MAX_REPORT_CANDIDATES = 10;

const cents = (d: Prisma.Decimal): number => d.mul(100).toNumber();
const amountOf = (d: Prisma.Decimal): number => d.toNumber();
const day = (d: Date): string => d.toISOString().slice(0, 10);
const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function takenMethod(): BankReconciliationConflict {
  return new BankReconciliationConflict(
    'BANK_PAYMENT_METHOD_TAKEN',
    'Uno de los medios de pago ya está en otra cuenta: cada medio liquida en una sola cuenta.',
  );
}

function fullName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

const ACCOUNT_SELECT = {
  id: true,
  name: true,
  currency: true,
  amountTolerance: true,
  active: true,
  columnMapping: true,
  createdAt: true,
  paymentMethods: {
    select: { paymentMethod: { select: { id: true, name: true, kind: true } } },
    orderBy: { createdAt: 'asc' },
  },
  imports: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: { createdBy: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.BankAccountSelect;

type AccountRow = Prisma.BankAccountGetPayload<{
  select: typeof ACCOUNT_SELECT;
}>;
type ImportRow = Prisma.BankStatementImportGetPayload<{
  include: { createdBy: { select: { id: true; fullName: true } } };
}>;

function importView(row: ImportRow): BankImportView {
  return {
    id: row.id,
    fileSha256: row.fileSha256,
    fileFormat: row.fileFormat,
    totalRows: row.totalRows,
    creditRows: row.creditRows,
    createdRows: row.createdRows,
    duplicateRows: row.duplicateRows,
    ignoredRows: row.ignoredRows,
    errorRows: row.errorRows,
    matchedRows: row.matchedRows,
    periodFrom: row.periodFrom ? day(row.periodFrom) : null,
    periodTo: row.periodTo ? day(row.periodTo) : null,
    createdAt: row.createdAt,
    createdBy: { id: row.createdBy.id, name: row.createdBy.fullName },
  };
}

function accountView(row: AccountRow): BankAccountView {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    amountTolerance: amountOf(row.amountTolerance),
    active: row.active,
    columnMapping: row.columnMapping,
    paymentMethods: row.paymentMethods.map((m) => m.paymentMethod),
    lastImport: row.imports[0] ? importView(row.imports[0]) : null,
    createdAt: row.createdAt,
  };
}

const PAYMENT_VIEW_SELECT = {
  id: true,
  paidAt: true,
  amount: true,
  currency: true,
  reference: true,
  treatmentPlanId: true,
  paymentMethod: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  receipt: { select: { seriesPrefix: true, number: true } },
  splitHead: {
    select: { receipt: { select: { seriesPrefix: true, number: true } } },
  },
  proof: { select: { id: true } },
  methodAdjustments: { select: { type: true, amount: true } },
  plan: {
    select: {
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  openingBalance: {
    select: {
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.PaymentSelect;

type PaymentViewRow = Prisma.PaymentGetPayload<{
  select: typeof PAYMENT_VIEW_SELECT;
}>;

/** Lo que llega al banco: importe + ajustes por medio de pago (DX-516). */
function collectedOf(row: {
  amount: Prisma.Decimal;
  methodAdjustments: {
    type: PaymentViewRow['methodAdjustments'][number]['type'];
    amount: Prisma.Decimal;
  }[];
}): number {
  return collectedAmount(
    row.amount.toNumber(),
    row.methodAdjustments.map((a) => ({
      type: a.type,
      amount: a.amount.toNumber(),
    })),
  );
}

@Injectable()
export class PrismaBankReconciliationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /** Formato de la sede de escritura, para los textos de error del lector. */
  async formatLocation(): Promise<LocationFormatSource> {
    return this.prisma.runWithTenant(async (tx) => {
      const id = await this.tenantContext.writeLocationId(tx);
      const location = await tx.location.findFirst({
        where: { id, tenantId: this.tenantId() },
        select: { id: true, locale: true, hourCycle: true },
      });
      return location ?? { id, locale: null, hourCycle: null };
    });
  }

  // ---------------------------------------------------------------- cuentas

  async listAccounts(): Promise<BankAccountView[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.bankAccount.findMany({
        where: { tenantId },
        select: ACCOUNT_SELECT,
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      });
      return rows.map(accountView);
    });
  }

  async findAccount(id: string): Promise<BankAccountView> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.bankAccount.findFirst({
        where: { id, tenantId },
        select: ACCOUNT_SELECT,
      });
      if (!row) throw new BankAccountNotFoundError();
      return accountView(row);
    });
  }

  /**
   * Medios válidos: de la clínica, que no son efectivo y que no liquidan ya
   * en OTRA cuenta (`exceptAccountId`: la que se edita). El único por medio
   * es la red ante dos altas a la vez.
   */
  private async assertMethods(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ids: string[],
    exceptAccountId?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const found = await tx.clinicPaymentMethod.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, kind: true },
    });
    if (
      found.length !== new Set(ids).size ||
      found.some((m) => m.kind === PaymentMethodKind.CASH)
    ) {
      throw new BankReconciliationConflict(
        'BANK_PAYMENT_METHOD_INVALID',
        'Elige medios de pago de la clínica que lleguen al banco (no efectivo).',
      );
    }
    const taken = await tx.bankAccountPaymentMethod.findFirst({
      where: {
        tenantId,
        paymentMethodId: { in: ids },
        ...(exceptAccountId ? { bankAccountId: { not: exceptAccountId } } : {}),
      },
      select: { paymentMethodId: true },
    });
    if (taken) throw takenMethod();
  }

  private async assertCurrency(tx: Prisma.TransactionClient, code: string) {
    const currency = await tx.currency.findUnique({
      where: { code },
      select: { code: true },
    });
    if (!currency) {
      throw new BankReconciliationConflict(
        'BANK_CURRENCY_INVALID',
        'La moneda no existe.',
      );
    }
  }

  private conflictOf(error: unknown): unknown {
    if (!isUniqueViolation(error)) return error;
    const meta = JSON.stringify(
      (error as Prisma.PrismaClientKnownRequestError).meta ?? {},
    );
    // Dos únicos posibles: el nombre (tenantId, name) o el medio en otra
    // cuenta (tenantId, paymentMethodId), que ya se comprueba antes.
    if (
      meta.includes('"name"') ||
      meta.includes('bank_accounts_tenant_name_key')
    ) {
      return new BankReconciliationConflict(
        'BANK_ACCOUNT_NAME_TAKEN',
        'Ya hay una cuenta con ese nombre.',
      );
    }
    return takenMethod();
  }

  async createAccount(
    input: AccountInput,
    userId: string,
  ): Promise<BankAccountView> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        await this.assertCurrency(tx, input.currency);
        await this.assertMethods(tx, tenantId, input.paymentMethodIds);
        const id = randomUUID();
        await tx.bankAccount.create({
          data: {
            id,
            tenantId,
            name: input.name,
            currency: input.currency,
            amountTolerance: new Prisma.Decimal(input.amountTolerance),
            createdById: userId,
          },
        });
        if (input.paymentMethodIds.length > 0) {
          await tx.bankAccountPaymentMethod.createMany({
            data: [...new Set(input.paymentMethodIds)].map(
              (paymentMethodId) => ({
                tenantId,
                bankAccountId: id,
                paymentMethodId,
              }),
            ),
          });
        }
        const row = await tx.bankAccount.findFirstOrThrow({
          where: { id, tenantId },
          select: ACCOUNT_SELECT,
        });
        return accountView(row);
      });
    } catch (error) {
      throw this.conflictOf(error);
    }
  }

  async updateAccount(
    id: string,
    patch: Partial<AccountInput> & { active?: boolean },
  ): Promise<BankAccountView> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        await this.lockAccount(tx, id);
        const current = await tx.bankAccount.findFirst({
          where: { id, tenantId },
          select: { id: true, currency: true },
        });
        if (!current) throw new BankAccountNotFoundError();
        if (
          patch.currency !== undefined &&
          patch.currency !== current.currency
        ) {
          // Cambiar la moneda con movimientos importados los dejaría en otra.
          const movement = await tx.bankMovement.findFirst({
            where: { tenantId, bankAccountId: id },
            select: { id: true },
          });
          if (movement) {
            throw new BankReconciliationConflict(
              'BANK_CURRENCY_INVALID',
              'La cuenta ya tiene movimientos importados: su moneda no se puede cambiar.',
            );
          }
          await this.assertCurrency(tx, patch.currency);
        }
        await tx.bankAccount.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.currency !== undefined
              ? { currency: patch.currency }
              : {}),
            ...(patch.amountTolerance !== undefined
              ? { amountTolerance: new Prisma.Decimal(patch.amountTolerance) }
              : {}),
            ...(patch.active !== undefined ? { active: patch.active } : {}),
          },
        });
        if (patch.paymentMethodIds !== undefined) {
          await this.assertMethods(tx, tenantId, patch.paymentMethodIds, id);
          // Configuración: se reemplaza (HARD_DELETE_ALLOWLIST, auditado como
          // UPDATE de la cuenta).
          // eslint-disable-next-line no-restricted-syntax -- DX-571: qué medios liquidan en la cuenta es configuración sin datos de pacientes (HARD_DELETE_ALLOWLIST)
          await tx.bankAccountPaymentMethod.deleteMany({
            where: { tenantId, bankAccountId: id },
          });
          if (patch.paymentMethodIds.length > 0) {
            await tx.bankAccountPaymentMethod.createMany({
              data: [...new Set(patch.paymentMethodIds)].map(
                (paymentMethodId) => ({
                  tenantId,
                  bankAccountId: id,
                  paymentMethodId,
                }),
              ),
            });
          }
        }
        const row = await tx.bankAccount.findFirstOrThrow({
          where: { id, tenantId },
          select: ACCOUNT_SELECT,
        });
        return accountView(row);
      });
    } catch (error) {
      throw this.conflictOf(error);
    }
  }

  async listImports(accountId: string): Promise<BankImportView[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const account = await tx.bankAccount.findFirst({
        where: { id: accountId, tenantId },
        select: { id: true },
      });
      if (!account) throw new BankAccountNotFoundError();
      const rows = await tx.bankStatementImport.findMany({
        where: { tenantId, bankAccountId: accountId },
        include: { createdBy: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map(importView);
    });
  }

  // ------------------------------------------------------------ importación

  /** Serializa importar y emparejar en una cuenta (y la bloquea para leer). */
  private async lockAccount(tx: Prisma.TransactionClient, accountId: string) {
    await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`dx571:${accountId}`}, 0))`;
  }

  private async accountForWrite(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
  ) {
    const account = await tx.bankAccount.findFirst({
      where: { id: accountId, tenantId },
      select: {
        id: true,
        currency: true,
        amountTolerance: true,
        active: true,
        paymentMethods: { select: { paymentMethodId: true } },
      },
    });
    if (!account) throw new BankAccountNotFoundError();
    return {
      id: account.id,
      currency: account.currency,
      active: account.active,
      toleranceCents: cents(account.amountTolerance),
      methodIds: account.paymentMethods.map((m) => m.paymentMethodId),
    };
  }

  /** Las claves naturales que la cuenta ya tiene (único por cuenta). */
  async existingKeys(accountId: string, keys: string[]): Promise<Set<string>> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const account = await tx.bankAccount.findFirst({
        where: { id: accountId, tenantId },
        select: { id: true },
      });
      if (!account) throw new BankAccountNotFoundError();
      return this.keysIn(tx, tenantId, accountId, keys);
    });
  }

  private async keysIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    keys: string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await tx.bankMovement.findMany({
      where: { tenantId, bankAccountId: accountId, naturalKey: { in: keys } },
      select: { naturalKey: true },
    });
    return new Set(rows.map((r) => r.naturalKey));
  }

  async confirmImport(input: ConfirmImportInput): Promise<ConfirmImportResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await this.lockAccount(tx, input.accountId);
      const account = await this.accountForWrite(tx, tenantId, input.accountId);
      if (!account.active) {
        throw new BankReconciliationConflict(
          'BANK_ACCOUNT_INACTIVE',
          'La cuenta está desactivada: actívala para importar extractos.',
        );
      }
      // Bajo el bloqueo de la cuenta: nadie más inserta entre esta lectura y
      // el INSERT, así que los contadores son exactos.
      const existing = await this.keysIn(
        tx,
        tenantId,
        input.accountId,
        input.credits.map((c) => c.naturalKey),
      );
      const fresh = input.credits
        .filter((c) => !existing.has(c.naturalKey))
        .map((c) => ({ ...c, id: randomUUID() }));
      let periodFrom: string | null = null;
      let periodTo: string | null = null;
      for (const c of input.credits) {
        if (periodFrom === null || c.bookedOn < periodFrom)
          periodFrom = c.bookedOn;
        if (periodTo === null || c.bookedOn > periodTo) periodTo = c.bookedOn;
      }

      let pairs: MatchPair[] = [];
      let movements: MovementForMatch[] = [];
      let payments: { id: string; paidAt: Date }[] = [];
      if (periodFrom !== null && periodTo !== null) {
        const old = await this.unmatchedMovements(
          tx,
          tenantId,
          input.accountId,
          periodFrom,
          periodTo,
        );
        movements = [
          ...old,
          ...fresh.map((m) => ({
            id: m.id,
            bookedOn: m.bookedOn,
            referenceNormalized: m.referenceNormalized,
            amountCents: m.amountCents,
          })),
        ];
        const candidates = await this.unmatchedPayments(
          tx,
          tenantId,
          account,
          addDays(periodFrom, -AUTO_MATCH_WINDOW_DAYS),
          addDays(periodTo, AUTO_MATCH_WINDOW_DAYS),
        );
        payments = candidates;
        pairs = autoMatch(movements, candidates, {
          toleranceCents: account.toleranceCents,
          windowDays: AUTO_MATCH_WINDOW_DAYS,
        });
      }

      const importId = randomUUID();
      await tx.bankStatementImport.create({
        data: {
          id: importId,
          tenantId,
          bankAccountId: input.accountId,
          fileSha256: input.fileSha256,
          fileFormat: input.fileFormat,
          totalRows: input.totalRows,
          creditRows: input.credits.length,
          createdRows: fresh.length,
          duplicateRows: input.credits.length - fresh.length,
          ignoredRows: input.ignoredRows,
          errorRows: input.errorRows,
          matchedRows: pairs.length,
          periodFrom: periodFrom ? dateOf(periodFrom) : null,
          periodTo: periodTo ? dateOf(periodTo) : null,
          createdById: input.userId,
        },
      });
      if (fresh.length > 0) {
        await tx.bankMovement.createMany({
          data: fresh.map((m) => ({
            id: m.id,
            tenantId,
            bankAccountId: input.accountId,
            importId,
            bookedOn: dateOf(m.bookedOn),
            reference: m.reference,
            referenceNormalized: m.referenceNormalized,
            amount: new Prisma.Decimal(m.amountCents).div(100),
            currency: account.currency,
            description: m.description,
            naturalKey: m.naturalKey,
          })),
        });
      }
      await this.insertMatches(
        tx,
        tenantId,
        input.accountId,
        pairs,
        movements,
        payments,
        BankReconciliationMatchKind.AUTO,
        input.userId,
      );
      await tx.bankAccount.update({
        where: { id: input.accountId },
        data: {
          columnMapping: input.mapping as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        id: importId,
        fileSha256: input.fileSha256,
        rows: input.totalRows,
        valid: input.credits.length,
        created: fresh.length,
        duplicates: input.credits.length - fresh.length,
        ignored: input.ignoredRows,
        errors: input.errorRows,
        matched: pairs.length,
        periodFrom,
        periodTo,
      };
    }, LONG_TX);
  }

  /**
   * Inserta los emparejados en bloque. Cuenta, día y paidAt son copias que el
   * trigger vuelve a poner desde el movimiento y el abono (las de aquí solo
   * satisfacen el tipo).
   */
  private async insertMatches(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    pairs: MatchPair[],
    movements: readonly MovementForMatch[],
    payments: readonly { id: string; paidAt: Date }[],
    kind: BankReconciliationMatchKind,
    userId: string,
  ): Promise<void> {
    if (pairs.length === 0) return;
    const bookedOf = new Map(movements.map((m) => [m.id, m.bookedOn]));
    const paidAtOf = new Map(payments.map((p) => [p.id, p.paidAt]));
    await tx.bankReconciliationMatch.createMany({
      data: pairs.map((p) => ({
        id: randomUUID(),
        tenantId,
        movementId: p.movementId,
        paymentId: p.paymentId,
        bankAccountId: accountId,
        bookedOn: dateOf(bookedOf.get(p.movementId)!),
        paidAt: paidAtOf.get(p.paymentId)!,
        kind,
        matchedById: userId,
      })),
    });
  }

  /** «Volver a emparejar» un período: abonos registrados después de importar. */
  async autoMatchPeriod(
    accountId: string,
    from: string,
    to: string,
    userId: string,
  ): Promise<number> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      await this.lockAccount(tx, accountId);
      const account = await this.accountForWrite(tx, tenantId, accountId);
      const movements = await this.unmatchedMovements(
        tx,
        tenantId,
        accountId,
        from,
        to,
      );
      if (movements.length === 0) return 0;
      const payments = await this.unmatchedPayments(
        tx,
        tenantId,
        account,
        addDays(from, -AUTO_MATCH_WINDOW_DAYS),
        addDays(to, AUTO_MATCH_WINDOW_DAYS),
      );
      const pairs = autoMatch(movements, payments, {
        toleranceCents: account.toleranceCents,
        windowDays: AUTO_MATCH_WINDOW_DAYS,
      });
      await this.insertMatches(
        tx,
        tenantId,
        accountId,
        pairs,
        movements,
        payments,
        BankReconciliationMatchKind.AUTO,
        userId,
      );
      return pairs.length;
    }, LONG_TX);
  }

  // ------------------------------------------------------------ candidatos

  /** Movimientos de la cuenta en [from, to], con o sin emparejado. */
  private async movementsInPeriod(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<MovementForMatch[]> {
    const rows = await tx.$queryRaw<MovementRow[]>(
      movementsInPeriodSql(tenantId, accountId, from, to),
    );
    return rows.map((r) => ({
      id: r.id,
      bookedOn: day(r.bookedOn),
      referenceNormalized: r.referenceNormalized,
      amountCents: cents(r.amount),
    }));
  }

  /** Emparejados ACTIVOS de la cuenta cuyo movimiento cae en [from, to]. */
  private activeMatchesInPeriod(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<ActiveMatchRow[]> {
    return tx.$queryRaw<ActiveMatchRow[]>(
      activeMatchesInPeriodSql(tenantId, accountId, from, to),
    );
  }

  /** Movimientos de la cuenta sin emparejado activo en [from, to]. */
  private async unmatchedMovements(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<MovementForMatch[]> {
    const movements = await this.movementsInPeriod(
      tx,
      tenantId,
      accountId,
      from,
      to,
    );
    const matched = new Set(
      (await this.activeMatchesInPeriod(tx, tenantId, accountId, from, to)).map(
        (m) => m.movementId,
      ),
    );
    return movements.filter((m) => !matched.has(m.id));
  }

  /**
   * Abonos vivos sin emparejado activo, de un medio de la cuenta y su moneda,
   * cuyo día (en la zona de su sede) cae en [from, to]. Se leen por un rango
   * de paidAt un día más ancho a cada lado (cubre cualquier zona) y se
   * recortan con la zona de cada sede, leída en UNA consulta. Sus ajustes por
   * medio de pago y sus emparejados, cada uno en UNA consulta por conjunto.
   */
  private async unmatchedPayments(
    tx: Prisma.TransactionClient,
    tenantId: string,
    account: { currency: string; methodIds: string[] },
    from: string,
    to: string,
  ): Promise<(PaymentForMatch & { locationId: string; paidAt: Date })[]> {
    if (account.methodIds.length === 0) return [];
    const fromInstant = dateOf(addDays(from, -1));
    const toInstant = dateOf(addDays(to, 2));
    const rows = await tx.$queryRaw<PaymentRow[]>(
      paymentsInRangeSql(
        tenantId,
        account.methodIds,
        account.currency,
        fromInstant,
        toInstant,
      ),
    );
    const matched = new Set(
      (
        await tx.$queryRaw<{ paymentId: string }[]>(
          activeMatchedPaymentsSql(tenantId, fromInstant, toInstant),
        )
      ).map((m) => m.paymentId),
    );
    const open = rows.filter((r) => !matched.has(r.id));
    const zones = await loadLocationZones(tx, tenantId, [
      ...new Set(open.map((r) => r.locationId)),
    ]);
    const out: (PaymentForMatch & { locationId: string; paidAt: Date })[] = [];
    for (const r of open) {
      const paidOn = civilDateIn(r.paidAt, zones.zoneOf(r.locationId));
      if (paidOn < from || paidOn > to) continue;
      out.push({
        id: r.id,
        paidOn,
        locationId: r.locationId,
        paidAt: r.paidAt,
        referenceNormalized: r.referenceNormalized,
        collectedCents: toCents(
          collectedOf({
            amount: r.amount,
            methodAdjustments: r.adjustments.map((x) => ({
              type: x.type,
              amount: new Prisma.Decimal(x.amount),
            })),
          }),
        ),
      });
    }
    return out;
  }

  // ------------------------------------------------------------- las listas

  private async periodState(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    from: string,
    to: string,
  ) {
    const account = await this.accountForWrite(tx, tenantId, accountId);
    const all = await this.movementsInPeriod(tx, tenantId, accountId, from, to);
    const matches = (
      await this.activeMatchesInPeriod(tx, tenantId, accountId, from, to)
    ).sort(
      (a, b) =>
        a.bookedOn.getTime() - b.bookedOn.getTime() || a.id.localeCompare(b.id),
    );
    const matchedIds = new Set(matches.map((m) => m.movementId));
    const movements = all.filter((m) => !matchedIds.has(m.id));
    const payments = await this.unmatchedPayments(
      tx,
      tenantId,
      account,
      addDays(from, -AUTO_MATCH_WINDOW_DAYS),
      addDays(to, AUTO_MATCH_WINDOW_DAYS),
    );
    const open = classifyPeriod(
      movements,
      payments,
      (p) => p.paidOn >= from && p.paidOn <= to,
      {
        toleranceCents: account.toleranceCents,
        windowDays: AUTO_MATCH_WINDOW_DAYS,
      },
    );
    return { matches, open };
  }

  async periodSummary(
    accountId: string,
    from: string,
    to: string,
  ): Promise<PeriodSummary> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const { matches, open } = await this.periodState(
        tx,
        tenantId,
        accountId,
        from,
        to,
      );
      return {
        from,
        to,
        counts: {
          CONCILIADO: matches.length,
          IMPORTE_DISTINTO: open.amountMismatch.length,
          MOVIMIENTO_SIN_ABONO: open.movementsWithoutPayment.length,
          SIN_MOVIMIENTO: open.paymentsWithoutMovement.length,
        },
      };
    }, LONG_TX);
  }

  async periodPage(
    accountId: string,
    from: string,
    to: string,
    status: ReconciliationStatus,
    page: number,
    pageSize: number,
  ): Promise<PeriodPage> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const { matches, open } = await this.periodState(
        tx,
        tenantId,
        accountId,
        from,
        to,
      );
      type Ref = {
        movementId: string | null;
        paymentId: string | null;
        match: (typeof matches)[number] | null;
      };
      const all: Ref[] =
        status === 'CONCILIADO'
          ? matches.map((m) => ({
              movementId: m.movementId,
              paymentId: m.paymentId,
              match: m,
            }))
          : status === 'IMPORTE_DISTINTO'
            ? open.amountMismatch.map((p) => ({ ...p, match: null }))
            : status === 'MOVIMIENTO_SIN_ABONO'
              ? open.movementsWithoutPayment.map((id) => ({
                  movementId: id,
                  paymentId: null,
                  match: null,
                }))
              : open.paymentsWithoutMovement.map((id) => ({
                  movementId: null,
                  paymentId: id,
                  match: null,
                }));
      const slice = all.slice((page - 1) * pageSize, page * pageSize);
      const movementIds = slice.flatMap((r) =>
        r.movementId ? [r.movementId] : [],
      );
      const paymentIds = slice.flatMap((r) =>
        r.paymentId ? [r.paymentId] : [],
      );
      const [movements, payments] = await Promise.all([
        this.movementViews(tx, tenantId, movementIds),
        this.paymentViews(tx, tenantId, paymentIds),
      ]);
      return {
        from,
        to,
        status,
        counts: {
          CONCILIADO: matches.length,
          IMPORTE_DISTINTO: open.amountMismatch.length,
          MOVIMIENTO_SIN_ABONO: open.movementsWithoutPayment.length,
          SIN_MOVIMIENTO: open.paymentsWithoutMovement.length,
        },
        total: all.length,
        page,
        pageSize,
        items: slice.map((r) => ({
          status,
          movement: r.movementId ? (movements.get(r.movementId) ?? null) : null,
          payment: r.paymentId ? (payments.get(r.paymentId) ?? null) : null,
          match: r.match
            ? {
                id: r.match.id,
                kind: r.match.kind,
                createdAt: r.match.createdAt,
              }
            : null,
        })),
      };
    }, LONG_TX);
  }

  private async movementViews(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, MovementView>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.bankMovement.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        bookedOn: true,
        reference: true,
        amount: true,
        currency: true,
        description: true,
      },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          bookedOn: day(r.bookedOn),
          reference: r.reference,
          amount: amountOf(r.amount),
          currency: r.currency,
          description: r.description,
        },
      ]),
    );
  }

  private async paymentViews(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, PaymentView>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.payment.findMany({
      where: { tenantId, id: { in: ids } },
      select: PAYMENT_VIEW_SELECT,
    });
    const zones = await loadLocationZones(tx, tenantId, [
      ...new Set(rows.map((r) => r.location.id)),
    ]);
    return new Map(
      rows.map((r) => [r.id, this.paymentView(r, zones.zoneOf(r.location.id))]),
    );
  }

  private paymentView(r: PaymentViewRow, timeZone: string): PaymentView {
    const patient = r.plan?.patient ?? r.openingBalance?.patient;
    return {
      id: r.id,
      paidOn: civilDateIn(r.paidAt, timeZone),
      amount: amountOf(r.amount),
      collectedAmount: collectedOf(r),
      currency: r.currency,
      reference: r.reference,
      paymentMethod: r.paymentMethod,
      receiptNumber: receiptNumberOf(r.receipt ?? r.splitHead?.receipt ?? null),
      hasProof: r.proof !== null,
      patient: patient
        ? { id: patient.id, fullName: fullName(patient) }
        : { id: '', fullName: '' },
      location: r.location,
      treatmentPlanId: r.treatmentPlanId,
    };
  }

  /**
   * Para emparejar a mano un movimiento: abonos sin emparejar de la cuenta a
   * ±15 días y los reportes de pago pendientes (DX-569) de sus medios. Los
   * de la misma referencia primero; luego por diferencia de importe y días.
   */
  async candidates(movementId: string): Promise<CandidatesView> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const movement = await tx.bankMovement.findFirst({
        where: { tenantId, id: movementId },
        select: {
          id: true,
          bankAccountId: true,
          bookedOn: true,
          reference: true,
          referenceNormalized: true,
          amount: true,
          currency: true,
          description: true,
        },
      });
      if (!movement) throw new BankMovementNotFoundError();
      const account = await this.accountForWrite(
        tx,
        tenantId,
        movement.bankAccountId,
      );
      const bookedOn = day(movement.bookedOn);
      const from = addDays(bookedOn, -CANDIDATE_WINDOW_DAYS);
      const to = addDays(bookedOn, CANDIDATE_WINDOW_DAYS);
      const target = cents(movement.amount);
      const score = (ref: string | null, amountCents: number, on: string) =>
        [
          ref !== null && ref === movement.referenceNormalized ? 0 : 1,
          Math.abs(amountCents - target),
          daysBetween(on, bookedOn),
        ] as const;
      const byScore = (a: readonly number[], b: readonly number[]) =>
        a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

      const pool = await this.unmatchedPayments(
        tx,
        tenantId,
        account,
        from,
        to,
      );
      const best = pool
        .map((p) => ({
          p,
          s: score(p.referenceNormalized, p.collectedCents, p.paidOn),
        }))
        .sort((a, b) => byScore(a.s, b.s) || (a.p.id < b.p.id ? -1 : 1))
        .slice(0, MAX_CANDIDATES);
      const views = await this.paymentViews(
        tx,
        tenantId,
        best.map((b) => b.p.id),
      );

      const reports =
        account.methodIds.length === 0
          ? []
          : await tx.paymentReport.findMany({
              where: {
                tenantId,
                status: PaymentReportStatus.PENDING,
                paymentMethodId: { in: account.methodIds },
                currency: account.currency,
                paidOn: { gte: dateOf(from), lte: dateOf(to) },
              },
              select: {
                id: true,
                amount: true,
                currency: true,
                reference: true,
                paidOn: true,
                patientId: true,
                paymentMethod: { select: { id: true, name: true } },
              },
              take: 200,
            });
      const scoredReports = reports
        .map((r) => ({
          r,
          ref: normalizeReference(r.reference),
          s: score(
            normalizeReference(r.reference),
            cents(r.amount),
            day(r.paidOn),
          ),
        }))
        .sort((a, b) => byScore(a.s, b.s) || (a.r.id < b.r.id ? -1 : 1))
        .slice(0, MAX_REPORT_CANDIDATES);
      const patients =
        scoredReports.length === 0
          ? []
          : await tx.patient.findMany({
              where: {
                tenantId,
                id: {
                  in: [...new Set(scoredReports.map((x) => x.r.patientId))],
                },
              },
              select: { id: true, firstName: true, lastName: true },
            });
      const patientById = new Map(patients.map((p) => [p.id, p]));

      return {
        movement: {
          id: movement.id,
          bookedOn,
          reference: movement.reference,
          amount: amountOf(movement.amount),
          currency: movement.currency,
          description: movement.description,
        },
        payments: best.flatMap(({ p }) => {
          const view = views.get(p.id);
          return view
            ? [
                {
                  ...view,
                  referenceMatches:
                    p.referenceNormalized !== null &&
                    p.referenceNormalized === movement.referenceNormalized,
                },
              ]
            : [];
        }),
        reports: scoredReports.map(({ r, ref }) => {
          const patient = patientById.get(r.patientId);
          return {
            id: r.id,
            amount: amountOf(r.amount),
            currency: r.currency,
            reference: r.reference,
            paidOn: day(r.paidOn),
            paymentMethod: r.paymentMethod,
            patient: {
              id: r.patientId,
              fullName: patient ? fullName(patient) : '',
            },
            referenceMatches:
              ref !== null && ref === movement.referenceNormalized,
          };
        }),
      };
    });
  }

  // --------------------------------------------------- emparejado a mano

  async manualMatch(
    movementId: string,
    paymentId: string,
    userId: string,
  ): Promise<{
    id: string;
    movementId: string;
    paymentId: string;
    kind: BankReconciliationMatchKind;
  }> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const movement = await tx.bankMovement.findFirst({
          where: { tenantId, id: movementId },
          select: {
            id: true,
            bankAccountId: true,
            currency: true,
            bookedOn: true,
          },
        });
        if (!movement) throw new BankMovementNotFoundError();
        await this.lockAccount(tx, movement.bankAccountId);
        const account = await this.accountForWrite(
          tx,
          tenantId,
          movement.bankAccountId,
        );
        const payment = await tx.payment.findFirst({
          where: { tenantId, id: paymentId, deletedAt: null },
          select: {
            id: true,
            currency: true,
            paymentMethodId: true,
            paidAt: true,
          },
        });
        if (!payment) throw new BankPaymentNotFoundError();
        if (
          payment.currency !== account.currency ||
          payment.paymentMethodId === null ||
          !account.methodIds.includes(payment.paymentMethodId)
        ) {
          throw new BankReconciliationConflict(
            'BANK_PAYMENT_NOT_IN_ACCOUNT',
            'El abono no es de un medio de pago de esta cuenta o está en otra moneda.',
          );
        }
        const [movementMatch, paymentMatch] = await Promise.all([
          tx.bankReconciliationMatch.findFirst({
            where: { tenantId, movementId, endedAt: null },
            select: { id: true },
          }),
          tx.bankReconciliationMatch.findFirst({
            where: { tenantId, paymentId, endedAt: null },
            select: { id: true },
          }),
        ]);
        if (movementMatch) {
          throw new BankReconciliationConflict(
            'BANK_MOVEMENT_ALREADY_MATCHED',
            'Ese movimiento ya está conciliado con otro abono.',
          );
        }
        if (paymentMatch) {
          throw new BankReconciliationConflict(
            'BANK_PAYMENT_ALREADY_MATCHED',
            'Ese abono ya está conciliado con otro movimiento.',
          );
        }
        const id = randomUUID();
        await tx.bankReconciliationMatch.create({
          data: {
            id,
            tenantId,
            movementId,
            paymentId,
            // Copias (el trigger las vuelve a poner desde el movimiento y el abono).
            bankAccountId: movement.bankAccountId,
            bookedOn: movement.bookedOn,
            paidAt: payment.paidAt,
            kind: BankReconciliationMatchKind.MANUAL,
            matchedById: userId,
          },
        });
        return {
          id,
          movementId,
          paymentId,
          kind: BankReconciliationMatchKind.MANUAL,
        };
      });
    } catch (error) {
      // Un emparejado simultáneo del mismo movimiento o abono (otra réplica,
      // otro bloqueo de cuenta): el único parcial manda.
      if (isUniqueViolation(error)) {
        throw new BankReconciliationConflict(
          'BANK_MOVEMENT_ALREADY_MATCHED',
          'Ese movimiento o ese abono ya se concilió: recarga la lista.',
        );
      }
      throw error;
    }
  }

  async unmatch(matchId: string, userId: string): Promise<{ id: string }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const match = await tx.bankReconciliationMatch.findFirst({
        where: { tenantId, id: matchId },
        select: { id: true, endedAt: true },
      });
      if (!match) throw new BankMatchNotFoundError();
      const { count } = await tx.bankReconciliationMatch.updateMany({
        where: { tenantId, id: matchId, endedAt: null },
        data: {
          endedAt: new Date(),
          endedById: userId,
          endReason: BankReconciliationMatchEndReason.UNMATCHED,
        },
      });
      if (count === 0) {
        throw new BankReconciliationConflict(
          'BANK_MATCH_ALREADY_ENDED',
          'Ese emparejado ya se deshizo.',
        );
      }
      return { id: matchId };
    });
  }
}
