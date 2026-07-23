import { SaveMedicalHistoryUseCase } from './save-medical-history.use-case';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';
import {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';

/**
 * A REAL (stateful) in-memory fake — not just a jest-mock object — because
 * the behavior under test IS the version-computation contract itself
 * (`version = latest+1`, append-only, prior rows untouched). `rows` is
 * exposed so tests can assert directly on what got persisted, the same way
 * an e2e test would assert against the real table.
 */
class InMemoryMedicalHistoryRepository implements MedicalHistoryRepository {
  readonly rows: MedicalHistory[] = [];
  private nextId = 1;

  getLatest(patientId: string): Promise<MedicalHistory | null> {
    const versions = this.rows
      .filter((r) => r.patientId === patientId)
      .sort((a, b) => b.version - a.version);
    return Promise.resolve(versions[0] ?? null);
  }

  async createVersion(
    patientId: string,
    data: MedicalHistoryVersionData,
    createdById?: string,
  ): Promise<MedicalHistory> {
    const latest = await this.getLatest(patientId);
    const version = (latest?.version ?? 0) + 1;
    const row: MedicalHistory = {
      id: `mh-${this.nextId++}`,
      tenantId: 't1',
      patientId,
      version,
      allergies: data.allergies ?? null,
      chronicConditions: data.chronicConditions ?? null,
      currentMedications: data.currentMedications ?? null,
      habits: data.habits ?? null,
      medicalAlerts: data.medicalAlerts ?? null,
      notes: data.notes ?? null,
      createdById: createdById ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    // Append-only: push a NEW row, never mutate/replace an existing one.
    this.rows.push(row);
    return row;
  }
}

describe('SaveMedicalHistoryUseCase', () => {
  it('creates version 1 for the first save of a patient', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo);

    const result = await uc.execute(
      'p1',
      { allergies: 'Penicilina' },
      'user-1',
    );

    expect(result.version).toBe(1);
    expect(result.patientId).toBe('p1');
    expect(result.allergies).toBe('Penicilina');
    expect(result.createdById).toBe('user-1');
  });

  it('creates version+1 on a second save while the FIRST version remains retrievable in the store (append-only, never updates)', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo);

    const v1 = await uc.execute('p1', { allergies: 'Penicilina' }, 'user-1');
    const v2 = await uc.execute('p1', { allergies: 'Ninguna' }, 'user-1');

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    // The crux of append-only: BOTH rows must exist in the fake's storage —
    // saving v2 must not have updated/removed the v1 row.
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0]).toMatchObject({
      version: 1,
      allergies: 'Penicilina',
    });
    expect(repo.rows[1]).toMatchObject({ version: 2, allergies: 'Ninguna' });

    // The v1 object returned earlier must also be untouched (no shared
    // mutable reference to the "current" row).
    expect(v1.allergies).toBe('Penicilina');
    expect(v1.version).toBe(1);
  });

  it('computes the next version independently per patient', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo);

    await uc.execute('p1', { notes: 'p1 v1' }, 'user-1');
    const p2v1 = await uc.execute('p2', { notes: 'p2 v1' }, 'user-1');

    expect(p2v1.version).toBe(1);
    expect(repo.rows).toHaveLength(2);
  });

  it('forwards createdById and all optional fields through untouched', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo);

    const result = await uc.execute(
      'p1',
      {
        allergies: 'Latex',
        chronicConditions: 'Diabetes',
        currentMedications: 'Metformina',
        habits: 'Fumador',
        medicalAlerts: 'Anticoagulantes',
        notes: 'Paciente colaborador',
      },
      'user-9',
    );

    expect(result).toMatchObject({
      allergies: 'Latex',
      chronicConditions: 'Diabetes',
      currentMedications: 'Metformina',
      habits: 'Fumador',
      medicalAlerts: 'Anticoagulantes',
      notes: 'Paciente colaborador',
      createdById: 'user-9',
    });
  });

  it('never forwards a tenantId/version sneaked into the input to the repository (tenant/version come from context/computation, not input)', async () => {
    let captured: MedicalHistoryVersionData | undefined;
    const repo = new InMemoryMedicalHistoryRepository();
    const originalCreateVersion = repo.createVersion.bind(repo);
    repo.createVersion = (patientId, data, createdById) => {
      captured = data;
      return originalCreateVersion(patientId, data, createdById);
    };
    const uc = new SaveMedicalHistoryUseCase(repo);

    const maliciousInput = {
      allergies: 'Latex',
      tenantId: 'sneaky-tenant',
      version: 999,
    } as unknown as Parameters<typeof uc.execute>[1];

    const result = await uc.execute('p1', maliciousInput, 'user-1');

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(captured && 'version' in captured).toBe(false);
    expect(result.version).toBe(1); // computed by the repo, not the sneaked 999
    expect(result.tenantId).toBe('t1'); // comes from the repo/context, not input
  });
});
