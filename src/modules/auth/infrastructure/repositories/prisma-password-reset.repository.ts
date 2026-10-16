import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma, UserTokenPurpose } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PasswordResetRepository,
  ResetRecipient,
  ResetTokenRecord,
} from '../../domain/ports/password-reset-repository.port';

const PURPOSE = UserTokenPurpose.PASSWORD_RESET;

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
  constructor(private readonly prisma: PrismaService) {}

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
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockUser(tx, input.userId);
      await tx.userToken.updateMany({
        where: { userId: input.userId, purpose: PURPOSE, invalidatedAt: null },
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
