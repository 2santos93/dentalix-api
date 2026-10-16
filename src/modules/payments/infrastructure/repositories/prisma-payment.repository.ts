import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CashRegisterPage,
  CashRegisterRow,
  CreatePaymentRepoInput,
  ListCashRegisterParams,
  ListPaymentsReceivedInRangeParams,
  PaymentRepository,
  PaymentVoidAudit,
  PaymentVoidTarget,
} from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';
import { CashPayment } from '../../domain/entities/cash-payment.entity';

type PrismaPayment = Prisma.PaymentGetPayload<Record<string, never>>;

/**
 * ¿Es un P2002 (violación de único)? Para el único PARCIAL (tenantId,
 * idempotencyKey) Prisma no informa `meta.target` ("(not available)"), así que
 * no se puede distinguir por nombre; quien lo usa relee por la clave y, si no
 * encuentra el abono original, relanza el error tal cual.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function mapToEntity(payment: PrismaPayment): Payment {
  return {
    id: payment.id,
    tenantId: payment.tenantId,
    treatmentPlanId: payment.treatmentPlanId,
    patientId: payment.patientId,
    amount: payment.amount.toNumber(),
    currency: payment.currency,
    paidAt: payment.paidAt,
    method: payment.method,
    notes: payment.notes,
    createdById: payment.createdById,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

// Lo que la caja lee de cada abono: el abono más paciente (vía su plan), plan y
// sede, en una sola `findMany` con `select` anidado — Prisma resuelve cada
// relación con UNA consulta por nivel para toda la página (`IN (...)`), nunca
// una por fila, así que el número de consultas no crece con la página.
const CASH_PAYMENT_SELECT = {
  id: true,
  createdById: true,
  // `createdAt` no se expone: solo alimenta la regla de anulación (canVoid).
  createdAt: true,
  paidAt: true,
  amount: true,
  currency: true,
  method: true,
  notes: true,
  location: { select: { id: true, name: true } },
  plan: {
    select: {
      id: true,
      status: true,
      createdAt: true,
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.PaymentSelect;

type PrismaCashPayment = Prisma.PaymentGetPayload<{
  select: typeof CASH_PAYMENT_SELECT;
}>;

function mapToCashRow(
  row: PrismaCashPayment,
  timeZoneOf: (locationId: string) => string,
): CashRegisterRow {
  return {
    payment: mapToCashPayment(row),
    voidSubject: {
      createdById: row.createdById,
      createdAt: row.createdAt,
      timeZone: timeZoneOf(row.location.id),
    },
  };
}

function mapToCashPayment(row: PrismaCashPayment): CashPayment {
  return {
    id: row.id,
    createdById: row.createdById,
    paidAt: row.paidAt,
    amount: row.amount.toNumber(),
    currency: row.currency,
    method: row.method,
    notes: row.notes,
    location: { id: row.location.id, name: row.location.name },
    // `Payment.patientId` es la copia desnormalizada de `plan.patientId` (ver
    // RecordPaymentUseCase), así que el paciente del plan ES el del abono.
    patient: {
      id: row.plan.patient.id,
      fullName: `${row.plan.patient.firstName} ${row.plan.patient.lastName}`,
    },
    treatmentPlan: {
      id: row.plan.id,
      status: row.plan.status,
      createdAt: row.plan.createdAt,
    },
  };
}

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant`, so the value written always matches
   * the GUC the WITH CHECK policy validates against (same convention as
   * PrismaSaleRepository / PrismaTreatmentPlanRepository).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /**
   * Filtro por sede activa, o `{}` si el request no fijó ninguna (vista
   * consolidada de la clínica). Se aplica SOLO donde la sede es semánticamente
   * correcta — ver los comentarios en cada consulta.
   */
  private locationFilter(): { locationId?: string } {
    const locationId = this.tenantContext.getLocationId();
    return locationId ? { locationId } : {};
  }

  async create(input: CreatePaymentRepoInput): Promise<Payment> {
    try {
      return await this.insert(input);
    } catch (error) {
      // DB-014: dos reintentos SIMULTÁNEOS con la misma Idempotency-Key pasan
      // los dos el atajo del caso de uso; el segundo INSERT espera al COMMIT
      // del primero y choca con el único parcial. El contrato de idempotencia
      // promete devolver el abono original, no un 409: se relee y se devuelve.
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const original = await this.findByIdempotencyKey(input.idempotencyKey);
        if (original) {
          return original;
        }
      }
      throw error;
    }
  }

  private async insert(input: CreatePaymentRepoInput): Promise<Payment> {
    const tenantId = this.requireTenantId();
    const payment = await this.prisma.runWithTenant(async (tx) => {
      // DB-014: el plan se vuelve a validar DENTRO de la transacción del
      // INSERT, vivo y con el paciente del abono, y queda bloqueado en modo
      // compartido (FOR SHARE) hasta el COMMIT: nadie puede retirarlo entre la
      // comprobación y el alta. La FK compuesta no mira `deletedAt`.
      const [plan] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "treatment_plans"
         WHERE "id" = ${input.treatmentPlanId}::uuid
           AND "patientId" = ${input.patientId}::uuid
           AND "deletedAt" IS NULL
         FOR SHARE`;
      if (!plan) {
        throw new NotFoundException('Treatment plan not found');
      }
      return tx.payment.create({
        data: {
          // Sede del request si el cliente la fijó (X-Location-Id, ya validada
          // contra esta clínica); si no, la sede por defecto — que es lo que
          // hacen hoy todos los clientes y mantiene el comportamiento igual.
          locationId:
            this.tenantContext.getLocationId() ??
            (await resolveDefaultLocationId(tx)),
          tenantId,
          treatmentPlanId: input.treatmentPlanId,
          patientId: input.patientId,
          amount: input.amount,
          currency: input.currency,
          paidAt: input.paidAt,
          method: input.method,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          createdById: input.createdById,
        },
      });
    });
    return mapToEntity(payment);
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = await this.prisma.runWithTenant(async (tx) => {
      return tx.payment.findFirst({ where: { id, deletedAt: null } });
    });
    return payment ? mapToEntity(payment) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    // RLS (runWithTenant) scopes this to the current tenant, matching the
    // (tenantId, idempotencyKey) unique index. NOT filtered by `deletedAt`: a
    // replay must resolve to the SAME row even if it was later voided, so we
    // never insert a duplicate for a key that already exists.
    const payment = await this.prisma.runWithTenant(async (tx) => {
      return tx.payment.findFirst({ where: { idempotencyKey } });
    });
    return payment ? mapToEntity(payment) : null;
  }

  // OJO: listByPlan/listByPatient NO filtran por sede a propósito. El plan y
  // el paciente son de la CLÍNICA, no de una sede; filtrarlos haría que el
  // saldo del paciente cambiara según desde qué sede se mire, que es
  // justamente lo contrario de la "ficha centralizada" que define este modelo.
  async listByPlan(treatmentPlanId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { treatmentPlanId, deletedAt: null },
        orderBy: { paidAt: 'desc' },
      });
      return payments.map(mapToEntity);
    });
  }

  async listByPatient(patientId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { patientId, deletedAt: null },
        orderBy: { paidAt: 'desc' },
      });
      return payments.map(mapToEntity);
    });
  }

  async findVoidTarget(id: string): Promise<PaymentVoidTarget | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          createdById: true,
          createdAt: true,
          locationId: true,
        },
      });
      if (!payment) {
        return null;
      }
      // "Hoy" es el día civil de la sede del abono (su horario), nunca el
      // UTC del servidor; ver `resolveLocationTimeZones`.
      const timeZoneOf = await resolveLocationTimeZones(
        tx,
        this.requireTenantId(),
        [payment.locationId],
      );
      return {
        id: payment.id,
        createdById: payment.createdById,
        createdAt: payment.createdAt,
        timeZone: timeZoneOf(payment.locationId),
      };
    });
  }

  async softDelete(id: string, audit: PaymentVoidAudit): Promise<boolean> {
    // Single atomic UPDATE ... WHERE id = ? AND deletedAt IS NULL (RLS
    // additionally scopes it to the current tenant) instead of a
    // findFirst-then-update pair -- that sequence let two concurrent voids
    // of the same payment both pass the "not yet voided" check (TOCTOU
    // race), since `update({ where: { id } })` alone never re-checked
    // `deletedAt`. `count` tells the caller, in one round trip, whether
    // THIS call actually voided the row. The audit (who/when/why, SEC-013)
    // goes in the SAME statement, so a voided row never lacks it.
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.payment.updateMany({
        where: { id, deletedAt: null },
        data: {
          deletedAt: audit.voidedAt,
          voidedAt: audit.voidedAt,
          voidedById: audit.voidedById,
          voidReason: audit.reason,
        },
      });
      return result.count > 0;
    });
  }

  async listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: {
          deletedAt: null,
          paidAt: { gte: params.from, lt: params.to },
          // La CAJA del periodo sí es por sede (es lo que se arquea).
          ...this.locationFilter(),
        },
        orderBy: { paidAt: 'desc' },
      });
      return payments.map(mapToEntity);
    });
  }

  async listForCashRegister(
    params: ListCashRegisterParams,
  ): Promise<CashRegisterPage> {
    const locationId = this.tenantContext.getLocationId();
    const where: Prisma.PaymentWhereInput = {
      deletedAt: null,
      paidAt: { gte: params.from, lt: params.toExclusive },
      ...(params.method ? { method: params.method } : {}),
      // La caja es por sede, igual que listReceivedInRange: es lo que se
      // arquea. Con sede, la sirve payments_tenantId_locationId_paidAt_active_idx;
      // sin ella (vista consolidada), payments_tenantId_paidAt_active_idx.
      ...this.locationFilter(),
    };

    return this.prisma.runWithTenant(
      async (tx) => {
        // Página, conteo, agregado y sede en la MISMA transacción REPEATABLE
        // READ: todas las sentencias ven la misma foto, así que un abono
        // registrado o anulado a mitad de camino no puede dejar un total que
        // describa otras filas que las devueltas (en READ COMMITTED, el nivel
        // por defecto, cada sentencia vería su propia foto).
        const [rows, total, groups, scopeLocation] = await Promise.all([
          tx.payment.findMany({
            where,
            select: CASH_PAYMENT_SELECT,
            // `paidAt` es un día civil: todos los abonos de un día empatan, y
            // sin un desempate estable la paginación podría repetir o saltarse
            // filas de ese día entre una página y la siguiente.
            orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
            skip: params.skip,
            take: params.take,
          }),
          tx.payment.count({ where }),
          tx.payment.groupBy({
            by: ['currency', 'method'],
            where,
            _sum: { amount: true },
            _count: { _all: true },
            orderBy: [{ currency: 'asc' }, { method: 'asc' }],
          }),
          locationId
            ? tx.location.findFirst({
                // El interceptor ya la validó (activa y de esta clínica); se
                // repite el filtro para que una sede retirada entre la
                // validación y esta lectura no reaparezca como alcance.
                where: { id: locationId, deletedAt: null },
                select: { id: true, name: true },
              })
            : Promise.resolve(null),
        ]);

        // Zona de cada sede de la página, en UNA consulta y en la misma foto:
        // el `canVoid` de cada fila usa el mismo "hoy" que la anulación.
        const timeZoneOf = await resolveLocationTimeZones(
          tx,
          this.requireTenantId(),
          rows.map((row) => row.location.id),
        );

        return {
          items: rows.map((row) => mapToCashRow(row, timeZoneOf)),
          total,
          groups: groups.map((group) => ({
            currency: group.currency,
            method: group.method,
            total: group._sum.amount?.toNumber() ?? 0,
            count: group._count._all,
          })),
          scopeLocation,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
