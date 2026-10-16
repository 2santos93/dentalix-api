/**
 * DX-134: lint de migraciones. Con RLS FORCE y un owner sin SUPERUSER ni
 * BYPASSRLS (Postgres gestionado), la validación de una FOREIGN KEY recorre la
 * tabla hija CON la RLS del owner: sin `app.current_tenant` no ve ninguna fila
 * de clínica y acepta la FK aunque haya huérfanas. Los CHECK y los índices
 * únicos sí ven las filas ocultas; las FK no.
 *
 * Regla (README, «Despliegue: roles de la BD»): añadir o validar una FK sobre
 * una tabla que ya tenía FORCE exige `ALTER TABLE … NO FORCE ROW LEVEL
 * SECURITY` antes, en la misma migración (y `FORCE` al final).
 *
 * Análisis textual, pensado para las migraciones de Prisma: sigue el estado de
 * FORCE de cada tabla migración a migración (CREATE/DROP/RENAME, FORCE y NO
 * FORCE) y avisa de cada `ADD … FOREIGN KEY` (sin NOT VALID) y de cada
 * `VALIDATE CONSTRAINT` de una FK sobre una tabla con FORCE en ese punto. No
 * cuentan las tablas creadas en la misma migración (están vacías), ni las FK
 * declaradas al añadir una columna nueva (todas sus filas son NULL). El SQL
 * dinámico (EXECUTE dentro de DO/funciones) no se analiza.
 */
export interface MigrationSource {
  name: string;
  sql: string;
}

export interface FkUnderForce {
  migration: string;
  table: string;
  /** null si la FK no tiene nombre (`ADD FOREIGN KEY`). */
  constraint: string | null;
  statement: 'ADD FOREIGN KEY' | 'VALIDATE CONSTRAINT';
}

/**
 * Migraciones ya aplicadas en main que añaden o validan una FK sobre una tabla
 * con FORCE sin NO FORCE. No se editan (ya están aplicadas) y hoy no esconden
 * datos rotos: un despliegue nuevo las aplica con las tablas vacías y las bases
 * existentes las aplicaron en su día con un owner superusuario, que valida
 * todas las filas. Una migración NUEVA no entra aquí: se corrige.
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

type Kind = 'fk' | 'other';

interface State {
  forced: Set<string>;
  /** Restricciones conocidas por tabla: FK u otra (CHECK, UNIQUE…). */
  constraints: Map<string, Kind>;
}

/** Quita comentarios, cadenas y cuerpos $…$ (no se analiza SQL dinámico). */
function stripNonCode(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function statements(sql: string): string[] {
  return stripNonCode(sql)
    .split(';')
    .map((s) => s.replace(/"/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const IDENT = '([A-Za-z_][A-Za-z0-9_$]*)';
const ALTER_TABLE = new RegExp(
  `^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\\.)?${IDENT} (.*)$`,
  'i',
);
const CREATE_TABLE = new RegExp(
  `^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?(?:public\\.)?${IDENT}`,
  'i',
);
const DROP_TABLE = /^DROP TABLE (?:IF EXISTS )?(.*?)(?: CASCADE| RESTRICT)?$/i;
const RENAME_TO = new RegExp(`^RENAME TO ${IDENT}$`, 'i');
const ADD_CONSTRAINT = new RegExp(
  `ADD (?:CONSTRAINT ${IDENT} )?(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY|EXCLUDE)\\b`,
  'gi',
);
const VALIDATE = new RegExp(`VALIDATE CONSTRAINT ${IDENT}`, 'gi');

const key = (table: string, constraint: string): string =>
  `${table}.${constraint}`;

function alterTable(
  table: string,
  rest: string,
  migration: string,
  createdHere: Set<string>,
  state: State,
  out: FkUnderForce[],
): void {
  const renamed = RENAME_TO.exec(rest);
  if (renamed) {
    const to = renamed[1].toLowerCase();
    for (const set of [state.forced, createdHere]) {
      if (set.delete(table)) set.add(to);
    }
    return;
  }
  if (/\bNO FORCE ROW LEVEL SECURITY\b/i.test(rest)) {
    state.forced.delete(table);
  }
  const checked = state.forced.has(table) && !createdHere.has(table);
  for (const add of rest.matchAll(ADD_CONSTRAINT)) {
    const name = add[1] ?? null;
    const isFk = add[2].toUpperCase() === 'FOREIGN KEY';
    if (name) {
      state.constraints.set(
        key(table, name.toLowerCase()),
        isFk ? 'fk' : 'other',
      );
    }
    if (isFk && checked && !/\bNOT VALID\b/i.test(rest)) {
      out.push({
        migration,
        table,
        constraint: name,
        statement: 'ADD FOREIGN KEY',
      });
    }
  }
  for (const v of rest.matchAll(VALIDATE)) {
    const kind = state.constraints.get(key(table, v[1].toLowerCase()));
    if (checked && kind !== 'other') {
      out.push({
        migration,
        table,
        constraint: v[1],
        statement: 'VALIDATE CONSTRAINT',
      });
    }
  }
  if (/(?<!\bNO )\bFORCE ROW LEVEL SECURITY\b/i.test(rest)) {
    state.forced.add(table);
  }
}

/** Recorre las migraciones EN ORDEN y devuelve cada FK validada bajo FORCE. */
export function findFkUnderForce(
  migrations: readonly MigrationSource[],
): FkUnderForce[] {
  const state: State = { forced: new Set(), constraints: new Map() };
  const out: FkUnderForce[] = [];
  for (const { name, sql } of migrations) {
    const createdHere = new Set<string>();
    for (const stmt of statements(sql)) {
      const created = CREATE_TABLE.exec(stmt);
      if (created) {
        const table = created[1].toLowerCase();
        createdHere.add(table);
        state.forced.delete(table);
        continue;
      }
      const dropped = DROP_TABLE.exec(stmt);
      if (dropped) {
        for (const t of dropped[1].split(',')) {
          state.forced.delete(
            t
              .trim()
              .replace(/^public\./i, '')
              .toLowerCase(),
          );
        }
        continue;
      }
      const altered = ALTER_TABLE.exec(stmt);
      if (altered) {
        alterTable(
          altered[1].toLowerCase(),
          altered[2],
          name,
          createdHere,
          state,
          out,
        );
      }
    }
  }
  return out;
}
