/**
 * DX-148: reglas de `npm run db:lint-migrations` (README, «Migraciones en
 * caliente»). Análisis estático de un `migration.sql`, sin base de datos.
 *
 * `prisma migrate deploy` manda cada fichero como UN mensaje de consulta
 * simple: si tiene varias sentencias, Postgres las ejecuta en una sola
 * transacción implícita, y los bloqueos de cada sentencia siguen tomados
 * hasta el final del fichero. Un fichero con UNA sola sentencia va fuera de
 * transacción, y es la única forma de que `CREATE INDEX CONCURRENTLY` (o
 * `DROP INDEX CONCURRENTLY`) funcione desde Prisma.
 *
 * Reglas (un fallo por sentencia):
 *   validate-same-file      VALIDATE CONSTRAINT de una restricción añadida
 *                           NOT VALID en el mismo fichero: la misma
 *                           transacción retiene el ACCESS EXCLUSIVE del ADD.
 *   lock-timeout            DDL sobre una tabla que ya existía sin un
 *                           `SET LOCAL lock_timeout` ANTES de la primera.
 *   hot-table-index         CREATE INDEX sin CONCURRENTLY (o UNIQUE/PRIMARY
 *                           KEY sin USING INDEX) sobre una tabla caliente; en
 *                           `audit_events` (particionada) se admite
 *                           `ON ONLY` + índice por partición + ATTACH.
 *   concurrently-alone      CREATE/DROP INDEX CONCURRENTLY (y REINDEX
 *                           CONCURRENTLY) con más sentencias en el fichero:
 *                           Prisma fallaría ("cannot run inside a transaction
 *                           block").
 *   unbatched-dml           UPDATE/DELETE sobre una tabla que ya existía en un
 *                           fichero con DDL sobre tablas existentes: sin WHERE,
 *                           o un backfill de una sola sentencia; va por lotes
 *                           fuera de la migración de esquema.
 *
 * Excepción en el propio fichero, con motivo obligatorio:
 *   -- lint-migrations: ignore unbatched-dml: tabla de 12 filas de configuración
 *
 * Límites (documentados en el README): el SQL dinámico (EXECUTE dentro de un
 * DO o de una función) no se analiza; los cuerpos entre `$$` se tratan como
 * una sola sentencia opaca.
 */

export const HOT_TABLES = [
  'appointments',
  'patients',
  'payments',
  'treatment_plan_items',
  'tooth_records',
  'audit_events',
] as const;

/** Tablas calientes particionadas: el patrón es ON ONLY + partición + ATTACH. */
const PARTITIONED_HOT_TABLES = new Set(['audit_events']);

export type RuleId =
  | 'validate-same-file'
  | 'lock-timeout'
  | 'hot-table-index'
  | 'concurrently-alone'
  | 'unbatched-dml';

export const RULE_IDS: readonly RuleId[] = [
  'validate-same-file',
  'lock-timeout',
  'hot-table-index',
  'concurrently-alone',
  'unbatched-dml',
];

export interface Violation {
  rule: RuleId;
  /** Línea (1-based) donde empieza la sentencia. */
  line: number;
  message: string;
}

export interface Statement {
  /** Texto sin comentarios, con los cuerpos `$…$` y las cadenas vaciados. */
  sql: string;
  line: number;
}

/**
 * Parte el fichero en sentencias: quita comentarios (`--`, `/* *\/`) y vacía
 * las cadenas ('…', E'…') y los cuerpos entre `$tag$`, para que un `;` o una
 * palabra clave dentro de ellos no cuente. Los identificadores entre comillas
 * dobles se conservan.
 */
export function splitStatements(source: string): Statement[] {
  const out: Statement[] = [];
  let current = '';
  let line = 1;
  let startLine: number | null = null;
  let i = 0;
  const n = source.length;
  const push = (): void => {
    const sql = current.replace(/\s+/g, ' ').trim();
    if (sql !== '') out.push({ sql, line: startLine ?? line });
    current = '';
    startLine = null;
  };
  const emit = (text: string): void => {
    if (startLine === null && /\S/.test(text)) startLine = line;
    current += text;
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\n') {
      current += ' ';
      line += 1;
      i += 1;
      continue;
    }
    if (c === '-' && next === '-') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '\n') line += 1;
        if (source[i] === '/' && source[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      current += ' ';
      continue;
    }
    if (c === "'") {
      // E'…' admite \' como escape; en las cadenas normales solo ''.
      const escaped = /(^|[^\w$])[eE]$/.test(current);
      emit("''");
      i += 1;
      while (i < n) {
        if (source[i] === '\n') line += 1;
        if (source[i] === "'" && source[i + 1] === "'") i += 2;
        else if (escaped && source[i] === '\\') i += 2;
        else if (source[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === '"') {
      const end = source.indexOf('"', i + 1);
      const stop = end === -1 ? n : end + 1;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i));
      if (tag) {
        const end = source.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        for (let k = i; k < stop; k += 1) if (source[k] === '\n') line += 1;
        emit('$$ $$');
        i = stop;
        continue;
      }
    }
    if (c === ';') {
      push();
      i += 1;
      continue;
    }
    emit(c);
    i += 1;
  }
  push();
  return out;
}

/** Nombre de tabla normalizado: sin comillas, sin `public.`, en minúsculas. */
export function normalizeName(raw: string): string {
  const parts = raw.split('.').map((part) => part.trim());
  const last = parts[parts.length - 1];
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

/** Parte por `sep` fuera de paréntesis (las cadenas ya vienen vaciadas). */
function splitTopLevel(sql: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === sep && depth === 0) {
      out.push(sql.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(sql.slice(start).trim());
  return out;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;

const re = (src: string, flags = 'i'): RegExp => new RegExp(src, flags);

interface Parsed {
  /** Tabla sobre la que actúa la sentencia como DDL, o null si no es DDL de tabla. */
  ddlTable: string | null;
  /** Tablas existentes referenciadas por FK (bloqueo SHARE ROW EXCLUSIVE). */
  referenced: string[];
  createdTable: string | null;
  createIndex: {
    table: string;
    concurrently: boolean;
    only: boolean;
  } | null;
  concurrently: boolean;
  dml: { table: string; kind: 'UPDATE' | 'DELETE'; hasWhere: boolean } | null;
  setsLockTimeout: boolean;
  notValidConstraints: string[];
  validates: string | null;
  inlineUniqueOnTable: string | null;
}

function parse(sql: string): Parsed {
  const p: Parsed = {
    ddlTable: null,
    referenced: [],
    createdTable: null,
    createIndex: null,
    concurrently: false,
    dml: null,
    setsLockTimeout: false,
    notValidConstraints: [],
    validates: null,
    inlineUniqueOnTable: null,
  };
  let m: RegExpExecArray | null;

  if (re(String.raw`^SET\s+(?:LOCAL\s+)?lock_timeout\b`).test(sql)) {
    p.setsLockTimeout = true;
    return p;
  }

  if (
    (m = re(
      String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
    ).exec(sql))
  ) {
    p.createdTable = normalizeName(m[1]);
    const parent = re(String.raw`\bPARTITION\s+OF\s+(${IDENT})`).exec(sql);
    if (parent) p.ddlTable = normalizeName(parent[1]);
    for (const r of sql.matchAll(
      re(String.raw`\bREFERENCES\s+(${IDENT})`, 'gi'),
    )) {
      p.referenced.push(normalizeName(r[1]));
    }
    return p;
  }

  if (
    (m = re(
      String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s+)?ON\s+(ONLY\s+)?(${IDENT})`,
    ).exec(sql))
  ) {
    const table = normalizeName(m[3]);
    p.createIndex = {
      table,
      concurrently: Boolean(m[1]),
      only: Boolean(m[2]),
    };
    p.concurrently = Boolean(m[1]);
    if (!m[1]) p.ddlTable = table;
    return p;
  }

  if (
    re(String.raw`^(?:DROP\s+INDEX|REINDEX\b[^;]*?)\s+CONCURRENTLY\b`).test(sql)
  ) {
    p.concurrently = true;
    return p;
  }

  if (
    re(String.raw`^(?:DROP\s+INDEX|ALTER\s+INDEX|REINDEX\s+INDEX)\b`).test(sql)
  ) {
    // Sin CONCURRENTLY: ACCESS EXCLUSIVE (DROP) o SHARE UPDATE EXCLUSIVE
    // (ALTER … ATTACH PARTITION) sobre la tabla del índice, que el fichero no
    // nombra: DDL sobre una tabla existente.
    p.ddlTable = '(tabla del índice)';
    return p;
  }

  if (
    (m = re(
      String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})`,
    ).exec(sql))
  ) {
    p.ddlTable = normalizeName(m[1]);
    const actions = splitTopLevel(sql.slice(m[0].length), ',');
    for (const action of actions) {
      const c = re(String.raw`^ADD\s+CONSTRAINT\s+(${IDENT})`).exec(action);
      if (c && re(String.raw`\bNOT\s+VALID\b`).test(action)) {
        p.notValidConstraints.push(normalizeName(c[1]));
      }
    }
    const v = re(String.raw`\bVALIDATE\s+CONSTRAINT\s+(${IDENT})`).exec(sql);
    if (v) p.validates = normalizeName(v[1]);
    if (
      re(String.raw`\b(?:UNIQUE|PRIMARY\s+KEY)\s*\(`).test(sql) &&
      !re(String.raw`\bUSING\s+INDEX\b`).test(sql)
    ) {
      p.inlineUniqueOnTable = p.ddlTable;
    }
    for (const r of sql.matchAll(
      re(String.raw`\bREFERENCES\s+(${IDENT})`, 'gi'),
    )) {
      p.referenced.push(normalizeName(r[1]));
    }
    return p;
  }

  if (
    (m = re(
      String.raw`^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|DROP\s+TRIGGER|CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY)\b.*?\bON\s+(${IDENT})`,
    ).exec(sql))
  ) {
    p.ddlTable = normalizeName(m[1]);
    return p;
  }

  if (
    (m = re(
      String.raw`^(?:DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?|LOCK(?:\s+TABLE)?|CLUSTER|VACUUM\s+FULL|REINDEX\s+TABLE)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})`,
    ).exec(sql))
  ) {
    p.ddlTable = normalizeName(m[1]);
    return p;
  }

  if (
    (m = re(
      String.raw`^(?:WITH\b.*?\)\s*)?(UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(${IDENT})`,
    ).exec(sql))
  ) {
    p.dml = {
      table: normalizeName(m[2]),
      kind: m[1].toUpperCase().startsWith('UPDATE') ? 'UPDATE' : 'DELETE',
      hasWhere: re(String.raw`\bWHERE\b`).test(
        sql.slice(m.index + m[0].length),
      ),
    };
    return p;
  }
  return p;
}

const IGNORE = re(
  String.raw`--[ \t]*lint-migrations:[ \t]*ignore[ \t]+([a-z-]+)[ \t]*:[ \t]*(\S.*)$`,
  'gim',
);

/** Reglas ignoradas por el fichero (con su motivo); un motivo vacío no cuenta. */
export function ignoredRules(source: string): Map<RuleId, string> {
  const out = new Map<RuleId, string>();
  for (const m of source.matchAll(IGNORE)) {
    const rule = m[1] as RuleId;
    if (RULE_IDS.includes(rule) && m[2].trim().length >= 10)
      out.set(rule, m[2].trim());
  }
  return out;
}

export function lintMigration(source: string): Violation[] {
  const statements = splitStatements(source);
  const parsed = statements.map((s) => ({ ...s, p: parse(s.sql) }));
  const created = new Set<string>();
  const violations: Violation[] = [];
  const notValid = new Set<string>();
  let lockTimeoutSet = false;
  let hasExistingDdl = false;

  const existing = (t: string): boolean => !created.has(t);

  // Primera pasada: ¿hay DDL sobre alguna tabla existente? (gating de DML).
  {
    const seen = new Set<string>();
    for (const { p } of parsed) {
      if (p.createdTable) seen.add(p.createdTable);
      const touched = [
        ...(p.ddlTable ? [p.ddlTable] : []),
        ...p.referenced,
      ].filter((t) => !seen.has(t));
      if (touched.length > 0) hasExistingDdl = true;
    }
  }

  for (const { line, p } of parsed) {
    if (p.setsLockTimeout) {
      lockTimeoutSet = true;
      continue;
    }

    if (p.concurrently && statements.length > 1) {
      violations.push({
        rule: 'concurrently-alone',
        line,
        message:
          'CONCURRENTLY tiene que ser la ÚNICA sentencia del fichero: con más, Prisma ' +
          'lo ejecuta en una transacción y Postgres lo rechaza. Ponlo en su propia migración.',
      });
    }

    if (p.createIndex) {
      const { table, concurrently, only } = p.createIndex;
      const hot = (HOT_TABLES as readonly string[]).includes(table);
      if (hot && existing(table) && !concurrently) {
        const partitionedOk = PARTITIONED_HOT_TABLES.has(table) && only;
        if (!partitionedOk) {
          violations.push({
            rule: 'hot-table-index',
            line,
            message: PARTITIONED_HOT_TABLES.has(table)
              ? `CREATE INDEX sobre "${table}" (particionada, caliente) bloquea las escrituras: ` +
                'créalo ON ONLY en el padre, CONCURRENTLY en cada partición y ALTER INDEX … ATTACH PARTITION.'
              : `CREATE INDEX sin CONCURRENTLY sobre "${table}" (tabla caliente) bloquea las escrituras: ` +
                'usa CREATE INDEX CONCURRENTLY, solo, en su propio fichero.',
          });
        }
      }
    }

    if (p.inlineUniqueOnTable) {
      const t = p.inlineUniqueOnTable;
      if ((HOT_TABLES as readonly string[]).includes(t) && existing(t)) {
        violations.push({
          rule: 'hot-table-index',
          line,
          message:
            `UNIQUE/PRIMARY KEY sobre "${t}" construye el índice con ACCESS EXCLUSIVE: ` +
            'crea antes el índice único CONCURRENTLY y añade la restricción con USING INDEX.',
        });
      }
    }

    const ddlTargets = [
      ...(p.ddlTable ? [p.ddlTable] : []),
      ...p.referenced,
    ].filter(existing);
    if (ddlTargets.length > 0 && !lockTimeoutSet) {
      violations.push({
        rule: 'lock-timeout',
        line,
        message:
          `DDL sobre una tabla existente (${[...new Set(ddlTargets)].join(', ')}) sin ` +
          "`SET LOCAL lock_timeout = '5s';` antes: si otra transacción la tiene, toda la API " +
          'queda en cola detrás de la migración.',
      });
      // Un aviso por fichero basta.
      lockTimeoutSet = true;
    }

    if (p.validates && notValid.has(p.validates)) {
      violations.push({
        rule: 'validate-same-file',
        line,
        message:
          `VALIDATE CONSTRAINT "${p.validates}" en el mismo fichero que su NOT VALID: ` +
          'la transacción retiene el ACCESS EXCLUSIVE del ADD durante la validación. ' +
          'Lleva el VALIDATE a una migración posterior.',
      });
    }
    for (const c of p.notValidConstraints) notValid.add(c);

    if (p.dml && hasExistingDdl && existing(p.dml.table)) {
      violations.push({
        rule: 'unbatched-dml',
        line,
        message: p.dml.hasWhere
          ? `${p.dml.kind} de "${p.dml.table}" en una sola sentencia junto a DDL: retiene los ` +
            'bloqueos del DDL mientras recorre la tabla. Haz el backfill por lotes fuera de la ' +
            'migración de esquema (README, «Migraciones en caliente»).'
          : `${p.dml.kind} de "${p.dml.table}" sin WHERE junto a DDL: recorre toda la tabla con ` +
            'los bloqueos del DDL. Backfill por lotes fuera de la migración de esquema.',
      });
    }

    if (p.createdTable) created.add(p.createdTable);
  }

  const ignored = ignoredRules(source);
  return violations.filter((v) => !ignored.has(v.rule));
}
