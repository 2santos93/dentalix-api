import { DocType, Sex } from '@prisma/client';

/**
 * API-facing shape of a Patient. Deliberately NOT the raw Prisma model:
 * repositories must `mapToEntity` before returning across the port boundary
 * (see auth module's PrismaAuthRepository for the same convention).
 */
export interface Patient {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  docType: DocType;
  docNumber: string | null;
  birthDate: Date | null;
  sex: Sex;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
