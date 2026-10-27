import { Injectable } from '@nestjs/common';
import { seedDefaultBusinessHours } from '../../../../shared/locations/default-business-hours';
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

  async create(input: CreateLocationRepoInput): Promise<Location> {
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
          // R11: quien crea la sede eligió sus valores; no queda «por revisar».
          regionalSettingsReviewedAt: new Date(),
          phone: input.phone,
        },
      });
      // Una sede nueva nace con horario por defecto, igual que la que se crea al
      // registrar la clínica — si no, unas sedes tendrían horario y otras no
      // según por dónde se crearon. Su columna legada de zona es la de la sede
      // (R20).
      await seedDefaultBusinessHours(tx, tenantId, location.id, input.timeZone);
      return location;
    });
  }

  // G1: moneda, zona y locale son columnas de la sede y se devuelven tal
  // cual; un NULL (fila de una réplica antigua sin barrer) sale como null,
  // nunca como el valor de su país (R19).
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
        data: patch,
      });
      if (result.count === 0) return null;
      return tx.location.findFirst({ where: { id, deletedAt: null } });
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
