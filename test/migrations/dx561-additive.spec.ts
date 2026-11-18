import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-561: seguimiento automático de presupuestos. Cuatro migraciones: el
// valor de enum en su propio fichero; las tablas nuevas (FK directa a tenants
// RESTRICT, FK compuestas, RLS FORCE con NULLIF, guarda inmutable con la
// puerta de la fusión, sin DELETE para la app), la pausa en treatment_plans
// (FK con NO FORCE/FORCE, CHECK NOT VALID), el origen FOLLOW_UP de
// signature_requests y la lista de la fusión; el CHECK de actor como unión
// EXACTA del de main (DX-572) más la cláusula nueva; y los VALIDATE aparte.

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

const ENUM = '20270107140000_dx561_email_template';
const TABLES = '20270107140100_dx561_quote_follow_up';
const ACTOR = '20270107140200_dx561_audit_actor_check';
const VALIDATE = '20270107140300_dx561_validate';
const ALL = [ENUM, TABLES, ACTOR, VALIDATE];
const MAIN_ACTOR = '20261229090300_dx572_audit_actor_check';
const MAIN_MERGE = '20270105090200_dx566_post_op_checks';
const NEW_TABLES = [
  'location_quote_follow_up_settings',
  'quote_follow_up_messages',
];

/** El cuerpo del CHECK de actor (de `ADD CONSTRAINT` al final), sin comentarios. */
function actorCheck(migration: string): string {
  const sql = code(migration);
  return sql.slice(sql.indexOf('ALTER TABLE "audit_events" ADD CONSTRAINT'));
}

/** Las entradas de `dx_patient_merge_tables()` de una migración. */
function mergeTables(migration: string): string[] {
  const sql = code(migration);
  const body = sql.slice(sql.indexOf('dx_patient_merge_tables()'));
  return [...body.matchAll(/'([a-z_]+\.[A-Za-z]+)'/g)].map((m) => m[1]);
}

describe('DX-561: migraciones', () => {
  it.each(ALL)('%s fija lock_timeout antes de la primera sentencia', (m) => {
    expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('el valor de enum va solo en su fichero', () => {
    expect(
      code(ENUM)
        .replace(/^SET LOCAL lock_timeout = '5s';/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      `ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'quote-follow-up';`,
    );
  });

  it('el CHECK de actor es la unión EXACTA del de main (DX-572) y la cláusula del seguimiento', () => {
    const main = actorCheck(MAIN_ACTOR);
    const mine = actorCheck(ACTOR);
    const clause = `OR ("action" = 'SEND'
        AND "resourceType" = 'SIGNATURE_REQUEST'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'QUOTE_FOLLOW_UP_SENT') IS TRUE`;
    const tail = '\n  ) NOT VALID;';
    // Sin comentarios quedan líneas en blanco: solo cuenta el texto.
    const norm = (sql: string) =>
      sql
        .split('\n')
        .filter((line) => line.trim() !== '')
        .join('\n');
    expect(main.endsWith(tail)).toBe(true);
    expect(norm(mine)).toBe(
      norm(`${main.slice(0, -tail.length)}\n    ${clause}${tail}`),
    );
    expect(code(ACTOR)).toMatch(/DROP CONSTRAINT "audit_events_actor_check";/);
    expect(code(ACTOR)).not.toMatch(/VALIDATE/);
  });

  it('los VALIDATE van en su propio fichero y cubren todo lo NOT VALID', () => {
    const notValid = [
      ...`${code(TABLES)}\n${code(ACTOR)}`.matchAll(
        /ADD CONSTRAINT "([a-z_]+)"[^;]*NOT VALID;/g,
      ),
    ].map((m) => m[1]);
    expect(notValid.sort()).toEqual(
      [
        'audit_events_actor_check',
        'signature_requests_origin_check',
        'signature_requests_revoked_check',
        'signature_requests_state_check',
        'treatment_plans_quote_follow_up_pause_check',
      ].sort(),
    );
    const validated = [
      ...code(VALIDATE).matchAll(/VALIDATE CONSTRAINT "([a-z_]+)"/g),
    ].map((m) => m[1]);
    expect(validated.sort()).toEqual(notValid.sort());
    expect(code(TABLES)).not.toMatch(/VALIDATE/);
  });

  it('las tablas nuevas: FK directa a tenants RESTRICT, RLS FORCE con NULLIF y sin DELETE para la app', () => {
    const sql = flat(TABLES);
    for (const table of NEW_TABLES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(
        `CONSTRAINT "${table}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT`,
      );
      expect(sql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(sql).toContain(
      'REVOKE DELETE, TRUNCATE ON "location_quote_follow_up_settings" FROM dentalix_app;',
    );
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "quote_follow_up_messages" FROM dentalix_app;',
    );
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBe(4);
  });

  it('el aviso: UNIQUE por grupo y paso, FK compuesta al plan raíz del MISMO paciente y guarda inmutable con la puerta de la fusión', () => {
    const sql = flat(TABLES);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "quote_follow_up_messages_group_step_key" ON "quote_follow_up_messages"("tenantId", "groupId", "step");',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "groupId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId")',
    );
    expect(sql).toContain('CHECK ("step" BETWEEN 1 AND 3)');
    expect(
      code(TABLES).match(/public\.dx_patient_merge_gate\(TG_TABLE_NAME/g),
    ).toHaveLength(2);
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON "quote_follow_up_messages" FOR EACH ROW EXECUTE FUNCTION public.dx_quote_follow_up_messages_guard();',
    );
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "email_outbox_quote_follow_up_reference_key" ON "email_outbox" ("tenantId", "referenceId") WHERE "template" = 'quote-follow-up' AND "referenceId" IS NOT NULL;`,
    );
  });

  it('la lista de la fusión es la de main (DX-566) más quote_follow_up_messages, en orden', () => {
    const main = mergeTables(MAIN_MERGE);
    const mine = mergeTables(TABLES);
    expect(main.length).toBeGreaterThan(50);
    expect(mine).toEqual(
      [...main, 'quote_follow_up_messages.patientId'].sort(),
    );
    expect(mine).toEqual([...mine].sort());
  });

  it('treatment_plans: columnas en NULL, FK con NO FORCE / FORCE y nada más que toque filas', () => {
    const sql = flat(TABLES);
    expect(sql).toContain(
      'ALTER TABLE "treatment_plans" ADD COLUMN "quoteFollowUpPausedAt" TIMESTAMP(3), ADD COLUMN "quoteFollowUpPausedById" UUID;',
    );
    const noForce = sql.indexOf(
      'ALTER TABLE "treatment_plans" NO FORCE ROW LEVEL SECURITY;',
    );
    const fk = sql.indexOf('"treatment_plans_quote_follow_up_paused_by_fkey"');
    const force = sql.indexOf(
      'ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY;',
    );
    expect(noForce).toBeGreaterThan(0);
    expect(fk).toBeGreaterThan(noForce);
    expect(force).toBeGreaterThan(fk);
    for (const m of ALL) {
      expect(code(m)).not.toMatch(
        /^\s*UPDATE\b|DELETE\s+FROM|^\s*TRUNCATE\b|\bRENAME\b|DISABLE\s+TRIGGER|SET\s+NOT\s+NULL/im,
      );
    }
  });

  it('signature_requests: origen con DEFAULT constante, createdById NULL solo en FOLLOW_UP y la guarda congela el origen', () => {
    const sql = flat(TABLES);
    expect(sql).toContain(
      `ADD COLUMN "origin" "SignatureRequestOrigin" NOT NULL DEFAULT 'STAFF', ADD COLUMN "revokedByFollowUp" BOOLEAN NOT NULL DEFAULT false;`,
    );
    expect(sql).toContain(
      `CHECK ( (("origin" = 'STAFF') = ("createdById" IS NOT NULL)) AND ("origin" = 'STAFF' OR "type" = 'BUDGET') ) NOT VALID;`,
    );
    expect(sql).toContain('OR NEW."origin" IS DISTINCT FROM OLD."origin"');
    // El CHECK de estado recreado sin la cláusula de anulación, que pasa al
    // suyo propio con la alternativa del seguimiento.
    const state = sql.slice(
      sql.indexOf('ADD CONSTRAINT "signature_requests_state_check"'),
      sql.indexOf('ADD CONSTRAINT "signature_requests_revoked_check"'),
    );
    expect(state).not.toContain('"revokedById"');
    expect(sql).toContain(
      `CASE WHEN "revokedAt" IS NULL THEN "revokedById" IS NULL AND NOT "revokedByFollowUp" ELSE ("revokedById" IS NOT NULL) <> "revokedByFollowUp" END`,
    );
  });
});
