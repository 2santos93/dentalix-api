import { BadRequestException, ConflictException } from '@nestjs/common';
import { BatchLocationError } from '../infrastructure/prisma-patient-import.repository';
import type { PrismaPatientImportRepository } from '../infrastructure/prisma-patient-import.repository';
import type { JobQueue } from '../../jobs/application/job-queue.service';
import { PatientImportsService } from './patient-imports.use-cases';

function makeUseCases(batchLocation: () => Promise<unknown>) {
  return new PatientImportsService(
    { batchLocation } as unknown as PrismaPatientImportRepository,
    {} as JobQueue,
  );
}

describe('PatientImportsService.balanceTemplate', () => {
  it('uses the batch location currency in the example row', async () => {
    const uc = makeUseCases(() =>
      Promise.resolve({ id: 'l1', currency: 'JPY' }),
    );
    const csv = await uc.balanceTemplate();
    expect(csv).toContain('"JPY"');
    expect(csv).not.toContain('COP');
  });

  it('a location with NULL currency is 409 LOCATION_CURRENCY_REQUIRED', async () => {
    const uc = makeUseCases(() =>
      Promise.resolve({ id: 'l1', currency: null }),
    );
    const err = await uc.balanceTemplate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_CURRENCY_REQUIRED',
      locationId: 'l1',
    });
  });

  it('an unavailable batch location is a 400', async () => {
    const uc = makeUseCases(() => Promise.reject(new BatchLocationError()));
    await expect(uc.balanceTemplate()).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
