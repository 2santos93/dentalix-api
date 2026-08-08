import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { seedDefaultBusinessHours } from '../../../../shared/locations/default-business-hours';
import { DEFAULT_DENTAL_CATALOG } from '../../../../shared/catalog/default-dental-catalog';
import {
  AuthRepository,
  AuthUserRecord,
  CreateClinicWithOwnerInput,
  MembershipRecord,
} from '../../domain/ports/auth-repository.port';

@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
  }

  // Sin `runWithTenant`: `users` no tiene RLS (es tabla global, como
  // `tenants`), y este lookup existe justamente para el caso en que el usuario
  // NO pertenece al tenant del host.
  async findUserForAuth(email: string): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, passwordHash: true, isPlatformAdmin: true },
    });
  }

  async findTenantBySubdomain(
    subdomain: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.tenant.findFirst({
      where: { subdomain, deletedAt: null },
      select: { id: true },
    });
  }

  async createClinicWithOwner(
    input: CreateClinicWithOwnerInput,
  ): Promise<{ tenantId: string; userId: string }> {
    // Atomic: tenant + user + owner membership in ONE transaction, so a failed
    // membership insert never leaves an orphaned tenant or an owner-less user.
    // tenants/users have no RLS; the membership does, so we set the tenant GUC
    // (SET LOCAL via set_config(..., true)) inside the SAME tx before inserting it
    // so the RLS WITH CHECK passes for the freshly created tenant.
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const tenant = await tx.tenant.create({
        data: { name: input.clinicName, subdomain: input.subdomain },
        select: { id: true },
      });
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          fullName: input.fullName,
        },
        select: { id: true },
      });
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenant.id}, true)`;
      await tx.clinicMembership.create({
        data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
      });
      // Toda clínica nace con una sede. La migración de multi-sede creó la
      // "Sede principal" de las clínicas que YA existían; esto cubre las
      // nuevas, y va en la MISMA transacción para que no pueda existir una
      // clínica sin sede (citas, pagos e inventario la exigen).
      const location = await tx.location.create({
        data: { tenantId: tenant.id, name: 'Sede principal' },
        select: { id: true },
      });
      // La sede nace con un horario de atención por defecto (editable en
      // /settings/horarios). En la misma tx para que no pueda quedar a medias.
      await seedDefaultBusinessHours(tx, tenant.id, location.id);
      // La clínica arranca con el catálogo semilla de procedimientos y
      // diagnósticos. Va DENTRO de la misma tx (tras setear el GUC de tenant)
      // para que el WITH CHECK de RLS acepte las filas del tenant recién creado.
      await tx.dentalCatalogItem.createMany({
        data: DEFAULT_DENTAL_CATALOG.map((item) => ({
          ...item,
          tenantId: tenant.id,
        })),
      });
      return { tenantId: tenant.id, userId: user.id };
    });
  }

  async findMembership(
    tenantId: string,
    email: string,
  ): Promise<MembershipRecord | null> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { tenantId, deletedAt: null, user: { email, deletedAt: null } },
        select: {
          userId: true,
          role: true,
          user: { select: { passwordHash: true } },
        },
      });
      if (!membership) return null;
      return {
        userId: membership.userId,
        role: membership.role,
        passwordHash: membership.user.passwordHash,
      };
    });
  }

  // Denylist de refresh tokens. Tabla global sin RLS → acceso directo, sin
  // runWithTenant. Idempotente: un doble logout del mismo jti no falla.
  async revokeToken(jti: string, expiresAt: Date): Promise<void> {
    await this.prisma.revokedToken.upsert({
      where: { jti },
      update: {},
      create: { jti, expiresAt },
    });
    // Limpieza lazy: al revocar, purga los que ya expiraron (su token base ya
    // es inválido por TTL, así que la fila no aporta nada).
    // Excepción justificada al borrado blando: `revoked_tokens` no es un dato
    // de negocio sino una denylist con TTL. Una fila cuyo `expiresAt` ya pasó
    // no aporta nada (el token base es inválido por TTL), así que retenerla en
    // blando sólo haría crecer la tabla sin que nadie pueda consultarla nunca.
    // eslint-disable-next-line no-restricted-syntax
    await this.prisma.revokedToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    const row = await this.prisma.revokedToken.findUnique({
      where: { jti },
      select: { jti: true },
    });
    return row !== null;
  }
}
