import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  AccountBackoffPolicy,
  LoginThrottleKeys,
  LoginThrottleRepository,
} from '../../domain/ports/login-throttle-repository.port';

const NOW = Prisma.sql`timezone('utc', now())`;
const ACCOUNT = Prisma.sql`'ACCOUNT'::"LoginThrottleScope"`;
const IP = Prisma.sql`'IP'::"LoginThrottleScope"`;

const interval = (ms: number): Prisma.Sql =>
  Prisma.sql`make_interval(secs => ${ms / 1000}::double precision)`;

/**
 * Hasta cuándo espera una cuenta con `failures` fallos (expresión SQL), o NULL
 * si aún no toca esperar. Misma fórmula que `accountBackoffMs`: base·2^k con
 * tope, k = fallos − libres (acotado a 31, sin desbordes).
 */
const backoffUntil = (
  failures: Prisma.Sql,
  p: AccountBackoffPolicy,
): Prisma.Sql => Prisma.sql`CASE WHEN ${failures} >= ${p.freeFailures}::int
  THEN ${NOW} + make_interval(secs => LEAST(${p.maxDelayMs}::double precision,
         ${p.baseDelayMs}::double precision * power(2::double precision, LEAST(${failures} - ${p.freeFailures}::int, 31))) / 1000)
  END`;

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

  async claimAccountAttempt(
    accountKeyHash: string,
    policy: AccountBackoffPolicy,
  ): Promise<number> {
    // En ON CONFLICT … SET todas las expresiones leen la fila ANTERIOR (t.*).
    // El WHERE del DO UPDATE se reevalúa sobre la versión más reciente tras
    // esperar el bloqueo de fila: de N intentos simultáneos con la espera
    // recién acabada, el primero la renueva y los demás ya no actualizan.
    const stale = Prisma.sql`t."lastFailureAt" <= ${NOW} - ${interval(policy.failureMemoryMs)}`;
    const failures = Prisma.sql`(CASE WHEN ${stale} THEN 1 ELSE t."failures" + 1 END)`;
    const rows = await this.prisma.$queryRaw<{ failures: number }[]>`
      INSERT INTO "login_throttles" AS t
             ("scope", "keyHash", "failures", "windowStartedAt", "lastFailureAt", "blockedUntil")
      VALUES (${ACCOUNT}, ${accountKeyHash}, 1, ${NOW}, ${NOW}, ${backoffUntil(Prisma.sql`1`, policy)})
      ON CONFLICT ("scope", "keyHash") DO UPDATE SET
        "failures" = ${failures},
        "windowStartedAt" = CASE WHEN ${stale} THEN ${NOW} ELSE t."windowStartedAt" END,
        "lastFailureAt" = ${NOW},
        "blockedUntil" = CASE
          WHEN ${stale} THEN ${backoffUntil(Prisma.sql`1`, policy)}
          ELSE GREATEST(t."blockedUntil", ${backoffUntil(failures, policy)})
        END
      WHERE t."blockedUntil" IS NULL OR t."blockedUntil" <= ${NOW}
      RETURNING "failures"`;
    if (rows.length > 0) return 0;
    // No se actualizó: otra petición dejó la cuenta en espera justo antes.
    // Sentencia nueva = foto nueva (READ COMMITTED): ya ve esa espera. Si
    // entretanto un login correcto borró la fila, se pide reintentar en 1 s.
    const [row] = await this.prisma.$queryRaw<{ seconds: number }[]>`
      SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM ("blockedUntil" - ${NOW}))), 1)::int AS seconds
        FROM "login_throttles"
       WHERE "scope" = ${ACCOUNT} AND "keyHash" = ${accountKeyHash}`;
    return row?.seconds ?? 1;
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
