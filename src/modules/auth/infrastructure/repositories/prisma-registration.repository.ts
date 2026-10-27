import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PendingRegistrationRecord,
  RegistrationRepository,
} from '../../domain/ports/registration-repository.port';
import type { ClinicLocationSettings } from '../../domain/ports/auth-repository.port';

const SELECT = {
  id: true,
  email: true,
  clinicName: true,
  subdomain: true,
  fullName: true,
  passwordHash: true,
  expiresAt: true,
  locationCountry: true,
  locationCurrency: true,
  locationTimeZone: true,
  locationLocale: true,
} as const;

type PendingRow = Prisma.PendingRegistrationGetPayload<{
  select: typeof SELECT;
}>;

/** G1: un pendiente legado (sin los cuatro campos) no trae sede. */
function locationOf(row: PendingRow): ClinicLocationSettings | null {
  const {
    locationCountry: country,
    locationCurrency: currency,
    locationTimeZone: timeZone,
    locationLocale: locale,
  } = row;
  if (!country || !currency || !timeZone || !locale) return null;
  return { country, currency, timeZone, locale };
}

function toRecord(row: PendingRow): PendingRegistrationRecord {
  return {
    id: row.id,
    email: row.email,
    clinicName: row.clinicName,
    subdomain: row.subdomain,
    fullName: row.fullName,
    passwordHash: row.passwordHash,
    expiresAt: row.expiresAt,
    location: locationOf(row),
  };
}

/**
 * `pending_registrations` es tabla global (aún no hay clínica): sin
 * `runWithTenant`, igual que `users`.
 */
@Injectable()
export class PrismaRegistrationRepository implements RegistrationRepository {
  private readonly logger = new Logger('Auth');

  constructor(private readonly prisma: PrismaService) {}

  async savePending(
    input: Omit<PendingRegistrationRecord, 'id'> & {
      tokenHash: string;
      replaceCreatedBefore: Date;
    },
  ): Promise<boolean> {
    const now = new Date();
    const data = {
      clinicName: input.clinicName,
      subdomain: input.subdomain,
      fullName: input.fullName,
      passwordHash: input.passwordHash,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: now,
      // G1: también en la rama que reemplaza (updateMany): registrarse de
      // nuevo sobrescribe la sede, y la forma legada la deja en NULL.
      locationCountry: input.location?.country ?? null,
      locationCurrency: input.location?.currency ?? null,
      locationTimeZone: input.location?.timeZone ?? null,
      locationLocale: input.location?.locale ?? null,
    };
    const saved = await this.replaceOrCreate(input.email, data, {
      replaceCreatedBefore: input.replaceCreatedBefore,
      now,
    });
    await this.purgeExpired();
    return saved;
  }

  /**
   * DX-144: reemplaza solo un pendiente viejo (anterior al corte) o caducado,
   * en un UPDATE condicional (con varias peticiones a la vez, Postgres vuelve
   * a evaluar la condición sobre la fila bloqueada: gana una). Si no había
   * ninguno lo crea; si otra petición lo creó entretanto, el índice único del
   * email lo rechaza (P2002) y no se guarda.
   */
  private async replaceOrCreate(
    email: string,
    data: Omit<Prisma.PendingRegistrationCreateInput, 'email'>,
    at: { replaceCreatedBefore: Date; now: Date },
  ): Promise<boolean> {
    const { count } = await this.prisma.pendingRegistration.updateMany({
      where: {
        email,
        OR: [
          { createdAt: { lt: at.replaceCreatedBefore } },
          { expiresAt: { lte: at.now } },
        ],
      },
      data,
    });
    if (count === 1) return true;
    try {
      await this.prisma.pendingRegistration.create({
        data: { email, ...data },
        select: { id: true },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
  }

  async findPendingByTokenHash(
    tokenHash: string,
  ): Promise<PendingRegistrationRecord | null> {
    const row = await this.prisma.pendingRegistration.findUnique({
      where: { tokenHash },
      select: SELECT,
    });
    return row ? toRecord(row) : null;
  }

  async consumePending(id: string): Promise<boolean> {
    // Borrado duro legítimo: el pendiente es transitorio (guarda un hash de
    // contraseña) y consumirlo ES borrarlo; no hay nada que conservar.
    // eslint-disable-next-line no-restricted-syntax
    const { count } = await this.prisma.pendingRegistration.deleteMany({
      where: { id },
    });
    return count === 1;
  }

  // Limpieza lazy (como `revoked_tokens`): un pendiente caducado ya no sirve
  // y guarda un email y un hash de contraseña, así que no se conserva. Es
  // mantenimiento oportunista: si falla, el registro ya quedó guardado.
  private async purgeExpired(): Promise<void> {
    try {
      // eslint-disable-next-line no-restricted-syntax
      await this.prisma.pendingRegistration.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch (err) {
      this.logger.warn({
        event: 'registration.purge_failed',
        error: err instanceof Error ? err.constructor.name : typeof err,
      });
    }
  }
}
