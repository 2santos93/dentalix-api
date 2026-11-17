import { regionalFormat } from '../../../shared/format/regional-format';
import { renderEmail } from '../../notifications/email/application/templates/templates';
import {
  composeWeeklyDigest,
  readReceivablesSnapshot,
  TOTAL_SECTION_NAME,
  type DigestLocationSources,
  type DigestMetric,
  type DigestScopeSources,
  type DigestSources,
} from './weekly-digest';
import {
  changeText,
  metricUrl,
  UNAVAILABLE_TEXT,
  weeklyDigestEmailVars,
} from './weekly-digest-email';

const WEEK = { weekStart: '2026-11-09', weekEnd: '2026-11-15' };
const PREVIOUS = { weekStart: '2026-11-02', weekEnd: '2026-11-08' };
const FMT = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
const BASE = 'https://sonrisas.dentalix.app';

function scope(over: Partial<DigestScopeSources> = {}): DigestScopeSources {
  return {
    comparison: {
      ok: true,
      value: {
        collected: [{ currency: 'USD', current: 1250, previous: 1000 }],
        production: [
          {
            currency: 'USD',
            current: 2000,
            previous: 1500,
            previousUnattributed: true,
          },
        ],
        completedAppointments: { current: 30, previous: 24 },
        noShows: { current: 3, previous: 6 },
        noShowRate: 9.1,
        newPatients: { current: 4, previous: 0 },
      },
    },
    quotes: {
      ok: true,
      value: {
        currency: 'USD',
        current: {
          presented: { count: 5, amount: 1200 },
          accepted: { count: 2, amount: 450.5 },
          withoutRate: 1,
        },
        previous: {
          presented: { count: 4, amount: 900 },
          accepted: { count: 2, amount: 300 },
          withoutRate: 0,
        },
      },
    },
    receivables: {
      ok: true,
      value: {
        overdue: [{ currency: 'USD', amount: 800 }],
        paymentsWithoutRateCount: 2,
        rateProviderTimedOut: true,
        withoutRateByCurrency: { USD: { count: 2, timedOut: true } },
      },
    },
    cash: { ok: true, value: { open: 2, openBeforeToday: 1 } },
    ...over,
  };
}

function location(
  id: string,
  name: string,
  over: Partial<DigestScopeSources> = {},
): DigestLocationSources {
  return { locationId: id, name, ...scope(over) };
}

function sources(over: Partial<DigestSources> = {}): DigestSources {
  return {
    week: WEEK,
    previousWeek: PREVIOUS,
    locations: [location('l-centro', 'Sede Centro')],
    total: scope(),
    ...over,
  };
}

const find = (metrics: DigestMetric[], key: DigestMetric['key']) =>
  metrics.find((m) => m.key === key)!;

describe('composeWeeklyDigest (DX-568, D5)', () => {
  it('una sección por sede y el total al final, con todas las cifras', () => {
    const digest = composeWeeklyDigest(sources(), null);
    expect(digest.sections.map((s) => [s.locationId, s.name])).toEqual([
      ['l-centro', 'Sede Centro'],
      [null, TOTAL_SECTION_NAME],
    ]);
    expect(digest.sections[0].metrics.map((m) => m.key)).toEqual([
      'collected',
      'production',
      'completedAppointments',
      'noShows',
      'newPatients',
      'quotesPresented',
      'quotesAccepted',
      'overdueBalance',
      'openCashSessions',
    ]);
  });

  it('las variaciones son las de Reportes (% con 1 decimal) y sin base no hay', () => {
    const [centro] = composeWeeklyDigest(sources(), null).sections;
    expect(find(centro.metrics, 'collected')).toMatchObject({
      currency: 'USD',
      current: 1250,
      previous: 1000,
      change: 25,
    });
    // BE-045: producción anterior sin atribuir → sin variación.
    expect(find(centro.metrics, 'production').change).toBeNull();
    expect(find(centro.metrics, 'completedAppointments').change).toBe(25);
    expect(find(centro.metrics, 'noShows')).toMatchObject({
      current: 3,
      previous: 6,
      change: -50,
      rate: 9.1,
    });
    // Anterior 0: sin base.
    expect(find(centro.metrics, 'newPatients').change).toBeNull();
    expect(find(centro.metrics, 'quotesPresented')).toMatchObject({
      current: 5,
      previous: 4,
      change: 25,
      currency: 'USD',
      amount: { current: 1200, previous: 900 },
      withoutRate: 1,
    });
    // La marca va solo en los presentados.
    expect(find(centro.metrics, 'quotesAccepted').withoutRate).toBe(0);
    expect(find(centro.metrics, 'openCashSessions')).toMatchObject({
      current: 2,
      previous: null,
      change: null,
      openBeforeToday: 1,
    });
  });

  it('el saldo vencido se compara con la foto del envío anterior; la primera semana, sin variación', () => {
    const first = composeWeeklyDigest(sources(), null);
    expect(find(first.sections[0].metrics, 'overdueBalance')).toMatchObject({
      current: 800,
      previous: null,
      change: null,
      withoutRate: 2,
    });
    const next = composeWeeklyDigest(sources(), first.receivablesSnapshot);
    expect(find(next.sections[0].metrics, 'overdueBalance')).toMatchObject({
      current: 800,
      previous: 800,
      change: 0,
    });
    const after = composeWeeklyDigest(sources(), {
      version: 1,
      byLocation: { 'l-centro': { USD: 1000, VES: 50 } },
      total: { USD: 1000 },
    });
    // La marca «sin tasa» va solo en la moneda afectada (USD), no en VES.
    expect(
      after.sections[0].metrics
        .filter((m) => m.key === 'overdueBalance')
        .map((m) => [m.currency, m.withoutRate]),
    ).toEqual([
      ['USD', 2],
      ['VES', 0],
    ]);
    const overdue = after.sections[0].metrics.filter(
      (m) => m.key === 'overdueBalance',
    );
    // La moneda que ya no se debe sale en 0 frente a lo de la foto.
    expect(
      overdue.map((m) => [m.currency, m.current, m.previous, m.change]),
    ).toEqual([
      ['USD', 800, 1000, -20],
      ['VES', 0, 50, -100],
    ]);
  });

  it('la foto guarda el saldo vencido por sede y el total, y se relee', () => {
    const digest = composeWeeklyDigest(
      sources({
        locations: [
          location('l-centro', 'Sede Centro'),
          location('l-norte', 'Sede Norte', { receivables: { ok: false } }),
        ],
      }),
      null,
    );
    expect(digest.receivablesSnapshot).toEqual({
      version: 1,
      byLocation: { 'l-centro': { USD: 800 } },
      total: { USD: 800 },
    });
    expect(
      readReceivablesSnapshot(
        JSON.parse(JSON.stringify(digest.receivablesSnapshot)),
      ),
    ).toEqual(digest.receivablesSnapshot);
    expect(readReceivablesSnapshot({ version: 2 })).toBeNull();
    expect(readReceivablesSnapshot(null)).toBeNull();
  });

  it('el fallo de una fuente marca solo sus cifras «no disponible»', () => {
    const digest = composeWeeklyDigest(
      sources({
        locations: [
          location('l-centro', 'Sede Centro', {
            comparison: { ok: false },
            cash: { ok: false },
          }),
        ],
      }),
      null,
    );
    const metrics = digest.sections[0].metrics;
    for (const key of [
      'collected',
      'production',
      'completedAppointments',
      'noShows',
      'newPatients',
      'openCashSessions',
    ] as const) {
      expect(find(metrics, key)).toMatchObject({
        unavailable: true,
        current: null,
      });
    }
    expect(find(metrics, 'quotesPresented').unavailable).toBe(false);
    expect(find(metrics, 'overdueBalance').unavailable).toBe(false);
    // El total no se ve afectado.
    expect(find(digest.sections[1].metrics, 'collected').unavailable).toBe(
      false,
    );
  });

  it('sin movimientos de dinero: una fila en cero, sin moneda', () => {
    const empty = scope();
    if (empty.comparison.ok) {
      empty.comparison.value.collected = [];
    }
    const digest = composeWeeklyDigest(
      sources({ locations: [{ locationId: 'l', name: 'L', ...empty }] }),
      null,
    );
    expect(find(digest.sections[0].metrics, 'collected')).toMatchObject({
      currency: null,
      current: 0,
      change: 0,
    });
  });
});

describe('el email del resumen (DX-568, D6)', () => {
  const digest = composeWeeklyDigest(
    sources({
      locations: [
        location('l-centro', 'Sede <Centro>', { comparison: { ok: false } }),
      ],
    }),
    null,
  );

  it('variación con signo y «—» sin ella', () => {
    // El % con el formato de la sede (es-VE: «25%», sin espacio).
    expect(changeText(25, FMT)).toBe('+25%');
    expect(changeText(-12.5, FMT)).toBe('−12,5%');
    expect(changeText(0, FMT)).toBe('0%');
    expect(changeText(null, FMT)).toBe('—');
  });

  it('cada cifra enlaza al informe con la misma semana (y la sede en presupuestos)', () => {
    expect(metricUrl(BASE, 'collected', WEEK, 'l-centro')).toBe(
      `${BASE}/reportes?tab=comparar-sedes&periodo=custom&desde=2026-11-09&hasta=2026-11-15`,
    );
    expect(metricUrl(BASE, 'quotesAccepted', WEEK, 'l-centro')).toBe(
      `${BASE}/reportes?tab=presupuestos&periodo=custom&desde=2026-11-09&hasta=2026-11-15&sede=l-centro`,
    );
    expect(metricUrl(BASE, 'quotesPresented', WEEK, null)).toBe(
      `${BASE}/reportes?tab=presupuestos&periodo=custom&desde=2026-11-09&hasta=2026-11-15`,
    );
    expect(metricUrl(BASE, 'overdueBalance', WEEK, null)).toBe(
      `${BASE}/caja/cartera`,
    );
    expect(metricUrl(BASE, 'openCashSessions', WEEK, null)).toBe(
      `${BASE}/caja?tab=turnos`,
    );
    expect(metricUrl(null, 'collected', WEEK, null)).toBeNull();
  });

  it('importes con código ISO, marcas «sin tasa» y «No disponible», y la baja', () => {
    const vars = weeklyDigestEmailVars({
      digest,
      clinicName: 'Sonrisas',
      fmt: FMT,
      linkBase: BASE,
      unsubscribeToken: 'T'.repeat(43),
      isTest: false,
    });
    expect(vars.periodLabel).toBe('9 nov–15 nov');
    const [centro, total] = vars.sections;
    expect(centro.rows[0]).toMatchObject({
      label: 'Cobrado',
      current: UNAVAILABLE_TEXT,
      previous: '—',
      change: '—',
    });
    const totalCollected = total.rows.find((r) =>
      r.label.startsWith('Cobrado'),
    )!;
    expect(totalCollected.label).toBe('Cobrado (USD)');
    expect(totalCollected.current).toMatch(/USD/);
    expect(totalCollected.current).not.toMatch(/\$/);
    expect(totalCollected.change).toBe('+25%');
    const overdue = total.rows.find((r) => r.label === 'Saldo vencido (USD)')!;
    expect(overdue.note).toBe('sin tasa (2)');
    const cash = total.rows.find((r) => r.label === 'Cajas sin cerrar')!;
    expect(cash).toMatchObject({
      current: '2',
      change: '—',
      note: '1 abierta antes de hoy',
    });
    const noShows = total.rows.find((r) => r.label === 'Inasistencias')!;
    expect(noShows.current).toBe('3 (9,1%)');
    const quotes = total.rows.find(
      (r) => r.label === 'Presupuestos presentados',
    )!;
    expect(quotes.current).toMatch(/^5 · USD/);
    expect(vars.unsubscribeUrl).toBe(`${BASE}/resumen/baja/${'T'.repeat(43)}`);
    expect(vars.settingsUrl).toBe(`${BASE}/settings/resumen-semanal`);
    expect(vars.notes.join(' ')).toMatch(/sin tasa \(N\)/);
    expect(vars.notes.join(' ')).toMatch(/No disponible/);
  });

  it('la prueba no lleva baja; sin host, ningún enlace', () => {
    const test = weeklyDigestEmailVars({
      digest,
      clinicName: 'Sonrisas',
      fmt: FMT,
      linkBase: BASE,
      unsubscribeToken: null,
      isTest: true,
    });
    expect(test.unsubscribeUrl).toBeNull();
    const noHost = weeklyDigestEmailVars({
      digest,
      clinicName: 'Sonrisas',
      fmt: FMT,
      linkBase: null,
      unsubscribeToken: 'T'.repeat(43),
      isTest: false,
    });
    expect(noHost.unsubscribeUrl).toBeNull();
    expect(noHost.settingsUrl).toBeNull();
    expect(noHost.sections.flatMap((s) => s.rows).every((r) => !r.url)).toBe(
      true,
    );
  });

  describe('renderizado de la plantilla weekly-digest', () => {
    const brand = {
      clinicName: 'Sonrisas & <Cía>',
      logoUrl: null,
      primaryColor: null,
    };

    it('asunto, tabla por sede con enlaces, escapado y pie de baja y ajustes', () => {
      const vars = weeklyDigestEmailVars({
        digest,
        clinicName: 'Sonrisas & <Cía>',
        fmt: FMT,
        linkBase: BASE,
        unsubscribeToken: 'T'.repeat(43),
        isTest: false,
      });
      const email = renderEmail('weekly-digest', vars, brand);
      expect(email.subject).toBe(
        'Resumen semanal de Sonrisas & <Cía>: 9 nov–15 nov',
      );
      expect(email.html).not.toContain('<Cía>');
      expect(email.html).toContain('Sonrisas &amp; &lt;Cía&gt;');
      expect(email.html).toContain('Sede &lt;Centro&gt;');
      expect(email.html).not.toContain('Sede <Centro>');
      expect(email.html).toContain('Esta semana');
      expect(email.html).toContain(
        `href="${BASE}/reportes?tab=comparar-sedes&amp;periodo=custom&amp;desde=2026-11-09&amp;hasta=2026-11-15"`,
      );
      expect(email.html).toContain(`${BASE}/resumen/baja/${'T'.repeat(43)}`);
      expect(email.html).toContain('Dejar de recibir este resumen');
      expect(email.html).toContain(`${BASE}/settings/resumen-semanal`);
      // Texto: tabla alineada y los mismos enlaces.
      expect(email.text).toContain('Sede <Centro>');
      expect(email.text).toMatch(
        /Cifra\s+Esta semana\s+Semana anterior\s+Variación/,
      );
      expect(email.text).toContain(`${BASE}/caja/cartera`);
      expect(email.text).toContain(`${BASE}/resumen/baja/${'T'.repeat(43)}`);
    });

    it('la prueba: «[Prueba]» en el asunto y sin baja; sin host, sin enlaces', () => {
      const vars = weeklyDigestEmailVars({
        digest,
        clinicName: 'Sonrisas',
        fmt: FMT,
        linkBase: null,
        unsubscribeToken: null,
        isTest: true,
      });
      const email = renderEmail('weekly-digest', vars, brand);
      expect(email.subject.startsWith('[Prueba] Resumen semanal de')).toBe(
        true,
      );
      expect(email.html).not.toContain('href="http');
      expect(email.text).not.toMatch(/https?:\/\//);
      expect(email.html).not.toContain('Dejar de recibir');
      expect(email.html).toContain('Es una prueba');
    });

    it('ningún dato de pacientes: solo etiquetas fijas, sedes y cifras', () => {
      const vars = weeklyDigestEmailVars({
        digest,
        clinicName: 'Sonrisas',
        fmt: FMT,
        linkBase: BASE,
        unsubscribeToken: 'T'.repeat(43),
        isTest: false,
      });
      const labels = new Set(
        vars.sections.flatMap((s) => s.rows.map((r) => r.label)),
      );
      expect([...labels].sort()).toEqual(
        [
          'Cajas sin cerrar',
          'Citas atendidas',
          'Cobrado',
          'Cobrado (USD)',
          'Inasistencias',
          'Pacientes nuevos',
          'Presupuestos aceptados',
          'Presupuestos presentados',
          'Producido',
          'Producido (USD)',
          'Saldo vencido (USD)',
        ].sort(),
      );
    });
  });
});
