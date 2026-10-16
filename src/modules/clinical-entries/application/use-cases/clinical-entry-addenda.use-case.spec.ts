import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import {
  CLINICAL_ENTRY_NOT_FOUND_MESSAGE,
  CreateClinicalEntryAddendumUseCase,
} from './create-clinical-entry-addendum.use-case';
import { ListClinicalEntryAddendaUseCase } from './list-clinical-entry-addenda.use-case';
import { ClinicalEntryAddendum } from '../../domain/entities/clinical-entry-addendum.entity';
import {
  ClinicalEntryAddendumRepository,
  CreateClinicalEntryAddendumRepoInput,
} from '../../domain/ports/clinical-entry-addendum-repository.port';

/**
 * Fake con estado y SIN método de edición/borrado (append-only en la
 * interfaz). `entries` simula qué evolución es de qué paciente bajo RLS.
 */
class InMemoryAddendumRepository implements ClinicalEntryAddendumRepository {
  readonly rows: ClinicalEntryAddendum[] = [];
  private seq = 0;

  constructor(private readonly entries: Record<string, string>) {}

  entryExists(patientId: string, entryId: string): Promise<boolean> {
    return Promise.resolve(this.entries[entryId] === patientId);
  }

  create(
    input: CreateClinicalEntryAddendumRepoInput,
  ): Promise<ClinicalEntryAddendum> {
    this.seq += 1;
    const row: ClinicalEntryAddendum = {
      id: `ad-${this.seq}`,
      tenantId: 't1',
      ...input,
      createdAt: new Date(Date.UTC(2026, 9, 16, 12, this.seq)),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listByEntry(
    patientId: string,
    entryId: string,
  ): Promise<ClinicalEntryAddendum[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) => r.patientId === patientId && r.clinicalEntryId === entryId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }
}

const REASON = 'Dato de la pieza dental mal transcrito';

function setUp() {
  const repo = new InMemoryAddendumRepository({ e1: 'p1', e2: 'p2' });
  const create = new CreateClinicalEntryAddendumUseCase(
    repo,
    patientsInClinic('p1', 'p2'),
  );
  const list = new ListClinicalEntryAddendaUseCase(
    repo,
    patientsInClinic('p1', 'p2'),
  );
  return { repo, create, list };
}

describe('CreateClinicalEntryAddendumUseCase (DX-038)', () => {
  it('añade la adenda con el autor del JWT, el texto y el motivo recortados', async () => {
    const { repo, create } = setUp();
    const out = await create.execute(
      'p1',
      'e1',
      { reason: `  ${REASON}  `, text: '  Es la 36, no la 46.  ' },
      'user-1',
    );
    expect(out).toMatchObject({
      patientId: 'p1',
      clinicalEntryId: 'e1',
      reason: REASON,
      text: 'Es la 36, no la 46.',
      authorId: 'user-1',
    });
    expect(repo.rows).toHaveLength(1);
  });

  it('descarta campos colados en el input (autor, fecha, tenant)', async () => {
    const { repo, create } = setUp();
    const sneaky = {
      reason: REASON,
      text: 'Corrección',
      authorId: 'otro',
      createdAt: new Date(0),
      tenantId: 't-otro',
    } as unknown as { reason: string; text: string };
    await create.execute('p1', 'e1', sneaky, 'user-1');
    expect(repo.rows[0].authorId).toBe('user-1');
    expect(repo.rows[0].tenantId).toBe('t1');
    expect(repo.rows[0].createdAt.getTime()).not.toBe(0);
  });

  it('sin usuario autenticado → 403 (la autoría es obligatoria)', async () => {
    const { repo, create } = setUp();
    await expect(
      create.execute('p1', 'e1', { reason: REASON, text: 'x' }, ''),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.rows).toHaveLength(0);
  });

  it.each([
    ['motivo corto', { reason: '   corto   ', text: 'Texto' }],
    ['texto en blanco', { reason: REASON, text: '    ' }],
  ])('%s → 400', async (_label, input) => {
    const { repo, create } = setUp();
    await expect(
      create.execute('p1', 'e1', input, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.rows).toHaveLength(0);
  });

  it('paciente de otra clínica → 404', async () => {
    const { create } = setUp();
    await expect(
      create.execute('p-ajeno', 'e1', { reason: REASON, text: 'x' }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('evolución de otro paciente (IDOR) → 404 con mensaje en español', async () => {
    const { repo, create } = setUp();
    await expect(
      create.execute('p1', 'e2', { reason: REASON, text: 'x' }, 'user-1'),
    ).rejects.toThrow(CLINICAL_ENTRY_NOT_FOUND_MESSAGE);
    expect(repo.rows).toHaveLength(0);
  });
});

describe('ListClinicalEntryAddendaUseCase (DX-038)', () => {
  it('lista en orden cronológico las adendas de la evolución', async () => {
    const { create, list } = setUp();
    await create.execute('p1', 'e1', { reason: REASON, text: 'primera' }, 'u');
    await create.execute('p1', 'e1', { reason: REASON, text: 'segunda' }, 'u');
    const out = await list.execute('p1', 'e1');
    expect(out.map((a) => a.text)).toEqual(['primera', 'segunda']);
  });

  it('evolución de otro paciente → 404', async () => {
    const { list } = setUp();
    await expect(list.execute('p1', 'e2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
