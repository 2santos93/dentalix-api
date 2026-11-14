import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-019-bis (B): las recetas y las aceptaciones firmadas congelan la CLAVE
 * del logo de la clínica (`logos/<clínica>-<16 hex>.<ext>`), no sus bytes.
 * Reimprimirlas pinta ese objeto, así que un objeto `logos/` NUNCA se borra:
 * ni al cambiar o quitar el logo, ni en un barrido de huérfanos (que tendría
 * que consultar `tenants`, `prescriptions`, `treatment_plan_acceptances` y,
 * desde DX-019-ter, `patient_consents` y `post_op_instruction_deliveries`).
 *
 * El código de producción que borra o lista objetos del almacén
 * (`FileStoragePort.delete` / `listObjects`) está en una lista revisada:
 * ninguno toca `logos/`. Un llamador nuevo hace fallar este test; antes de
 * añadirlo, comprueba que su clave no puede ser nunca la de un logo. Y ningún
 * fichero que borre o liste puede mencionar `logos`.
 */
const SRC = join(__dirname, '..');

/** Llamadores revisados: ninguno arma ni recibe una clave `logos/`. */
const REVIEWED_CALLERS = [
  // Justificantes de pago pendientes (`payment-proofs/pending/`).
  'modules/payments/application/payment-proof-sweep.ts',
  'modules/payments/application/payment-proof-uploads.ts',
  // PDF firmado del consentimiento que no llegó a guardarse en la BD.
  'modules/consents/application/signed-consent-pdf.service.ts',
  // Soporte del gasto subido y no confirmado.
  'modules/expenses/application/expense-receipt-uploads.ts',
  // Avatar del usuario (`avatars/<userId>.<ext>`).
  'modules/me/application/use-cases/remove-my-avatar.use-case.ts',
  'modules/me/application/use-cases/set-my-avatar.use-case.ts',
  // Documento del paciente cuya fila no se llegó a crear.
  'modules/patient-documents/application/use-cases/patient-documents.use-cases.ts',
];

/** Los adaptadores implementan el puerto; no deciden qué se borra. */
const ADAPTERS = [
  'shared/storage/disk-file-storage.ts',
  'shared/storage/s3-file-storage.ts',
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const production = tsFiles(SRC)
  .filter(
    (file) =>
      !file.endsWith('.spec.ts') && !file.split(sep).includes('__fixtures__'),
  )
  .map((file) => ({
    path: relative(SRC, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

/** Usa el almacén (lo inyecta o lo recibe por su puerto). */
const USES_STORAGE = /\bFILE_STORAGE\b|\bFileStoragePort\b/;
/** Borra o lista objetos: `.delete(` o `.listObjects(` (aunque Prettier lo parta). */
const DELETES_OR_LISTS =
  /\.\s*(?:delete|listObjects)\s*\(|DeleteObjects?Command/;

describe('los logos de la clínica nunca se borran (DX-019-bis B)', () => {
  const deleters = production
    .filter(
      ({ path, text }) =>
        !ADAPTERS.includes(path) &&
        USES_STORAGE.test(text) &&
        DELETES_OR_LISTS.test(text),
    )
    .map(({ path }) => path)
    .sort();

  it('solo los llamadores revisados borran o listan objetos del almacén', () => {
    expect(deleters).toEqual([...REVIEWED_CALLERS].sort());
  });

  it('ningún fichero que borre o liste objetos menciona `logos`', () => {
    const offenders = production
      .filter(
        ({ text }) =>
          (DELETES_OR_LISTS.test(text) || /\bfs\.(?:rm|unlink)\b/.test(text)) &&
          /logos/i.test(text),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('el módulo del logo (Ajustes de la clínica) no borra del almacén', () => {
    const settings = production.filter(({ path }) =>
      path.startsWith('modules/clinic-settings/'),
    );
    expect(settings.length).toBeGreaterThan(0);
    expect(
      settings
        .filter(({ text }) => DELETES_OR_LISTS.test(text))
        .map(({ path }) => path),
    ).toEqual([]);
  });
});
