import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  PlatformRepository,
  PlatformTenant,
} from '../../domain/ports/platform-repository.port';

/**
 * Consultas de PLATAFORMA: deliberadamente FUERA de `runWithTenant`. No es un
 * bypass de RLS — `tenants` y `users` son tablas globales sin RLS (solo las de
 * dominio y `clinic_memberships` la tienen). Aquí no se lee ningún dato clínico
 * de ninguna clínica.
 */
@Injectable()
export class PrismaPlatformRepository implements PlatformRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listTenants(): Promise<PlatformTenant[]> {
    return this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, subdomain: true, createdAt: true },
      orderBy: { name: 'asc' },
    });
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { isPlatformAdmin: true },
    });
    return user?.isPlatformAdmin === true;
  }
}
