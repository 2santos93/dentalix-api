import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  LoginThrottleKeys,
  LoginThrottleRepository,
} from '../../domain/ports/login-throttle-repository.port';

const NOW = Prisma.sql`timezone('utc', now())`;
const ACCOUNT = Prisma.sql`'ACCOUNT'::"LoginThrottleScope"`;
const IP = Prisma.sql`'IP'::"LoginThrottleScope"`;

const interval = (ms: number): Prisma.Sql =>
  Prisma.sql`make_interval(secs => ${ms / 1000}::double precision)`;

/**
 * `login_throttles` (DX-048): tabla de plataforma sin RLS, con el cliente base
 * y fuera de `runWithTenant` (el login no conoce aún al usuario). Cada
 * escritura es UNA sentencia (`INSERT … ON CONFLICT DO UPDATE`), así que dos
 * réplicas que fallan a la vez suman los dos fallos. Todas las horas son de
 * la BD. El borrado de la fila de una cuenta es housekeeping legítimo (la
 * fila es un contador, no un dato de negocio) y va en SQL.
 */
@Injectable()
export class PrismaLoginThrottleRepository implements LoginThrottleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async retryAfterSeconds(keys: LoginThrottleKeys): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ seconds: number }[]>`
      SELECT COALESCE(MAX(CEIL(EXTRACT(EPOCH FROM ("blockedUntil" - ${NOW})))), 0)::int AS seconds
        FROM "login_throttles"
       WHERE (("scope" = ${ACCOUNT} AND "keyHash" = ${keys.accountKeyHash})
           OR ("scope" = ${IP} AND "keyHash" = ${keys.ipKeyHash}))
         AND "blockedUntil" > ${NOW}`;
    return rows[0]?.seconds ?? 0;
  }

  async recordAccountFailure(
    accountKeyHash: string,
    failureMemoryMs: number,
  ): Promise<number> {
    // En ON CONFLICT … SET todas las expresiones leen la fila ANTERIOR (t.*).
    const stale = Prisma.sql`t."lastFailureAt" <= ${NOW} - ${interval(failureMemoryMs)}`;
    const rows = await this.prisma.$queryRaw<{ failures: number }[]>`
      INSERT INTO "login_throttles" AS t
             ("scope", "keyHash", "failures", "windowStartedAt", "lastFailureAt", "blockedUntil")
      VALUES (${ACCOUNT}, ${accountKeyHash}, 1, ${NOW}, ${NOW}, NULL)
      ON CONFLICT ("scope", "keyHash") DO UPDATE SET
        "failures" = CASE WHEN ${stale} THEN 1 ELSE t."failures" + 1 END,
        "windowStartedAt" = CASE WHEN ${stale} THEN ${NOW} ELSE t."windowStartedAt" END,
        "blockedUntil" = CASE WHEN ${stale} THEN NULL ELSE t."blockedUntil" END,
        "lastFailureAt" = ${NOW}
      RETURNING "failures"`;
    return rows[0].failures;
  }

  async blockAccount(accountKeyHash: string, delayMs: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "login_throttles"
         SET "blockedUntil" = GREATEST(COALESCE("blockedUntil", ${NOW}), ${NOW} + ${interval(delayMs)})
       WHERE "scope" = ${ACCOUNT} AND "keyHash" = ${accountKeyHash}`;
  }

  async recordIpFailure(
    ipKeyHash: string,
    limit: number,
    windowMs: number,
  ): Promise<void> {
    const win = interval(windowMs);
    const fresh = Prisma.sql`t."windowStartedAt" <= ${NOW} - ${win}`;
    const failures = Prisma.sql`(CASE WHEN ${fresh} THEN 1 ELSE t."failures" + 1 END)`;
    const start = Prisma.sql`(CASE WHEN ${fresh} THEN ${NOW} ELSE t."windowStartedAt" END)`;
    await this.prisma.$executeRaw`
      INSERT INTO "login_throttles" AS t
             ("scope", "keyHash", "failures", "windowStartedAt", "lastFailureAt", "blockedUntil")
      VALUES (${IP}, ${ipKeyHash}, 1, ${NOW}, ${NOW},
              CASE WHEN 1 >= ${limit} THEN ${NOW} + ${win} END)
      ON CONFLICT ("scope", "keyHash") DO UPDATE SET
        "failures" = ${failures},
        "windowStartedAt" = ${start},
        "lastFailureAt" = ${NOW},
        "blockedUntil" = CASE WHEN ${failures} >= ${limit} THEN ${start} + ${win} END`;
  }

  async clearAccount(accountKeyHash: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "login_throttles"
       WHERE "scope" = ${ACCOUNT} AND "keyHash" = ${accountKeyHash}`;
  }

  async accountBlockedUntil(accountKeyHash: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ blockedUntil: Date }[]>`
      SELECT "blockedUntil" FROM "login_throttles"
       WHERE "scope" = ${ACCOUNT} AND "keyHash" = ${accountKeyHash}
         AND "blockedUntil" > ${NOW}`;
    return rows[0]?.blockedUntil ?? null;
  }
}
