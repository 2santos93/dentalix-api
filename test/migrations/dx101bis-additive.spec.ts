import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-101-bis: aceptar el presupuesto desde el portal. Cuatro migraciones:
// la columna de evidencia con su FK compuesta NOT VALID, el índice único
// destino de la FK y el CHECK de evidencias redefinido NOT VALID; sus
// VALIDATE aparte (con NO FORCE en las dos tablas, DX-134); y el CHECK de
// actor de audit_events como UNIÓN EXACTA del de DX-101 más la cláusula del
// portal, con su VALIDATE aparte. Ni enum nuevo, ni datos que se recorran.

const migrations = join(__dirname, '../../prisma/migrations');
const raw = (m: string): string =>
  readFileSync(join(migrations, m, 'migration.sql'), 'utf8');
const code = (m: string): string =>
  raw(m)
    .replace(/--[^\n]*/g, '')
    .trim();
const flat = (m: string): string => code(m).replace(/\s+/g, ' ');

const SCHEMA = '20270115140000_dx101bis_portal_acceptance';
const SCHEMA_VALIDATE = '20270115140100_dx101bis_portal_acceptance_validate';
const ACTOR = '20270115140200_dx101bis_audit_actor_check';
const ACTOR_VALIDATE = '20270115140300_dx101bis_audit_actor_validate';
const ALL = [SCHEMA, SCHEMA_VALIDATE, ACTOR, ACTOR_VALIDATE];
const PREVIOUS_ACTOR = '20270111090300_dx101_audit_actor_check';

/** El cuerpo del CHECK de actor (de `ADD CONSTRAINT` al `NOT VALID`). */
function actorCheck(m: string): string {
  const sql = code(m);
  const start = sql.indexOf('ADD CONSTRAINT "audit_events_actor_check"');
  const end = sql.indexOf(') NOT VALID;', start);
  return sql.slice(start, end).replace(/\s+/g, ' ').trim();
}

describe('DX-101-bis: migraciones', () => {
  it.each(ALL)('%s fija lock_timeout antes de la primera sentencia', (m) => {
    expect(code(m)).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('nada se borra, renombra ni recorre (salvo el CHECK que se redefine)', () => {
    for (const m of ALL) {
      expect(code(m)).not.toMatch(
        /\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|ADD\s+VALUE/im,
      );
    }
    const drops = ALL.flatMap((m) => code(m).match(/DROP [^;]*;/g) ?? []);
    expect(drops).toEqual([
      'DROP CONSTRAINT "treatment_plan_acceptances_remote_check";',
      'DROP CONSTRAINT "audit_events_actor_check";',
    ]);
  });

  it('la columna: UUID NULL, FK compuesta NOT VALID al enlace del MISMO paciente, índices del destino y del lado hijo', () => {
    const sql = flat(SCHEMA);
    expect(sql).toContain(
      'ALTER TABLE "treatment_plan_acceptances" ADD COLUMN "patientAccessLinkId" UUID;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "patient_access_links_tenant_id_patient_key" ON "patient_access_links"("tenantId", "id", "patientId");',
    );
    expect(sql).toContain(
      'CREATE INDEX "treatment_plan_acceptances_patient_access_link_idx" ON "treatment_plan_acceptances"("tenantId", "patientAccessLinkId", "patientId");',
    );
    expect(sql).toContain(
      'ADD CONSTRAINT "treatment_plan_acceptances_patient_access_link_fkey" FOREIGN KEY ("tenantId", "patientAccessLinkId", "patientId") REFERENCES "patient_access_links"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
    );
    expect(sql).not.toMatch(/VALIDATE CONSTRAINT|NO FORCE/);
  });

  it('el CHECK de evidencias: en la clínica, por enlace de firma (sin cambios) o por portal; NOT VALID', () => {
    const sql = flat(SCHEMA);
    expect(sql).toContain(
      `ADD CONSTRAINT "treatment_plan_acceptances_remote_check" CHECK ( ("signatureRequestId" IS NULL AND "remoteChannel" IS NULL AND "remoteDestinationMasked" IS NULL AND "remoteSentAt" IS NULL AND "remoteOpenedAt" IS NULL AND "remoteVerifiedAt" IS NULL AND "patientAccessLinkId" IS NULL) OR ("signatureRequestId" IS NOT NULL AND "remoteChannel" IS NOT NULL AND char_length("remoteDestinationMasked") BETWEEN 1 AND 320 AND "remoteSentAt" IS NOT NULL AND "remoteOpenedAt" IS NOT NULL AND "remoteVerifiedAt" IS NOT NULL AND "patientAccessLinkId" IS NULL) OR ("patientAccessLinkId" IS NOT NULL AND "signatureRequestId" IS NULL AND "remoteChannel" IS NULL AND "remoteDestinationMasked" IS NULL AND "remoteSentAt" IS NULL AND "remoteOpenedAt" IS NULL AND "remoteVerifiedAt" IS NULL) ) NOT VALID;`,
    );
  });

  it('los VALIDATE van aparte, con NO FORCE en hija y referenciada y FORCE de vuelta', () => {
    expect(code(SCHEMA_VALIDATE).replace(/\s+/g, ' ')).toBe(
      [
        `SET LOCAL lock_timeout = '5s';`,
        'ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "patient_access_links" NO FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_patient_access_link_fkey";',
        'ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_remote_check";',
        'ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "patient_access_links" FORCE ROW LEVEL SECURITY;',
      ].join(' '),
    );
    expect(code(ACTOR_VALIDATE).replace(/\s+/g, ' ')).toBe(
      `SET LOCAL lock_timeout = '5s'; ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";`,
    );
  });

  it('el CHECK de actor es la UNIÓN EXACTA del de DX-101 y la cláusula del portal', () => {
    const clause = `OR ("action" = 'SIGN' AND "resourceType" = 'TREATMENT_PLAN' AND "actorRole" IS NULL AND "resourceId" IS NOT NULL AND "patientId" IS NOT NULL AND "metadata" ->> 'origin' = 'PUBLIC_LINK' AND "metadata" ->> 'reason' = 'PORTAL_QUOTE_ACCEPTED') IS TRUE`;
    expect(actorCheck(ACTOR)).toBe(`${actorCheck(PREVIOUS_ACTOR)} ${clause}`);
    expect(flat(ACTOR)).toMatch(/\) NOT VALID;$/);
  });
});
