import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PendingRegistrationRecord,
  RegistrationRepository,
} from '../../domain/ports/registration-repository.port';

const SELECT = {
  id: true,
  email: true,
  clinicName: true,
  subdomain: true,
  fullName: true,
  passwordHash: true,
  expiresAt: true,
} as const;

/**
 * `pending_registrations` es tabla global (aún no hay clínica): sin
 * `runWithTenant`, igual que `users`.
 */
@Injectable()
export class PrismaRegistrationRepository implements RegistrationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async savePending(
    input: Omit<PendingRegistrationRecord, 'id'> & { tokenHash: string },
  ): Promise<void> {
    const data = {
      clinicName: input.clinicName,
      subdomain: input.subdomain,
      fullName: input.fullName,
      passwordHash: input.passwordHash,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
    await this.prisma.pendingRegistration.upsert({
      where: { email: input.email },
      create: { email: input.email, ...data },
      update: data,
    });
  }

  findPendingByTokenHash(
    tokenHash: string,
  ): Promise<PendingRegistrationRecord | null> {
    return this.prisma.pendingRegistration.findUnique({
      where: { tokenHash },
      select: SELECT,
    });
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
}
