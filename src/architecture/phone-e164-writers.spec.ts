import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-224 (I2): «¿Quién llama?» solo encuentra a quien tiene `phoneE164`, y un
 * escritor que cambie `phone` sin volver a escribirlo deja al paciente sin
 * aparecer (y a recepción creando un duplicado). El trigger
 * `dx_phone_e164_stale` garantiza que nunca queda uno OBSOLETO; esta guarda
 * garantiza que quien escribe el teléfono lo vuelve a rellenar.
 *
 * Recorre `src/` y lista TODOS los ficheros de producción que escriben en
 * `patients` o `patient_responsible_parties` (Prisma `.patient.create|update…`,
 * `.patientResponsibleParty.…`, o SQL `UPDATE|INSERT INTO`). Cada uno tiene que
 * estar aquí: o `reconciles` (importa `reconcile…PhoneE164`) o `exempt` con el
 * motivo por el que no toca `phone`. Un fichero nuevo que escriba pacientes sin
 * estar en la lista pone la suite en rojo.
 */
const SRC = join(__dirname, '..');

const WRITES =
  /\.(patient|patientResponsibleParty)\.(create|createMany|createManyAndReturn|update|updateMany|upsert)\s*\(|(UPDATE|INSERT INTO)\s+"(patients|patient_responsible_parties)"/;
const RECONCILES = /reconcile(Patient|Responsible)PhoneE164/;

type Writer = { kind: 'reconciles' } | { kind: 'exempt'; reason: string };

const WRITERS: Record<string, Writer> = {
  'modules/patients/infrastructure/repositories/prisma-patient.repository.ts': {
    kind: 'reconciles',
  },
  'modules/patients/infrastructure/repositories/prisma-patient-communication.repository.ts':
    { kind: 'reconciles' },
  'modules/patients/infrastructure/repositories/prisma-responsible-party.repository.ts':
    { kind: 'reconciles' },
  'modules/patient-imports/infrastructure/prisma-patient-import.repository.ts':
    { kind: 'reconciles' },
  'modules/patients/infrastructure/repositories/prisma-clinic-retention-settings.repository.ts':
    { kind: 'exempt', reason: 'solo retention_floor_until' },
  'modules/data-consents/infrastructure/record-consents-in-tx.ts': {
    kind: 'exempt',
    reason: 'solo el resumen de la autorización de datos',
  },
  'modules/reminders/infrastructure/prisma-reminder-opt-out.repository.ts': {
    kind: 'exempt',
    reason: 'solo la baja de recordatorios',
  },
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const isProduction = (file: string): boolean =>
  !file.endsWith('.spec.ts') && !file.split(sep).includes('__fixtures__');

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

describe('escritores de patients.phone (DX-224, I2)', () => {
  const writers = tsFiles(SRC)
    .filter(isProduction)
    .filter((file) => WRITES.test(readFileSync(file, 'utf8')))
    .map(rel)
    .sort();

  it('todo fichero que escribe pacientes o responsables está en la lista', () => {
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  it('los escritores del teléfono vuelven a rellenar phoneE164', () => {
    const missing = Object.entries(WRITERS)
      .filter(([, w]) => w.kind === 'reconciles')
      .map(([file]) => file)
      .filter((file) => {
        const text = readFileSync(join(SRC, file), 'utf8');
        return !RECONCILES.test(text);
      });
    expect(missing).toEqual([]);
  });

  it('los exentos dicen por qué', () => {
    for (const w of Object.values(WRITERS)) {
      if (w.kind === 'exempt') expect(w.reason.length).toBeGreaterThan(5);
    }
  });

  it('la autoprueba distingue un escritor de un lector', () => {
    expect(WRITES.test('await tx.patient.update({ where })')).toBe(true);
    expect(WRITES.test('tx.patientResponsibleParty.updateMany({')).toBe(true);
    expect(WRITES.test('UPDATE "patients" SET x')).toBe(true);
    expect(WRITES.test('await tx.patient.findMany({')).toBe(false);
  });
});
