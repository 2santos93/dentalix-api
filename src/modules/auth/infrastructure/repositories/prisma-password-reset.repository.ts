import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClinicRole, Prisma, UserTokenPurpose } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { sqlStateOf } from '../../../../shared/prisma/prisma-exception.filter';
import { PasswordResetThrottledError } from '../../domain/password-reset-throttled.error';
import type {
  PasswordResetRepository,
  ResetRecipient,
  ResetTokenRecord,
} from '../../domain/ports/password-reset-repository.port';

const PURPOSE = UserTokenPurpose.PASSWORD_RESET;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DX-149-ter: `lock_timeout` de la transacción que emite el enlace. El
 * endpoint es público: una ráfaga contra la misma persona espera, como mucho
 * esto, al candado de su fila o al del tope de su email, y luego cuenta como
 * tope (nada cambia). Así una inundación no deja el pool sin conexiones para
 * las demás clínicas.
 */
export const PASSWORD_RESET_LOCK_TIMEOUT_MS = 1000;
/** Para los tests: otro `lock_timeout` (ms) que el de producción. */
export const PASSWORD_RESET_LOCK_TIMEOUT = Symbol(
  'PASSWORD_RESET_LOCK_TIMEOUT',
);

/** 55P03 lock_not_available: se agotó el `lock_timeout` esperando un candado. */
function isLockTimeout(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError) &&
    sqlStateOf(error) === '55P03'
  );
}

/**
 * Bloquea la fila del usuario hasta el final de la transacción. `issue` y
 * `consumeInTx` lo hacen PRIMERO, así se serializan entre sí (dos peticiones
 * de enlace a la vez no dejan dos vivos) y en el mismo orden (sin deadlock).
 */
async function lockUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
}

/** Interno: deshace la transacción cuando el usuario ya no existe. */
class UserGoneError extends Error {
  constructor() {
    super('user gone');
    this.name = 'UserGoneError';
  }
}

/**
 * `user_tokens` y `users` son tablas globales (sin RLS): se leen y escriben
 * directamente. La membresía SÍ tiene RLS y se lee con `runWithTenant` del
 * tenant del HOST (resuelto por el servidor, nunca un id del cliente).
 */
@Injectable()
export class PrismaPasswordResetRepository implements PasswordResetRepository {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(PASSWORD_RESET_LOCK_TIMEOUT)
    lockTimeoutMs?: number,
  ) {
    this.lockTimeoutMs = lockTimeoutMs ?? PASSWORD_RESET_LOCK_TIMEOUT_MS;
  }

  async findActiveMember(
    tenantId: string,
    email: string,
  ): Promise<ResetRecipient | null> {
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          user: {
            email: { equals: email, mode: 'insensitive' },
            deletedAt: null,
          },
        },
        select: { user: { select: { id: true, email: true, fullName: true } } },
      }),
    );
    if (!membership) return null;
    const { id, email: userEmail, fullName } = membership.user;
    return { userId: id, email: userEmail, fullName };
  }

  async activeMembershipRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null> {
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: { tenantId, userId, deletedAt: null, user: { deletedAt: null } },
        select: { role: true },
      }),
    );
    return membership?.role ?? null;
  }

  async issue(input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
    userDailyLimit: number;
    enqueue?: (tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<void> {
    try {
      // DX-149-ter: la transacción de la clínica del host (RLS del outbox):
      // token y email confirman o se deshacen juntos. `users`/`user_tokens`
      // son globales y se escriben igual que antes.
      await this.prisma.runWithTenant(input.tenantId, async (tx) => {
        // Primero el tope de espera (SET LOCAL parametrizado): cubre la fila
        // del usuario y el candado del email.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${this.lockTimeoutMs}ms`}, true)`;
        // Orden: fila del usuario, tokens, y el email AL FINAL (sus candados
        // consultivos son lo último que se toma: ningún ciclo con nadie).
        await lockUser(tx, input.userId);
        // DX-149-quater: el tope POR USUARIO, sumando todas sus clínicas
        // (`user_tokens` es global). Contado DESPUÉS de tomar su fila: una
        // sentencia nueva (READ COMMITTED) que ya ve lo que confirmó quien la
        // tenía. Alcanzado, no se rota nada ni se encola nada.
        const issuedToday = await tx.userToken.count({
          where: {
            userId: input.userId,
            purpose: PURPOSE,
            createdAt: { gt: new Date(input.now.getTime() - DAY_MS) },
          },
        });
        if (issuedToday >= input.userDailyLimit) {
          throw new PasswordResetThrottledError('USER_QUOTA');
        }
        await tx.userToken.updateMany({
          where: {
            userId: input.userId,
            purpose: PURPOSE,
            invalidatedAt: null,
          },
          data: { invalidatedAt: input.now },
        });
        await tx.userToken.create({
          data: {
            userId: input.userId,
            purpose: PURPOSE,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            createdAt: input.now,
          },
          select: { id: true },
        });
        await input.enqueue?.(tx);
      });
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new PasswordResetThrottledError('LOCK_TIMEOUT');
      }
      throw err;
    }
  }

  countIssuedSince(userId: string, since: Date): Promise<number> {
    return this.prisma.userToken.count({
      where: { userId, purpose: PURPOSE, createdAt: { gt: since } },
    });
  }

  findByHash(tokenHash: string): Promise<ResetTokenRecord | null> {
    return this.prisma.userToken.findFirst({
      where: { tokenHash, purpose: PURPOSE },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        invalidatedAt: true,
      },
    });
  }

  async consumeAndSetPassword(input: {
    tokenId: string;
    userId: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    try {
      return await this.consumeInTx(input);
    } catch (err) {
      if (err instanceof UserGoneError) return false;
      throw err;
    }
  }

  private consumeInTx(input: {
    tokenId: string;
    userId: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockUser(tx, input.userId);
      // Check-and-set: dos peticiones con el mismo token → solo una cuenta 1.
      const consumed = await tx.userToken.updateMany({
        where: {
          id: input.tokenId,
          userId: input.userId,
          purpose: PURPOSE,
          usedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: input.now },
        },
        data: { usedAt: input.now, invalidatedAt: input.now },
      });
      if (consumed.count !== 1) return false;
      await tx.userToken.updateMany({
        where: { userId: input.userId, purpose: PURPOSE, invalidatedAt: null },
        data: { invalidatedAt: input.now },
      });
      const updated = await tx.user.updateMany({
        where: { id: input.userId, deletedAt: null },
        data: {
          passwordHash: input.passwordHash,
          tokenVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        // Usuario retirado entre la lectura y el uso: se deshace todo (el
        // token sigue como estaba) y cuenta como enlace no válido.
        throw new UserGoneError();
      }
      return true;
    });
  }
}
