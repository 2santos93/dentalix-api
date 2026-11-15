import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { PatientMergeRepository } from '../domain/patient-merge-repository.port';
import {
  DismissDuplicatePairUseCase,
  ListDuplicatePatientsUseCase,
  MergePatientsUseCase,
  PreviewPatientMergeUseCase,
} from './patient-merge.use-cases';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-15T12:00:00.000Z');
const ctx = { tenantId: 't' } as AuditRequestContext;

function repo() {
  const fns = {
    listDuplicates: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    dismiss: jest.fn().mockResolvedValue(true),
    preview: jest.fn().mockResolvedValue(null),
    merge: jest.fn().mockResolvedValue({ patientId: A }),
  };
  return { ...fns, port: fns as unknown as PatientMergeRepository };
}

describe('casos de uso de la fusión (DX-266)', () => {
  it('la lista pagina y recorta el tamaño de página al tope', async () => {
    const r = repo();
    const page = await new ListDuplicatePatientsUseCase(r.port).execute({
      page: 3,
      pageSize: 500,
    });
    expect(r.listDuplicates).toHaveBeenCalledWith({
      locationId: undefined,
      skip: 100,
      take: 50,
    });
    expect(page).toMatchObject({ page: 3, pageSize: 50 });
  });

  it('«No es duplicado» guarda la pareja ordenada (A < B) y da 404 si alguno no está', async () => {
    const r = repo();
    await new DismissDuplicatePairUseCase(r.port).execute(
      [B, A.toUpperCase()],
      ctx,
    );
    expect(r.dismiss).toHaveBeenCalledWith([A, B], ctx);
    r.dismiss.mockResolvedValue(false);
    await expect(
      new DismissDuplicatePairUseCase(r.port).execute([A, B], ctx),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el mismo paciente dos veces es un 400, sin tocar la BD', async () => {
    const r = repo();
    await expect(
      new DismissDuplicatePairUseCase(r.port).execute([A, A], ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      new PreviewPatientMergeUseCase(r.port, () => NOW).execute(
        A,
        A.toUpperCase(),
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      new MergePatientsUseCase(r.port, () => NOW).execute(
        { keptId: A, absorbedId: A, choices: {} },
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(r.dismiss).not.toHaveBeenCalled();
    expect(r.merge).not.toHaveBeenCalled();
  });

  it('vista previa sin pacientes → 404; fusión con la hora del reloj y las elecciones', async () => {
    const r = repo();
    await expect(
      new PreviewPatientMergeUseCase(r.port, () => NOW).execute(A, B, ctx),
    ).rejects.toBeInstanceOf(NotFoundException);
    await new MergePatientsUseCase(r.port, () => NOW).execute(
      { keptId: A, absorbedId: B, choices: { email: 'ABSORBED' } },
      ctx,
    );
    expect(r.merge).toHaveBeenCalledWith(
      { keptId: A, absorbedId: B, choices: { email: 'ABSORBED' } },
      NOW,
      ctx,
    );
  });
});
