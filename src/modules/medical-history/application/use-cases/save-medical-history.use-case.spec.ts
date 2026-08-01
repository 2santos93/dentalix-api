import { SaveMedicalHistoryUseCase } from './save-medical-history.use-case';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';
import {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';
import { deriveSafetyFlags } from '../../domain/safety-flags';

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
    const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags(data);
    const row: MedicalHistory = {
      id: `mh-${this.nextId++}`,
      tenantId: 't1',
      patientId,
      version,
      allergies: data.allergies ?? [],
      conditions: data.conditions ?? [],
      medications: data.medications ?? [],
      habits: data.habits ?? null,
      dentalHistory: data.dentalHistory ?? null,
      surgeries: data.surgeries ?? [],
      vitalSigns: data.vitalSigns ?? null,
      familyHistory: data.familyHistory ?? null,
      notes: data.notes ?? null,
      safetyFlags,
      hasCriticalAlert,
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

    const result = await uc.execute('p1', { notes: 'Penicilina' }, 'user-1');

    expect(result.version).toBe(1);
    expect(result.patientId).toBe('p1');
    expect(result.notes).toBe('Penicilina');
    expect(result.createdById).toBe('user-1');
  });

  it('creates version+1 on a second save while the FIRST version remains retrievable in the store (append-only, never updates)', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo);

    const v1 = await uc.execute('p1', { notes: 'Penicilina' }, 'user-1');
    const v2 = await uc.execute('p1', { notes: 'Ninguna' }, 'user-1');

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    // The crux of append-only: BOTH rows must exist in the fake's storage —
    // saving v2 must not have updated/removed the v1 row.
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0]).toMatchObject({
      version: 1,
      notes: 'Penicilina',
    });
    expect(repo.rows[1]).toMatchObject({ version: 2, notes: 'Ninguna' });

    // The v1 object returned earlier must also be untouched (no shared
    // mutable reference to the "current" row).
    expect(v1.notes).toBe('Penicilina');
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

  it('persiste listas estructuradas y deriva las banderas', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo);

    const result = await uc.execute(
      'p1',
      {
        allergies: [
          {
            alergeno: 'Penicilina',
            tipo: 'MEDICAMENTO',
            severidad: 'MODERADA',
            esAlerta: true,
          },
        ],
        medications: [{ nombre: 'Warfarina', esAlerta: false }],
        conditions: [
          {
            codigo: 'DIABETES',
            etiqueta: 'Diabetes',
            estado: 'SI',
            esAlerta: true,
          },
        ],
        embarazo: true,
        semanasEmbarazo: 20,
      },
      'user-1',
    );

    expect(result.version).toBe(1);
    expect(result.allergies).toHaveLength(1);
    expect(result.safetyFlags.alergiaPenicilina).toBe(true);
    expect(result.safetyFlags.anticoagulantes).toBe(true);
    expect(result.safetyFlags.diabetes).toBe(true);
    expect(result.safetyFlags.embarazo).toBe(true);
    expect(result.hasCriticalAlert).toBe(true);
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
      notes: 'Latex',
      tenantId: 'sneaky-tenant',
      version: 999,
      safetyFlags: { embarazo: true },
      hasCriticalAlert: true,
    } as unknown as Parameters<typeof uc.execute>[1];

    const result = await uc.execute('p1', maliciousInput, 'user-1');

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(captured && 'version' in captured).toBe(false);
    expect(captured && 'safetyFlags' in captured).toBe(false);
    expect(captured && 'hasCriticalAlert' in captured).toBe(false);
    expect(result.version).toBe(1); // computed by the repo, not the sneaked 999
    expect(result.tenantId).toBe('t1'); // comes from the repo/context, not input
    expect(result.hasCriticalAlert).toBe(false); // recalculated, not the sneaked true
  });
});
