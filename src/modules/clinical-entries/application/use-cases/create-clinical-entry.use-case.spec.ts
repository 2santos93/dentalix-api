import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { CreateClinicalEntryUseCase } from './create-clinical-entry.use-case';
import { CreateClinicalEntryRepoInput } from '../../domain/ports/clinical-entry-repository.port';
import { InMemoryClinicalEntryRepository } from '../__fixtures__/in-memory-clinical-entries';
import { InMemoryClinicalNoteTemplateRepository } from '../../../clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';

/** Alta con la clínica de los tests: paciente p1 y sin plantillas. */
function useCase(repo: InMemoryClinicalEntryRepository) {
  return new CreateClinicalEntryUseCase(
    repo,
    patientsInClinic('p1'),
    new InMemoryClinicalNoteTemplateRepository(),
    new TenantContextService(),
  );
}

describe('CreateClinicalEntryUseCase', () => {
  it('appends a new entry and returns it', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    const result = await uc.execute(
      'p1',
      { notes: 'Control de rutina, sin novedad' },
      'user-1',
    );

    expect(result.patientId).toBe('p1');
    expect(result.notes).toBe('Control de rutina, sin novedad');
    expect(result.performedById).toBe('user-1');
    expect(repo.rows).toHaveLength(1);
  });

  it('defaults entryDate to now when not provided', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);
    const before = new Date();

    const result = await uc.execute('p1', { notes: 'Nota' }, 'user-1');

    const after = new Date();
    expect(result.entryDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.entryDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('uses the provided entryDate when given', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);
    const explicitDate = new Date('2025-01-15T10:00:00.000Z');

    const result = await uc.execute(
      'p1',
      { notes: 'Nota con fecha', entryDate: explicitDate },
      'user-1',
    );

    expect(result.entryDate).toEqual(explicitDate);
  });

  it('rejects blank notes (notes is required content, not just a required field)', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    await expect(
      uc.execute('p1', { notes: '   ' }, 'user-1'),
    ).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
  });

  it('never forwards a tenantId sneaked into the input to the repository (tenant comes from context, not input)', async () => {
    let captured: CreateClinicalEntryRepoInput | undefined;
    const repo = new InMemoryClinicalEntryRepository();
    const originalCreate = repo.create.bind(repo);
    repo.create = (input) => {
      captured = input;
      return originalCreate(input);
    };
    const uc = useCase(repo);

    const maliciousInput = {
      notes: 'Nota',
      tenantId: 'sneaky-tenant',
    } as unknown as Parameters<typeof uc.execute>[1];

    await uc.execute('p1', maliciousInput, 'user-1');

    expect(captured && 'tenantId' in captured).toBe(false);
  });

  it('forwards performedById from the explicit argument, not from the input payload', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    const result = await uc.execute('p1', { notes: 'Nota' }, 'user-77');

    expect(result.performedById).toBe('user-77');
  });

  it('DX-038: sin profesional autenticado → 403, sin insertar (autoría obligatoria)', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    await expect(
      uc.execute('p1', { notes: 'Nota' }, ''),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.rows).toHaveLength(0);
  });
});

describe('CreateClinicalEntryUseCase — pertenencia del paciente (SEC-004)', () => {
  it('rechaza con 404 "Paciente no encontrado" un paciente que no es de la clínica, sin insertar', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    await expect(
      uc.execute('p-otra-clinica', { notes: 'Nota' }, 'user-1'),
    ).rejects.toThrow(new NotFoundException('Paciente no encontrado'));
    expect(repo.rows).toHaveLength(0);
  });
});
