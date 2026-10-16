import { Injectable } from '@nestjs/common';
import { seedDefaultBusinessHours } from '../../../../shared/locations/default-business-hours';
import { Location as PrismaLocation, Prisma } from '@prisma/client';
import {
  loadLocationTimeZones,
  timeZoneForCountry,
} from '../../../../shared/locations/location-time-zone';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateLocationRepoInput,
  Location,
  LocationRepository,
  UpdateLocationRepoInput,
} from '../../domain/ports/location-repository.port';

@Injectable()
export class PrismaLocationRepository implements LocationRepository {
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

  /** Añade a cada sede su zona (DX-097), leída en UNA consulta. */
  private async withTimeZones(
    tx: Prisma.TransactionClient,
    rows: PrismaLocation[],
  ): Promise<Location[]> {
    const zones = await loadLocationTimeZones(
      tx,
      this.requireTenantId(),
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      ...row,
      timeZone: zones.get(row.id) ?? timeZoneForCountry(row.country),
    }));
  }

  private async withTimeZone(
    tx: Prisma.TransactionClient,
    row: PrismaLocation | null,
  ): Promise<Location | null> {
    if (!row) return null;
    const [located] = await this.withTimeZones(tx, [row]);
    return located;
  }

  async create(input: CreateLocationRepoInput): Promise<Location> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.create({
        data: {
          tenantId,
          name: input.name,
          address: input.address,
          country: input.country,
        },
      });
      // Una sede nueva nace con horario por defecto, igual que la que se crea al
      // registrar la clínica — si no, unas sedes tendrían horario y otras no
      // según por dónde se crearon.
      // La zona del horario es la del país de la sede (DX-097): una sede en
      // España corta su día de caja a medianoche de Madrid, no de Bogotá.
      await seedDefaultBusinessHours(
        tx,
        tenantId,
        location.id,
        timeZoneForCountry(location.country),
      );
      const [created] = await this.withTimeZones(tx, [location]);
      return created;
    });
  }

  async list(): Promise<Location[]> {
    return this.prisma.runWithTenant(async (tx) =>
      this.withTimeZones(
        tx,
        await tx.location.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
      ),
    );
  }

  async findById(id: string): Promise<Location | null> {
    return this.prisma.runWithTenant(async (tx) =>
      this.withTimeZone(
        tx,
        await tx.location.findFirst({ where: { id, deletedAt: null } }),
      ),
    );
  }

  async update(
    id: string,
    patch: UpdateLocationRepoInput,
  ): Promise<Location | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.location.updateMany({
        where: { id, deletedAt: null },
        data: patch,
      });
      if (result.count === 0) return null;
      return this.withTimeZone(
        tx,
        await tx.location.findFirst({ where: { id, deletedAt: null } }),
      );
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
