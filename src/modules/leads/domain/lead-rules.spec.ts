import {
  LEAD_STAGES,
  PREDEFINED_LEAD_REASONS,
  cleanText,
  decideManualMove,
  isStale,
  matchCatalogReason,
  splitFullName,
  stepRate,
  type LeadStageCode,
} from './lead-rules';

describe('decideManualMove (DX-556)', () => {
  const allowed: [LeadStageCode, LeadStageCode][] = [
    ['NEW', 'CONTACTED'],
    ['CONTACTED', 'NEW'],
    ['NEW', 'LOST'],
    ['CONTACTED', 'LOST'],
    ['SCHEDULED', 'LOST'],
    ['SCHEDULED', 'CONTACTED'],
    ['LOST', 'NEW'],
    ['LOST', 'CONTACTED'],
  ];

  it.each(allowed)('%s → %s se permite (con motivo si es LOST)', (from, to) => {
    expect(decideManualMove(from, to, 'Precio')).toEqual({ ok: true });
  });

  it.each(LEAD_STAGES.filter((s) => s !== 'SCHEDULED'))(
    '%s → SCHEDULED: solo la cita (BY_APPOINTMENT)',
    (from) => {
      expect(decideManualMove(from, 'SCHEDULED', null)).toEqual({
        ok: false,
        reason: 'BY_APPOINTMENT',
      });
    },
  );

  it.each(LEAD_STAGES.filter((s) => s !== 'ATTENDED'))(
    '%s → ATTENDED: solo la cita (BY_APPOINTMENT)',
    (from) => {
      expect(decideManualMove(from, 'ATTENDED', null)).toEqual({
        ok: false,
        reason: 'BY_APPOINTMENT',
      });
    },
  );

  it('ATTENDED es final: no vuelve a ninguna etapa', () => {
    for (const to of ['NEW', 'CONTACTED', 'LOST'] as const) {
      expect(decideManualMove('ATTENDED', to, 'Precio')).toEqual({
        ok: false,
        reason: 'NOT_ALLOWED',
      });
    }
  });

  it('LOST → LOST y cualquier etapa a sí misma: SAME', () => {
    for (const stage of LEAD_STAGES) {
      expect(decideManualMove(stage, stage, 'Precio')).toEqual({
        ok: false,
        reason: 'SAME',
      });
    }
  });

  it('«Perdido» exige motivo: sin él (o en blanco) LOST_REASON', () => {
    expect(decideManualMove('NEW', 'LOST', null)).toEqual({
      ok: false,
      reason: 'LOST_REASON',
    });
    expect(decideManualMove('CONTACTED', 'LOST', '   ')).toEqual({
      ok: false,
      reason: 'LOST_REASON',
    });
  });

  it('cubre las 25 combinaciones sin lanzar', () => {
    for (const from of LEAD_STAGES) {
      for (const to of LEAD_STAGES) {
        expect(() => decideManualMove(from, to, 'Precio')).not.toThrow();
      }
    }
  });
});

describe('isStale (DX-556, «sin contactar hace más de 24 h»)', () => {
  const now = new Date('2027-01-14T15:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const base = {
    stage: 'NEW' as LeadStageCode,
    anonymizedAt: null,
    createdAt: hoursAgo(30),
    lastContactAt: null,
    nextActionAt: null,
  };

  it('nuevo de hace más de 24 h, sin contacto ni próxima acción: cuenta', () => {
    expect(isStale(base, now)).toBe(true);
  });

  it('justo a las 24 h cuenta; a las 23 h 59 min, no', () => {
    expect(isStale({ ...base, createdAt: hoursAgo(24) }, now)).toBe(true);
    expect(isStale({ ...base, createdAt: hoursAgo(23.99) }, now)).toBe(false);
  });

  it('un contacto reciente (nota o «Contactado») lo saca', () => {
    expect(isStale({ ...base, lastContactAt: hoursAgo(2) }, now)).toBe(false);
    expect(isStale({ ...base, lastContactAt: hoursAgo(25) }, now)).toBe(true);
  });

  it('una próxima acción futura lo saca; una vencida, no', () => {
    expect(isStale({ ...base, nextActionAt: hoursAgo(-5) }, now)).toBe(false);
    expect(isStale({ ...base, nextActionAt: hoursAgo(1) }, now)).toBe(true);
  });

  it('solo cuentan NEW y CONTACTED vivos', () => {
    expect(isStale({ ...base, stage: 'CONTACTED' }, now)).toBe(true);
    for (const stage of ['SCHEDULED', 'ATTENDED', 'LOST'] as const) {
      expect(isStale({ ...base, stage }, now)).toBe(false);
    }
    expect(isStale({ ...base, anonymizedAt: hoursAgo(1) }, now)).toBe(false);
  });
});

describe('textos y catálogo (DX-556)', () => {
  it('cleanText recorta y colapsa espacios; vacío = null', () => {
    expect(cleanText('  María   del  Carmen ')).toBe('María del Carmen');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(null)).toBeNull();
  });

  it('splitFullName: la primera palabra es el nombre y el resto el apellido', () => {
    expect(splitFullName('María del Carmen Pérez')).toEqual({
      firstName: 'María',
      lastName: 'del Carmen Pérez',
    });
    expect(splitFullName('  José  ')).toEqual({
      firstName: 'José',
      lastName: '',
    });
  });

  it('matchCatalogReason devuelve el texto del catálogo sin distinguir mayúsculas', () => {
    expect(matchCatalogReason('  precio ', PREDEFINED_LEAD_REASONS.LOSS)).toBe(
      'Precio',
    );
    expect(matchCatalogReason('Inventado', PREDEFINED_LEAD_REASONS.LOSS)).toBe(
      null,
    );
    expect(matchCatalogReason('', PREDEFINED_LEAD_REASONS.LOSS)).toBeNull();
  });

  it('los predefinidos están dentro de los topes de la BD (2–60) y sin repetir', () => {
    for (const list of Object.values(PREDEFINED_LEAD_REASONS)) {
      expect(new Set(list.map((r) => r.toLowerCase())).size).toBe(list.length);
      for (const r of list) {
        expect(r.length).toBeGreaterThanOrEqual(2);
        expect(r.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it('stepRate: 4 decimales y 0 sin base', () => {
    expect(stepRate(1, 3)).toBe(0.3333);
    expect(stepRate(2, 2)).toBe(1);
    expect(stepRate(0, 0)).toBe(0);
  });
});
