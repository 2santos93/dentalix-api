import { Injectable, Logger } from '@nestjs/common';
import { seedDefaultBusinessHours } from '../../../../shared/locations/default-business-hours';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { locationCreatedAuditEvent } from '../../domain/location-audit';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateLocationRepoInput,
  Location,
  LocationRepository,
  RegionalWrite,
  RegionalWriteContext,
  UpdateLocationRepoInput,
} from '../../domain/ports/location-repository.port';

/** DX-329: escribir la región (también null) deja la marca de quién decidió. */
function withDecisionMark(
  patch: UpdateLocationRepoInput,
): UpdateLocationRepoInput & { defaultPhoneRegionSetAt?: Date } {
  return patch.defaultPhoneRegion === undefined
    ? patch
    : { ...patch, defaultPhoneRegionSetAt: new Date() };
}

@Injectable()
export class PrismaLocationRepository implements LocationRepository {
  private readonly logger = new Logger('Locations');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Igual que el resto de repos: el INSERT necesita el tenant explícito (el
  // RLS solo filtra SELECT/UPDATE), y se toma del contexto, nunca del cliente.
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async create(
    input: CreateLocationRepoInput,
    audit: AuditRequestContext,
  ): Promise<Location> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.create({
        data: {
          tenantId,
          name: input.name,
          address: input.address,
          country: input.country,
          currency: input.currency,
          timeZone: input.timeZone,
          locale: input.locale,
          hourCycle: input.hourCycle,
          // R11: quien crea la sede eligió sus valores; no queda «por revisar».
          regionalSettingsReviewedAt: new Date(),
          phone: input.phone,
          // DX-329: la API nueva decidió la región, también si es «ninguna».
          defaultPhoneRegion: input.defaultPhoneRegion,
          defaultPhoneRegionSetAt: new Date(),
        },
      });
      // Una sede nueva nace con horario por defecto, igual que la que se crea al
      // registrar la clínica — si no, unas sedes tendrían horario y otras no
      // según por dónde se crearon. Su columna legada de zona es la de la sede
      // (R20).
      await seedDefaultBusinessHours(tx, tenantId, location.id, input.timeZone);
      if (input.hourCycle !== null) {
        await writeAuditEvent(tx, locationCreatedAuditEvent(audit, location));
        return location;
      }
      // G1-B fase 1 (spec §4.1): alta de la web de G1, sin reloj. La función
      // es lo único que rellena un NULL (R5), en esta misma transacción; no
      // toca la revisión. Desaparece en fase 2.
      await tx.$queryRaw`SELECT public.dx_g1b_backfill_location_hour_cycle(${tenantId}::uuid)`;
      this.logger.log({
        event: 'location.create_hour_cycle_backfilled',
        tenantId,
        locationId: location.id,
      });
      const filled = await tx.location.findUniqueOrThrow({
        where: { id: location.id },
      });
      await writeAuditEvent(tx, locationCreatedAuditEvent(audit, filled));
      return filled;
    });
  }

  // G1: moneda, zona y locale son columnas de la sede y se devuelven tal
  // cual; un NULL (fila de una réplica antigua sin barrer) sale como null,
  // nunca como el valor de su país (R19). G1-B: igual el reloj.
  async list(): Promise<Location[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async findById(id: string): Promise<Location | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({ where: { id, deletedAt: null } }),
    );
  }

  async update(
    id: string,
    patch: UpdateLocationRepoInput,
  ): Promise<Location | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.location.updateMany({
        where: { id, deletedAt: null },
        data: withDecisionMark(patch),
      });
      if (result.count === 0) return null;
      return tx.location.findFirst({ where: { id, deletedAt: null } });
    });
  }

  async updateRegional(
    id: string,
    patch: UpdateLocationRepoInput,
    decide: (ctx: RegionalWriteContext) => Promise<RegionalWrite>,
  ): Promise<Location | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Abrir una caja inserta una fila con FK a la sede (KEY SHARE), que choca
      // con este FOR UPDATE: o la caja entra antes y la vemos, o espera.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "locations"
        WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid
          AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) return null;
      const current = await tx.location.findFirst({
        where: { id, deletedAt: null },
      });
      if (!current) return null;

      const where = { tenantId, locationId: id };
      const write = await decide({
        current,
        hasOpenCashSession: async () =>
          (await tx.cashSession.findFirst({
            where: { ...where, status: 'OPEN' },
            select: { id: true },
          })) !== null,
        hasRegionalHistory: async () => {
          const probes = await Promise.all([
            tx.appointment.findFirst({ where, select: { id: true } }),
            tx.payment.findFirst({ where, select: { id: true } }),
            tx.expense.findFirst({ where, select: { id: true } }),
            tx.expensePayment.findFirst({ where, select: { id: true } }),
            tx.cashSessionAdjustment.findFirst({ where, select: { id: true } }),
            tx.inventoryItem.findFirst({ where, select: { id: true } }),
            tx.cashSession.findFirst({ where, select: { id: true } }),
            tx.priceList.findFirst({ where, select: { id: true } }),
            tx.cancellationPolicyVersion.findFirst({
              where,
              select: { id: true },
            }),
          ]);
          return probes.some((row) => row !== null);
        },
      });

      const updated = await tx.location.update({
        where: { id },
        data: {
          ...withDecisionMark(patch),
          currency: write.currency,
          timeZone: write.timeZone,
          locale: write.locale,
          hourCycle: write.hourCycle,
          ...(write.reviewed ? { regionalSettingsReviewedAt: new Date() } : {}),
        },
      });
      if (write.timeZone !== undefined && write.timeZone !== current.timeZone) {
        // R20: la columna legada del horario sigue la zona de la sede.
        await tx.locationSchedule.updateMany({
          where: { tenantId, locationId: id },
          data: { timezone: write.timeZone },
        });
      }
      return updated;
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.location.count({ where: { deletedAt: null, isActive: true } }),
    );
  }

  async hasOperations(id: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const [appointments, payments, items] = await Promise.all([
        tx.appointment.count({ where: { locationId: id, deletedAt: null } }),
        tx.payment.count({ where: { locationId: id, deletedAt: null } }),
        tx.inventoryItem.count({ where: { locationId: id, deletedAt: null } }),
      ]);
      return appointments + payments + items > 0;
    });
  }
}
