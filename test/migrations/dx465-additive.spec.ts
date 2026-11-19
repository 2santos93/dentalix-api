import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-465: recall con intentos. Cinco migraciones: la DDL aditiva (estado del
// ciclo en patient_recalls con su CHECK NOT VALID, «Llamar luego» y el único
// «Agendó» por recall y cita en recall_contacts, teléfono por revisar en
// patients, ajustes por sede con RLS FORCE y sin DELETE, y
// dx_phone_e164_stale = la de DX-266 + la marca); el relleno por clínica sin
// DDL; el índice nuevo de la lista y la baja del viejo, CONCURRENTLY y solos;
// y los VALIDATE aparte. Sin CHECK de actor nuevo ni lista de la fusión.

const raw = (migration: string): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
    'utf8',
  );
const code = (migration: string): string =>
  raw(migration)
    .replace(/--[^\n]*/g, '')
    .trim();
const flat = (migration: string): string =>
  code(migration).replace(/\s+/g, ' ');

const DDL = '20270122140000_dx465_recall_attempts';
const BACKFILL = '20270122140100_dx465_recall_attempts_backfill';
const INDEX = '20270122140200_dx465_recall_due_attempts_idx';
const DROP = '20270122140300_dx465_recall_due_visit_idx_drop';
const VALIDATE = '20270122140400_dx465_validate';
const MAIN_PHONE_STALE = '20261226140000_dx266_patient_merge';

/** El cuerpo de una función de una migración (de CREATE … a `$function$;`). */
function functionBody(migration: string, name: string): string {
  const sql = raw(migration);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end + '$function$;'.length);
}

describe('DX-465: migraciones', () => {
  it.each([DDL, VALIDATE])(
    '%s fija lock_timeout antes de la primera sentencia',
    (m) => {
      expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    },
  );

  it('el relleno es solo DML por clínica (DO con COMMIT por clínica, la clínica en la sesión y lock_timeout)', () => {
    const sql = code(BACKFILL);
    expect(sql).toMatch(/^DO \$\$/);
    expect(sql).not.toMatch(/\b(ALTER|CREATE|DROP)\b/);
    expect(sql).toContain(
      "PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);",
    );
    expect(sql).toContain(
      "PERFORM pg_catalog.set_config('lock_timeout', '5s', true);",
    );
    expect(sql).toMatch(/COMMIT;\s+END LOOP;/);
  });

  it('el índice nuevo y la baja del viejo van solos y CONCURRENTLY; el nuevo lleva el ciclo en el INCLUDE con el mismo predicado', () => {
    expect(flat(INDEX)).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "patient_recalls_tenant_due_attempts_idx" ON "patient_recalls" ("tenantId", "dueAt") INCLUDE ("id", "patientId", "recallTypeId", "kind", "intervalMonths", "lastDoneAt", "disabledUntil", "locationId", "visitLocationId", "attemptCount", "lastAttemptAt", "callbackOn", "skipUntil", "cycleDueAt") WHERE "active";',
    );
    expect(flat(DROP)).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "patient_recalls_tenant_due_visit_idx";',
    );
  });

  it('los VALIDATE van en su propio fichero y cubren todo lo NOT VALID', () => {
    const notValid = [
      ...code(DDL).matchAll(/ADD CONSTRAINT "([a-z_]+)"[^;]*NOT VALID;/g),
    ].map((m) => m[1]);
    expect(notValid.sort()).toEqual(
      [
        'patient_recalls_attempt_count_check',
        'patients_phone_review_check',
        'recall_contacts_callback_check',
      ].sort(),
    );
    const validated = [
      ...code(VALIDATE).matchAll(/VALIDATE CONSTRAINT "([a-z_]+)"/g),
    ].map((m) => m[1]);
    expect(validated.sort()).toEqual(notValid.sort());
    expect(code(DDL)).not.toMatch(/VALIDATE/);
  });

  it('solo columnas nuevas NULL o con DEFAULT: nada que reescriba datos existentes', () => {
    const sql = flat(DDL);
    expect(sql).toContain(
      'ALTER TABLE "patient_recalls" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "lastAttemptAt" TIMESTAMP(3), ADD COLUMN "callbackOn" DATE, ADD COLUMN "skipUntil" DATE, ADD COLUMN "cycleDueAt" DATE;',
    );
    expect(sql).toContain(
      'ALTER TABLE "recall_contacts" ADD COLUMN "callbackOn" DATE;',
    );
    expect(sql).toContain(
      'ALTER TABLE "patients" ADD COLUMN "phoneReviewFlaggedAt" TIMESTAMP(3), ADD COLUMN "phoneReviewFlaggedById" UUID;',
    );
    expect(sql).not.toMatch(/DROP COLUMN|ALTER COLUMN|RENAME/);
    expect(sql).not.toMatch(/^(UPDATE|DELETE)\b/m);
  });

  it('un solo «Agendó» por recall y cita: índice único PARCIAL sobre BOOKED', () => {
    expect(flat(DDL)).toContain(
      `CREATE UNIQUE INDEX "recall_contacts_booked_appointment_key" ON "recall_contacts"("tenantId", "recallId", "appointmentId") WHERE "outcome" = 'BOOKED';`,
    );
  });

  it('location_recall_settings: FK directa a tenants RESTRICT, compuesta a la sede, CHECK de rango, RLS FORCE con NULLIF y sin DELETE para la app', () => {
    const sql = flat(DDL);
    expect(sql).toContain('CREATE TABLE "location_recall_settings"');
    expect(sql).toContain(
      'CONSTRAINT "location_recall_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT',
    );
    expect(sql).toContain('CHECK ("hideDays" BETWEEN 1 AND 90)');
    expect(sql).toContain('CHECK ("maxAttempts" BETWEEN 1 AND 10)');
    expect(sql).toContain(
      'ALTER TABLE "location_recall_settings" ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "location_recall_settings" FORCE ROW LEVEL SECURITY;',
    );
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBe(2);
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "location_recall_settings" FROM dentalix_app;',
    );
  });

  it('dx_phone_e164_stale es la de DX-266 más la marca de revisión, solo en patients', () => {
    const main = functionBody(MAIN_PHONE_STALE, 'dx_phone_e164_stale');
    const mine = functionBody(DDL, 'dx_phone_e164_stale');
    const added = `    -- DX-465: un teléfono nuevo ya no es el «número equivocado». Solo en
    -- patients (los responsables no tienen la marca; plpgsql resuelve el
    -- campo al ejecutar la rama).
    IF TG_TABLE_NAME = 'patients' THEN
      NEW."phoneReviewFlaggedAt" := NULL;
      NEW."phoneReviewFlaggedById" := NULL;
    END IF;
`;
    const anchor = '    NEW."phoneE164CheckedAt" := NULL;\n';
    expect(main).toContain(anchor);
    expect(mine).toBe(main.replace(anchor, anchor + added));
    expect(mine).toContain("SET search_path TO 'pg_catalog', 'pg_temp'");
  });

  it('sin CHECK de actor nuevo ni cambios en la lista de la fusión', () => {
    for (const m of [DDL, BACKFILL, INDEX, DROP, VALIDATE]) {
      expect(code(m)).not.toMatch(/audit_events_actor_check/);
      expect(code(m)).not.toMatch(/dx_patient_merge_tables/);
    }
  });
});
