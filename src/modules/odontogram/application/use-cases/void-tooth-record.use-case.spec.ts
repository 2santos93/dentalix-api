import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CatalogKind, ClinicRole, ToothRecordOrigin } from '@prisma/client';
import { VoidToothRecordUseCase } from './void-tooth-record.use-case';
import { InMemoryToothRecordRepository } from '../__fixtures__/in-memory-odontogram';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';

const AUTHOR = { userId: 'u-autor', role: ClinicRole.DENTIST };
const ADMIN = { userId: 'u-admin', role: ClinicRole.ADMIN };
const OTHER = { userId: 'u-otro', role: ClinicRole.DENTIST };
const REASON = 'Registrado en el diente equivocado';

async function setup() {
  const repo = new InMemoryToothRecordRepository(
    () => new Date('2026-10-16T15:00:00.000Z'),
  );
  const target = await repo.create({
    patientId: 'p1',
    toothNumber: '64',
    surfaces: ['OCCLUSAL'],
    kind: CatalogKind.DIAGNOSIS,
    origin: ToothRecordOrigin.OTHER_PROVIDER,
    notes: 'Caries',
    performedById: AUTHOR.userId,
    recordedAt: new Date('2026-10-01T10:00:00.000Z'),
  });
  const uc = new VoidToothRecordUseCase(repo, patientsInClinic('p1'));
  return { repo, target, uc };
}

describe('VoidToothRecordUseCase (DX-120)', () => {
  it('el autor anula con motivo: inserta una fila nueva y no toca el original', async () => {
    const { repo, target, uc } = await setup();
    const before = { ...target };

    const created = await uc.execute('p1', target.id, `  ${REASON}  `, AUTHOR);

    expect(created).toMatchObject({
      voidsRecordId: target.id,
      voidReason: REASON,
      performedById: AUTHOR.userId,
      toothNumber: '64',
      origin: ToothRecordOrigin.OTHER_PROVIDER,
    });
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0]).toEqual(before);
  });

  it('un ADMIN puede anular el registro de otro', async () => {
    const { target, uc } = await setup();
    const created = await uc.execute('p1', target.id, REASON, ADMIN);
    expect(created.performedById).toBe(ADMIN.userId);
  });

  it('400 sin motivo (vacío o solo espacios)', async () => {
    const { repo, target, uc } = await setup();
    await expect(uc.execute('p1', target.id, '   ', AUTHOR)).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.rows).toHaveLength(1);
  });

  it('403 si no es el autor ni ADMIN', async () => {
    const { repo, target, uc } = await setup();
    await expect(uc.execute('p1', target.id, REASON, OTHER)).rejects.toThrow(
      ForbiddenException,
    );
    expect(repo.rows).toHaveLength(1);
  });

  it('409 en la segunda anulación del mismo registro', async () => {
    const { repo, target, uc } = await setup();
    await uc.execute('p1', target.id, REASON, AUTHOR);
    await expect(uc.execute('p1', target.id, REASON, ADMIN)).rejects.toThrow(
      ConflictException,
    );
    expect(repo.rows).toHaveLength(2);
  });

  it('422 al intentar anular una anulación', async () => {
    const { target, uc } = await setup();
    const voidRow = await uc.execute('p1', target.id, REASON, AUTHOR);
    await expect(uc.execute('p1', voidRow.id, REASON, ADMIN)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('404 si el registro no es de ese paciente o el paciente no es de la clínica', async () => {
    const { target, uc } = await setup();
    await expect(uc.execute('p1', 'no-existe', REASON, ADMIN)).rejects.toThrow(
      NotFoundException,
    );
    await expect(uc.execute('p2', target.id, REASON, ADMIN)).rejects.toThrow(
      NotFoundException,
    );
  });
});
