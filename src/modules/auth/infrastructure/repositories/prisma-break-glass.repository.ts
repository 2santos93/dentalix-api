import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  BreakGlassAccessInput,
  BreakGlassRepository,
  UserMfaRecord,
} from '../../domain/ports/break-glass-repository.port';

@Injectable()
export class PrismaBreakGlassRepository implements BreakGlassRepository {
  constructor(private readonly prisma: PrismaService) {}

  // `users` es global (sin RLS), como en PrismaAuthRepository.
  async findMfa(userId: string): Promise<UserMfaRecord | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { mfaTotpSecretEnc: true, mfaLastUsedStep: true },
    });
    if (!user) return null;
    return {
      secretEnc: user.mfaTotpSecretEnc,
      lastUsedStep: user.mfaLastUsedStep,
    };
  }

  async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        mfaEnabledAt: { not: null },
        OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }],
      },
      data: { mfaLastUsedStep: step },
    });
    return count === 1;
  }

  async recordAccess(input: BreakGlassAccessInput): Promise<void> {
    await this.prisma.runWithTenant(input.tenantId, (tx) =>
      tx.platformAccessAudit.create({ data: input, select: { id: true } }),
    );
  }
}
