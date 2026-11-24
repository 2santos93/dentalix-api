import { NotFoundException } from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
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
  /** DX-574: Idempotency-Key → id de la versión y huella. */
  readonly keys = new Map<string, { id: string; fingerprint: string }>();
  private nextId = 1;

  findByIdempotencyKey(
    key: string,
  ): Promise<{ fingerprint: string | null; value: MedicalHistory } | null> {
    const stored = this.keys.get(key);
    const row = stored && this.rows.find((r) => r.id === stored.id);
    return Promise.resolve(
      row && stored ? { fingerprint: stored.fingerprint, value: row } : null,
    );
  }

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
    idempotency?: { key: string; fingerprint: string },
    onPrevious?: (previous: MedicalHistory | null) => void,
  ): Promise<MedicalHistory> {
    if (idempotency && this.keys.has(idempotency.key)) {
      throw new Error('P2002 medical_history_versions_tenant_idempotency_key');
    }
    const latest = await this.getLatest(patientId);
    onPrevious?.(latest);
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
      pregnancy: data.pregnancy ?? null,
      dentalHistory: data.dentalHistory ?? null,
      surgeries: data.surgeries ?? [],
      vitalSigns: data.vitalSigns ?? null,
      familyHistory: data.familyHistory ?? null,
      notes: data.notes ?? null,
      safetyFlags,
      hasCriticalAlert,
      source: 'STAFF',
      createdById: createdById ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    // Append-only: push a NEW row, never mutate/replace an existing one.
    this.rows.push(row);
    if (idempotency) {
      this.keys.set(idempotency.key, {
        id: row.id,
        fingerprint: idempotency.fingerprint,
      });
    }
    return row;
  }
}

describe('SaveMedicalHistoryUseCase', () => {
  it('creates version 1 for the first save of a patient', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(
      repo,
      patientsInClinic('p1', 'p2'),
    );

    const result = await uc.execute('p1', { notes: 'Penicilina' }, 'user-1');

    expect(result.version).toBe(1);
    expect(result.patientId).toBe('p1');
    expect(result.notes).toBe('Penicilina');
    expect(result.createdById).toBe('user-1');
  });

  it('creates version+1 on a second save while the FIRST version remains retrievable in the store (append-only, never updates)', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(
      repo,
      patientsInClinic('p1', 'p2'),
    );

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

  describe('changedFields exactos (DX-095)', () => {
    const alergia = {
      alergeno: 'Penicilina',
      tipo: 'MEDICAMENTO' as const,
      severidad: 'ANAFILAXIA' as const,
      esAlerta: true,
    };

    it('la primera versión: los campos enviados con algo', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      const audit: { changedFields?: string[] } = {};
      await uc.execute(
        'p1',
        { allergies: [alergia], medications: [], notes: 'Control' },
        'user-1',
        undefined,
        audit,
      );
      expect(audit.changedFields).toEqual(['allergies', 'notes']);
    });

    it('el formulario entero con un solo campo distinto deja solo ese campo', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      const form = {
        allergies: [alergia],
        medications: [],
        pregnancy: 'NO' as const,
        notes: 'Control',
      };
      await uc.execute('p1', form, 'user-1');
      const audit: { changedFields?: string[] } = {};
      await uc.execute(
        'p1',
        { ...form, notes: 'Control semestral' },
        'user-1',
        undefined,
        audit,
      );
      expect(audit.changedFields).toEqual(['notes']);
    });

    it('guardar lo mismo: ningún campo cambió', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      const form = { allergies: [alergia], notes: 'Control' };
      await uc.execute('p1', form, 'user-1');
      const audit: { changedFields?: string[] } = {};
      await uc.execute('p1', form, 'user-1', undefined, audit);
      expect(audit.changedFields).toEqual([]);
    });

    it('`embarazo` (cliente anterior) cuenta como `pregnancy`; las semanas se comparan con las guardadas', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      await uc.execute('p1', { pregnancy: 'SI', semanasEmbarazo: 12 }, 'u');
      const same: { changedFields?: string[] } = {};
      await uc.execute(
        'p1',
        { embarazo: true, semanasEmbarazo: 12 },
        'u',
        undefined,
        same,
      );
      expect(same.changedFields).toEqual([]);
      const weeks: { changedFields?: string[] } = {};
      await uc.execute(
        'p1',
        { pregnancy: 'SI', semanasEmbarazo: 13 },
        'u',
        undefined,
        weeks,
      );
      expect(weeks.changedFields).toEqual(['semanasEmbarazo']);
    });
  });

  it('computes the next version independently per patient', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(
      repo,
      patientsInClinic('p1', 'p2'),
    );

    await uc.execute('p1', { notes: 'p1 v1' }, 'user-1');
    const p2v1 = await uc.execute('p2', { notes: 'p2 v1' }, 'user-1');

    expect(p2v1.version).toBe(1);
    expect(repo.rows).toHaveLength(2);
  });

  it('persiste listas estructuradas y deriva las banderas', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(
      repo,
      patientsInClinic('p1', 'p2'),
    );

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

  it('embarazo y hábitos tri-estado: un «No» elegido se guarda como «No» (antes volvía «Sin responder») y no enciende la alerta', async () => {
    const uc = new SaveMedicalHistoryUseCase(
      new InMemoryMedicalHistoryRepository(),
      patientsInClinic('p1'),
    );

    const result = await uc.execute(
      'p1',
      {
        pregnancy: 'NO',
        semanasEmbarazo: 10,
        habits: { bruxismo: 'DESCONOCE', tabaquismo: { estado: 'NO' } },
      },
      'user-1',
    );

    expect(result.pregnancy).toBe('NO');
    expect(result.safetyFlags.embarazo).toBe(false);
    expect(result.safetyFlags.semanasEmbarazo).toBeUndefined();
    expect(result.hasCriticalAlert).toBe(false);
    expect(result.habits).toEqual({
      bruxismo: 'DESCONOCE',
      tabaquismo: { estado: 'NO' },
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
    const uc = new SaveMedicalHistoryUseCase(
      repo,
      patientsInClinic('p1', 'p2'),
    );

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

describe('SaveMedicalHistoryUseCase — pertenencia del paciente (SEC-004)', () => {
  it('rechaza con 404 "Paciente no encontrado" un paciente que no es de la clínica, sin crear versión', async () => {
    const repo = new InMemoryMedicalHistoryRepository();
    const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));

    await expect(
      uc.execute('p-otra-clinica', { notes: 'Penicilina' }, 'user-1'),
    ).rejects.toThrow(new NotFoundException('Paciente no encontrado'));
    expect(repo.rows).toHaveLength(0);
  });

  describe('Idempotency-Key (DX-574)', () => {
    const KEY = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';

    it('repetir el mismo guardado con la misma clave no crea otra versión', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      const data = { notes: 'Hipertensión controlada con losartán' };

      const first = await uc.execute('p1', data, 'u1', { idempotencyKey: KEY });
      const signals: { replayed?: boolean } = {};
      const again = await uc.execute('p1', { ...data }, 'u1', {
        idempotencyKey: KEY,
        signals,
      });

      expect(again.id).toBe(first.id);
      expect(again.version).toBe(1);
      expect(signals.replayed).toBe(true);
      expect(repo.rows).toHaveLength(1);
    });

    it('la misma clave con otras respuestas es un 422', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      await uc.execute('p1', { notes: 'A' }, 'u1', { idempotencyKey: KEY });

      await expect(
        uc.execute('p1', { notes: 'B' }, 'u1', { idempotencyKey: KEY }),
      ).rejects.toMatchObject({
        response: { code: 'IDEMPOTENCY_KEY_REUSED' },
      });
      expect(repo.rows).toHaveLength(1);
    });

    it('sin clave cada guardado sigue siendo una versión nueva', async () => {
      const repo = new InMemoryMedicalHistoryRepository();
      const uc = new SaveMedicalHistoryUseCase(repo, patientsInClinic('p1'));
      await uc.execute('p1', { notes: 'A' }, 'u1');
      await uc.execute('p1', { notes: 'A' }, 'u1');
      expect(repo.rows.map((r) => r.version)).toEqual([1, 2]);
    });
  });
});
