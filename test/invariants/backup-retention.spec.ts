import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// DX-082: política de retención de las copias de la BD (35 diarias + 12
// mensuales). `scripts/backup-retention.sh` lee nombres de copia (o claves
// con prefijo del bucket) por stdin y escribe, por cada una, una línea
// `acción<TAB>nombre<TAB>motivo`. Solo `delete` se borra; `review` NUNCA se
// borra sola: son mensuales de más de 12 meses que pueden contener HC dentro
// del plazo legal (DX-039) y las revisa una persona.

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'backup-retention.sh');

type Line = { action: string; name: string; reason: string };

function retention(names: string[], args: string[] = []) {
  const res = spawnSync(SCRIPT, args, {
    input: names.map((n) => `${n}\n`).join(''),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  const lines: Line[] = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [action, name, reason] = l.split('\t');
      return { action, name, reason };
    });
  const byName = new Map(lines.map((l) => [l.name, l]));
  return { status: res.status, stderr: res.stderr, lines, byName };
}

/** Nombre de copia con el timestamp UTC de `backup-db.sh`. */
function backup(iso: string, prefix = 'dentalix-dentalix'): string {
  const ts = iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `${prefix}_${ts}.dump.age`;
}

/** Una copia diaria a las 03:00 UTC desde `from` durante `days` días. */
function dailySeries(from: string, days: number): string[] {
  const start = Date.parse(`${from}T03:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    backup(new Date(start + i * 86_400_000).toISOString()),
  );
}

const NOW = ['--now', '2026-10-31T12:00:00Z'];

describe('backup-retention.sh (DX-082): 35 diarias + 12 mensuales', () => {
  it('conserva las 35 últimas diarias y borra las diarias anteriores que no son mensuales', () => {
    // 2026-09-01 … 2026-10-31: 61 días.
    const names = dailySeries('2026-09-01', 61);
    const r = retention(names, NOW);
    expect(r.status).toBe(0);
    expect(r.lines).toHaveLength(61);

    // Las 35 últimas (2026-09-27 … 2026-10-31) se conservan.
    for (const n of names.slice(-35)) {
      expect(r.byName.get(n)?.action).toBe('keep');
    }
    // 2026-09-01 y 2026-10-01 son la primera copia de su mes: mensuales.
    expect(r.byName.get(backup('2026-09-01T03:00:00Z'))).toMatchObject({
      action: 'keep',
      reason: 'monthly',
    });
    expect(r.byName.get(backup('2026-10-01T03:00:00Z'))).toMatchObject({
      action: 'keep',
      reason: 'daily+monthly',
    });
    // 2026-09-02 … 2026-09-26: fuera de la ventana diaria y no mensuales.
    const deleted = r.lines.filter((l) => l.action === 'delete');
    expect(deleted).toHaveLength(25);
    expect(deleted.every((l) => l.reason === 'expired-daily')).toBe(true);
    expect(r.byName.get(backup('2026-09-26T03:00:00Z'))?.action).toBe('delete');
    expect(r.byName.get(backup('2026-09-27T03:00:00Z'))?.action).toBe('keep');
  });

  it('de varias copias del mismo día conserva la última como diaria', () => {
    const early = backup('2026-10-30T01:00:00Z');
    const late = backup('2026-10-30T23:30:00Z');
    const r = retention(
      [
        backup('2026-10-01T03:00:00Z'), // la mensual de octubre
        late,
        early,
        backup('2026-10-31T03:00:00Z'),
      ],
      NOW,
    );
    expect(r.status).toBe(0);
    expect(r.byName.get(late)).toMatchObject({
      action: 'keep',
      reason: 'daily',
    });
    expect(r.byName.get(early)).toMatchObject({
      action: 'delete',
      reason: 'superseded-same-day',
    });
  });

  it('la mensual es la primera copia del mes; las de más de 12 meses quedan en revisión (DX-039), nunca en delete', () => {
    // La primera copia de cada mes desde 2024-11 hasta 2026-10 (24 meses),
    // más la diaria de hoy para que la guarda de frescura pase.
    const monthly: string[] = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(Date.UTC(2024, 10 + i, 1, 3));
      monthly.push(backup(d.toISOString()));
    }
    const second = backup('2026-05-02T03:00:00Z');
    const r = retention(
      [...monthly, second, backup('2026-10-31T03:00:00Z')],
      NOW,
    );
    expect(r.status).toBe(0);

    // 2025-11 … 2026-10: las 12 mensuales vigentes.
    for (const n of monthly.slice(-12)) {
      expect(r.byName.get(n)?.action).toBe('keep');
    }
    // 2024-11 … 2025-10: más de 12 meses → revisión manual, no borrado.
    for (const n of monthly.slice(0, 12)) {
      expect(r.byName.get(n)).toMatchObject({
        action: 'review',
        reason: 'monthly-expired-review-dx039',
      });
    }
    // Una segunda copia de mayo, fuera de la ventana diaria: se borra.
    expect(r.byName.get(second)).toMatchObject({
      action: 'delete',
      reason: 'expired-daily',
    });
    expect(r.lines.filter((l) => l.action === 'delete')).toHaveLength(1);
  });

  it('acepta claves con prefijo de bucket y respeta --daily/--monthly', () => {
    const names = dailySeries('2026-10-25', 7).map((n) => `db/daily/${n}`);
    const r = retention(names, [...NOW, '--daily', '3', '--monthly', '1']);
    expect(r.status).toBe(0);
    // 25-oct es la primera del mes (mensual); 29, 30 y 31, las 3 diarias.
    expect(r.lines.map((l) => l.action)).toEqual([
      'keep',
      'delete',
      'delete',
      'delete',
      'keep',
      'keep',
      'keep',
    ]);
    expect(r.lines[0].name).toBe(names[0]);
  });

  it('lo que no reconoce (sidecars, otros ficheros) se conserva y no se borra', () => {
    const r = retention(
      [
        'notas.txt',
        `${backup('2026-10-31T03:00:00Z')}.sha256`,
        backup('2026-10-31T03:00:00Z'),
      ],
      NOW,
    );
    expect(r.status).toBe(0);
    expect(r.byName.get('notas.txt')).toMatchObject({
      action: 'keep',
      reason: 'unrecognized',
    });
    expect(r.lines.some((l) => l.action === 'delete')).toBe(false);
  });

  it('no borra nada si la copia más reciente tiene más de 48 h (las copias fallan)', () => {
    const names = dailySeries('2026-08-01', 60); // la última, 2026-09-29
    const r = retention(names, NOW);
    expect(r.status).toBe(3);
    expect(r.lines).toHaveLength(0);
    expect(r.stderr).toContain('48 h');
  });

  it('no borra nada si hay una copia con fecha futura (reloj mal)', () => {
    const r = retention(
      [backup('2026-10-31T03:00:00Z'), backup('2026-11-05T03:00:00Z')],
      NOW,
    );
    expect(r.status).toBe(3);
    expect(r.lines).toHaveLength(0);
    expect(r.stderr).toContain('futuro');
  });

  it('cada serie (prefijo y carpeta) va aparte: una copia de otra base o de otra carpeta no «sustituye» a otra', () => {
    // `dentalix-dentalix` y `dentalix-dentalix_staging` (base con «_»): el
    // mismo día, ninguna es superseded-same-day de la otra.
    const prod = backup('2026-10-30T03:00:00Z');
    const staging = backup('2026-10-30T04:00:00Z', 'dentalix-dentalix_staging');
    // La misma copia en db/daily/ y en db/monthly/ (runbook): la de monthly/
    // es la primera de su mes en SU carpeta y no sale como delete.
    const oldDaily = `db/daily/${backup('2026-08-01T03:00:00Z')}`;
    const oldMonthly = `db/monthly/${backup('2026-08-01T03:00:00Z')}`;
    const r = retention(
      [prod, staging, oldDaily, oldMonthly, backup('2026-10-31T03:00:00Z')],
      NOW,
    );
    expect(r.status).toBe(0);
    expect(r.byName.get(prod)?.action).toBe('keep');
    expect(r.byName.get(staging)?.action).toBe('keep');
    expect(r.byName.get(oldDaily)?.action).toBe('keep');
    expect(r.byName.get(oldMonthly)?.action).toBe('keep');
    expect(r.lines.some((l) => l.action === 'delete')).toBe(false);
  });

  it('rechaza argumentos inválidos con código 2', () => {
    expect(retention([], ['--daily', '0']).status).toBe(2);
    expect(retention([], ['--now', 'ayer']).status).toBe(2);
    expect(retention([], ['--monthly', 'x']).status).toBe(2);
  });

  it('sin entradas no hace nada y sale con 0', () => {
    const r = retention([], NOW);
    expect(r.status).toBe(0);
    expect(r.lines).toHaveLength(0);
  });
});
