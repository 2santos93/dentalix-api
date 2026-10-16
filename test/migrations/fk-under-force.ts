/**
 * DX-134: lint de migraciones. Con RLS FORCE y un owner sin SUPERUSER ni
 * BYPASSRLS (Postgres gestionado), la validación de una FOREIGN KEY
 * (RI_Initial_Check) lee las dos tablas CON la RLS del owner; sin
 * `app.current_tenant` no ve ninguna fila de clínica:
 *   - FORCE en la tabla HIJA: acepta la FK aunque haya huérfanas, en silencio
 *     (los CHECK y los índices únicos sí ven las filas ocultas; las FK no);
 *   - FORCE en la REFERENCIADA: la FK falla con datos válidos (la CI migra con
 *     las tablas vacías y no lo ve; producción sí).
 *
 * Regla (README, «Despliegue: roles de la BD»): añadir o validar una FK exige
 * `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` en la hija y en la referenciada
 * (las que lo tengan), antes y en la misma migración, y `FORCE` al final.
 *
 * Análisis textual, pensado para las migraciones de Prisma. Un tokenizador de
 * una pasada quita comentarios (también anidados), cadenas ('…', E'…') y
 * cuerpos $tag$…$tag$, y parte por `;`. Sigue el estado de FORCE de cada
 * tabla migración a migración (CREATE/DROP/RENAME, FORCE y NO FORCE, también
 * dentro del mismo ALTER, que los aplica antes de validar) y avisa de cada
 * `ADD … FOREIGN KEY` sin NOT VALID (por subcomando), de cada
 * `ADD COLUMN … DEFAULT … REFERENCES` y de cada `VALIDATE CONSTRAINT` de una
 * FK cuya hija o referenciada tenga FORCE en ese punto. No cuenta una hija
 * creada en la misma migración (está vacía). El SQL dinámico (EXECUTE dentro
 * de DO/funciones) no se analiza.
 */
export interface MigrationSource {
  name: string;
  sql: string;
}

export interface FkUnderForce {
  migration: string;
  /** La tabla con FORCE: la hija (huérfanas en silencio) o la referenciada. */
  table: string;
  side: 'hija' | 'referenciada';
  /** null si la FK no tiene nombre (`ADD FOREIGN KEY`, columna con REFERENCES). */
  constraint: string | null;
  statement: 'ADD FOREIGN KEY' | 'VALIDATE CONSTRAINT';
}

/**
 * Migraciones ya aplicadas en main que añaden o validan una FK con FORCE en la
 * hija o en la referenciada, sin NO FORCE. No se editan (ya están aplicadas) y
 * hoy no esconden datos rotos ni bloquean: un despliegue nuevo las aplica con
 * las tablas vacías y las bases existentes las aplicaron en su día con un
 * owner superusuario, que valida todas las filas. Una migración NUEVA no entra
 * aquí: se corrige.
 */
export const FK_UNDER_FORCE_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    '20260727120000_add_reference_currency_country_city',
    'patients.countryCode/cityId: columnas nuevas, todas NULL al validar.',
  ],
  [
    '20260801150000_add_locations',
    'locationId de appointments, payments, inventory_items e inventory_movements. Con datos y este owner la migración ya falla de forma ruidosa antes (README).',
  ],
  [
    '20260801190000_appointment_patient_tenant_fk',
    'appointments(tenantId, patientId) → patients sobre columnas existentes: revisión DX-113 (O1).',
  ],
  [
    '20260807120000_soft_delete_schedule_ranges',
    'Rehace las FK location_schedule_ranges → location_schedules e installments → payment_plans: revisión DX-113 (O1).',
  ],
  [
    '20261017090100_treatment_plan_alternatives',
    'treatment_plans → treatment_plans/locations sobre columnas nuevas (todas NULL): revisión DX-113 (O1).',
  ],
  [
    '20261017180300_tooth_records_voids_record_fk',
    'DX-120: VALIDATE de la FK de anulación sobre una columna nueva (todas las filas previas NULL).',
  ],
  [
    '20261017190100_appointment_types',
    'DX-121: appointments.appointmentTypeId, columna nueva NULL sin default.',
  ],
]);

interface Constraint {
  kind: 'fk' | 'other';
  /** Tabla referenciada (solo FK). */
  ref?: string;
}

interface State {
  existing: Set<string>;
  forced: Set<string>;
  /** Restricciones conocidas, por `tabla.nombre`. */
  constraints: Map<string, Constraint>;
}

const isIdent = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Sentencias de código, sin comentarios, cadenas ni cuerpos `$tag$`, y sin las
 * comillas de los identificadores. Una sola pasada, carácter a carácter.
 */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const push = (): void => {
    const s = cur.replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
    cur = '';
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      cur += ' ';
      continue;
    }
    if (c === "'") {
      const escapes = /[Ee]/.test(sql[i - 1] ?? '') && !isIdent(sql[i - 2]);
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      cur += "''";
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      cur += sql.slice(i + 1, end === -1 ? sql.length : end);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (c === '$' && !isIdent(sql[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        cur += ' ';
        continue;
      }
    }
    if (c === ';') {
      push();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

/** Parte por las comas que no están entre paréntesis. */
function subcommands(rest: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of rest) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

const IDENT = '([A-Za-z_][A-Za-z0-9_$]*)';
const TABLE = `(?:public\\.)?${IDENT}`;
const ALTER_TABLE = new RegExp(
  `^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${TABLE} (.*)$`,
  'i',
);
const CREATE_TABLE = new RegExp(
  `^CREATE (?:UNLOGGED )?TABLE (IF NOT EXISTS )?${TABLE}`,
  'i',
);
const DROP_TABLE = /^DROP TABLE (?:IF EXISTS )?(.*?)(?: CASCADE| RESTRICT)?$/i;
const RENAME_TO = new RegExp(`^RENAME TO ${IDENT}$`, 'i');
const ADD_CONSTRAINT = new RegExp(
  `^ADD (?:CONSTRAINT ${IDENT} )?(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY|EXCLUDE)\\b`,
  'i',
);
const REFERENCES = new RegExp(`\\bREFERENCES ${TABLE}`, 'i');
const VALIDATE = new RegExp(`^VALIDATE CONSTRAINT ${IDENT}$`, 'i');
const NO_FORCE = /^NO FORCE ROW LEVEL SECURITY$/i;
const FORCE = /^FORCE ROW LEVEL SECURITY$/i;

const key = (table: string, constraint: string): string =>
  `${table}.${constraint.toLowerCase()}`;

class Linter {
  readonly state: State = {
    existing: new Set(),
    forced: new Set(),
    constraints: new Map(),
  };
  readonly out: FkUnderForce[] = [];
  private migration = '';
  private createdHere = new Set<string>();

  run(migrations: readonly MigrationSource[]): FkUnderForce[] {
    for (const { name, sql } of migrations) {
      this.migration = name;
      this.createdHere = new Set();
      for (const stmt of statements(sql)) this.statement(stmt);
    }
    return this.out;
  }

  private statement(stmt: string): void {
    const { existing, forced } = this.state;
    const created = CREATE_TABLE.exec(stmt);
    if (created) {
      const table = created[2].toLowerCase();
      if (created[1] && existing.has(table)) return;
      existing.add(table);
      forced.delete(table);
      this.createdHere.add(table);
      return;
    }
    const dropped = DROP_TABLE.exec(stmt);
    if (dropped) {
      for (const t of dropped[1].split(',')) {
        const table = t
          .trim()
          .replace(/^public\./i, '')
          .toLowerCase();
        existing.delete(table);
        forced.delete(table);
      }
      return;
    }
    const altered = ALTER_TABLE.exec(stmt);
    if (altered) this.alterTable(altered[1].toLowerCase(), altered[2]);
  }

  private alterTable(table: string, rest: string): void {
    const renamed = RENAME_TO.exec(rest);
    if (renamed) {
      const to = renamed[1].toLowerCase();
      const { existing, forced } = this.state;
      for (const set of [existing, forced, this.createdHere]) {
        if (set.delete(table)) set.add(to);
      }
      return;
    }
    const subs = subcommands(rest);
    // ALTER TABLE aplica FORCE/NO FORCE antes de validar las FK nuevas.
    for (const sub of subs) {
      if (NO_FORCE.test(sub)) this.state.forced.delete(table);
      else if (FORCE.test(sub)) this.state.forced.add(table);
    }
    for (const sub of subs) this.subcommand(table, sub);
  }

  private subcommand(table: string, sub: string): void {
    const validated = VALIDATE.exec(sub);
    if (validated) {
      const c = this.state.constraints.get(key(table, validated[1]));
      if (c?.kind !== 'other') {
        this.check(table, c?.ref, validated[1], 'VALIDATE CONSTRAINT');
      }
      return;
    }
    if (!/^ADD\b/i.test(sub)) return;
    const ref = REFERENCES.exec(sub)?.[1].toLowerCase();
    const constraint = ADD_CONSTRAINT.exec(sub);
    if (constraint) {
      const name = constraint[1] ?? null;
      const isFk = constraint[2].toUpperCase() === 'FOREIGN KEY';
      if (name) {
        this.state.constraints.set(
          key(table, name),
          isFk ? { kind: 'fk', ref } : { kind: 'other' },
        );
      }
      if (isFk && !/\bNOT VALID\b/i.test(sub)) {
        this.check(table, ref, name, 'ADD FOREIGN KEY');
      }
      return;
    }
    // ADD [COLUMN] … REFERENCES: con DEFAULT, todas las filas tienen valor.
    if (ref && /\bDEFAULT\b/i.test(sub)) {
      this.check(table, ref, null, 'ADD FOREIGN KEY');
    }
  }

  private check(
    table: string,
    ref: string | undefined,
    constraint: string | null,
    statement: FkUnderForce['statement'],
  ): void {
    if (this.createdHere.has(table)) return;
    const { forced } = this.state;
    const base = { migration: this.migration, constraint, statement };
    if (forced.has(table)) this.out.push({ ...base, table, side: 'hija' });
    if (ref && ref !== table && forced.has(ref) && !this.createdHere.has(ref)) {
      this.out.push({ ...base, table: ref, side: 'referenciada' });
    }
  }
}

/** Recorre las migraciones EN ORDEN y devuelve cada FK validada bajo FORCE. */
export function findFkUnderForce(
  migrations: readonly MigrationSource[],
): FkUnderForce[] {
  return new Linter().run(migrations);
}
