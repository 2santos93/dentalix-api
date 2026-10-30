import { seedInitialPaymentMethods } from '../../../payment-methods/infrastructure/prisma-payment-method.repository';
import { Injectable, Logger } from '@nestjs/common';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { clinicRegisteredAuditEvent } from '../../domain/registration-audit';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  MEMBERSHIP_LOCATIONS_SELECT,
  activeLocationIds,
} from '../../../../shared/locations/membership-locations';
import { seedDefaultBusinessHours } from '../../../../shared/locations/default-business-hours';
import { DEFAULT_DENTAL_CATALOG } from '../../../../shared/catalog/default-dental-catalog';
import { suggestedPhoneRegion } from '../../../../shared/phone/phone-number';
import { PLATFORM_DEFAULT_MAJORITY_AGE } from '../../../patients/domain/responsible-parties/majority-age';
import { PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS } from '../../../prescriptions/domain/prescription-settings';
import {
  AuthRepository,
  AuthUserRecord,
  ClinicLocationSettings,
  CreateClinicWithOwnerInput,
  MembershipRecord,
  SessionState,
} from '../../domain/ports/auth-repository.port';

@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  private readonly logger = new Logger('Auth');

  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(
    email: string,
  ): Promise<{ id: string; fullName: string } | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, fullName: true },
    });
  }

  // Sin `runWithTenant`: `users` no tiene RLS (es tabla global, como
  // `tenants`), y este lookup existe justamente para el caso en que el usuario
  // NO pertenece al tenant del host.
  async findUserForAuth(email: string): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        passwordHash: true,
        isPlatformAdmin: true,
        tokenVersion: true,
      },
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
        data: {
          name: input.clinicName,
          subdomain: input.subdomain,
          // DX-328: explícito; el default de la BD es el mismo valor.
          majorityAge: PLATFORM_DEFAULT_MAJORITY_AGE,
          // DX-324: igual con los ajustes de la receta.
          prescriptionPrintQuantityInWords:
            PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS.printQuantityInWords,
          prescriptionRequireClinicalRecordNumber:
            PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS.requireClinicalRecordNumber,
          prescriptionValidityDays:
            PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS.validityDays,
        },
        select: { id: true },
      });
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          fullName: input.fullName,
          // DX-029: el registro solo llega aquí tras el enlace del email.
          emailVerifiedAt: input.emailVerifiedAt,
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
      const location = await this.createMainLocation(
        tx,
        tenant.id,
        input.location,
      );
      // La sede nace con un horario de atención por defecto (editable en
      // /settings/horarios). En la misma tx para que no pueda quedar a medias.
      await seedDefaultBusinessHours(
        tx,
        tenant.id,
        location.id,
        location.timeZone,
      );
      // La clínica arranca con el catálogo semilla de procedimientos y
      // diagnósticos. Va DENTRO de la misma tx (tras setear el GUC de tenant)
      // para que el WITH CHECK de RLS acepte las filas del tenant recién creado.
      await tx.dentalCatalogItem.createMany({
        data: DEFAULT_DENTAL_CATALOG.map((item) => ({
          ...item,
          tenantId: tenant.id,
        })),
      });
      // DX-377: y con sus 4 medios de pago iniciales (uno por método antiguo).
      await seedInitialPaymentMethods(tx, tenant.id);
      // DX-359: el alta de la clínica y su ADMIN, auditada en esta misma
      // transacción (el GUC de tenant ya es el de la clínica nueva).
      await writeAuditEvent(
        tx,
        clinicRegisteredAuditEvent(input.request, {
          tenantId: tenant.id,
          userId: user.id,
          locationId: location.id,
        }),
      );
      return { tenantId: tenant.id, userId: user.id };
    });
  }

  /**
   * G1: la «Sede principal» con país, moneda, zona y formato del registro, ya
   * revisada (R11). G1-B fase 1 (spec §4.3): el reloj del registro se escribe
   * si viene. Sin él (web o réplica de G1) lo pone
   * `dx_g1b_backfill_location_hour_cycle` en esta misma transacción.
   */
  private async createMainLocation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    settings: ClinicLocationSettings,
  ): Promise<{ id: string; timeZone: string }> {
    const location = await tx.location.create({
      data: {
        tenantId,
        name: 'Sede principal',
        ...settings,
        // DX-329 (R2, I3): la sugerencia sale del país, aquí y no en el puerto.
        defaultPhoneRegion: suggestedPhoneRegion(settings.country),
        defaultPhoneRegionSetAt: new Date(),
        regionalSettingsReviewedAt: new Date(),
      },
      select: { id: true },
    });
    if (settings.hourCycle === null) {
      await this.backfillHourCycle(tx, tenantId, location.id);
    }
    return { id: location.id, timeZone: settings.timeZone };
  }

  /** G1-B fase 1: el único que rellena un reloj NULL (R5). Desaparece en fase 2. */
  private async backfillHourCycle(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT public.dx_g1b_backfill_location_hour_cycle(${tenantId}::uuid)`;
    this.logger.log({
      event: 'registration.location_hour_cycle_backfilled',
      tenantId,
      locationId,
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
          user: { select: { passwordHash: true, tokenVersion: true } },
          locations: MEMBERSHIP_LOCATIONS_SELECT,
        },
      });
      if (!membership) return null;
      return {
        userId: membership.userId,
        role: membership.role,
        passwordHash: membership.user.passwordHash,
        tokenVersion: membership.user.tokenVersion,
        allowedLocationIds: activeLocationIds(membership.locations),
      };
    });
  }

  // `users` y `tenants` son globales (sin RLS) → lectura directa. La membresía
  // sí tiene RLS: se lee DENTRO de runWithTenant(tenantId), con el tenant que
  // viene del refresh token VERIFICADO (firmado por nosotros), nunca del
  // cliente.
  async findSessionState(
    userId: string,
    tenantId: string | null,
  ): Promise<SessionState | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { tokenVersion: true, isPlatformAdmin: true },
    });
    if (!user) return null;
    if (tenantId === null) {
      return { ...user, tenant: null };
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) {
      return { ...user, tenant: null };
    }
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: { tenantId, userId, deletedAt: null },
        select: { role: true, locations: MEMBERSHIP_LOCATIONS_SELECT },
      }),
    );
    return {
      ...user,
      tenant: {
        membershipRole: membership?.role ?? null,
        allowedLocationIds: membership
          ? activeLocationIds(membership.locations)
          : null,
      },
    };
  }

  // Denylist de refresh tokens. Tabla global sin RLS → acceso directo, sin
  // runWithTenant. Idempotente: un doble logout del mismo jti no falla.
  async revokeToken(jti: string, expiresAt: Date): Promise<void> {
    await this.prisma.revokedToken.upsert({
      where: { jti },
      update: {},
      create: { jti, expiresAt },
    });
  }

  // INSERT a secas (no upsert): la PK `jti` es la que hace atómica la
  // rotación. Si dos /auth/refresh llegan a la vez con el mismo token, Postgres
  // serializa los dos INSERT y el segundo choca con P2002 → `false` → 401. Así
  // un refresh token nunca puede producir dos pares válidos. La fila guarda el
  // `exp` del token para que la purga programada (auth.purge-expired-tokens,
  // DX-085) la borre cuando ya no aporta nada.
  async consumeRefreshToken(jti: string, expiresAt: Date): Promise<boolean> {
    try {
      await this.prisma.revokedToken.create({ data: { jti, expiresAt } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
    return true;
  }
}
