import type {
  ContingencyAgendaModel,
  ContingencyRow,
} from '../../domain/contingency-agenda';
import { PdfkitContingencyAgendaRenderer } from './contingency-agenda-pdf.renderer';

/** 0x80–0x9F de WinAnsi que se usan en las pruebas. */
const WIN_ANSI_HIGH: Record<number, string> = { 0x96: '–', 0x95: '•' };

/** Lo que pinta cada operador `TJ` (una línea), decodificado de WinAnsi. */
function paintedLines(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/\[([^\]]*)\] TJ/g)].map((op) =>
    [...op[1].matchAll(/<([0-9a-f]*)>/g)]
      .map((hex) =>
        [...Buffer.from(hex[1], 'hex')]
          .map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b))
          .join(''),
      )
      .join(''),
  );
}

/** Altura (origen abajo, en pt) de la línea base de cada texto pintado. */
function paintedAt(pdf: Buffer): { y: number; text: string }[] {
  const raw = pdf.toString('latin1');
  return [
    ...raw.matchAll(
      /1 0 0 1 [\d.-]+ ([\d.-]+) Tm\n(?:[^\n]*\n)*?\[([^\]]*)\] TJ/g,
    ),
  ].map((op) => ({
    y: Number(op[1]),
    text: [...op[2].matchAll(/<([0-9a-f]*)>/g)]
      .map((hex) =>
        [...Buffer.from(hex[1], 'hex')]
          .map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b))
          .join(''),
      )
      .join(''),
  }));
}

function row(
  patient: string,
  over: Partial<ContingencyRow> = {},
): ContingencyRow {
  return {
    time: '8:30 a. m. – 9:00 a. m.',
    patient,
    phone: '+58 412-1234567',
    professional: 'Dra. Ana Gómez',
    type: 'Limpieza',
    alerts: 'Confirmada · Primera visita',
    ...over,
  };
}

function model(
  over: Partial<ContingencyAgendaModel> = {},
): ContingencyAgendaModel {
  return {
    title: 'Agenda de contingencia',
    clinicName: 'Clínica Demo',
    locationName: 'Sede Centro',
    locationPhone: '+58 212-5550000',
    generatedLabel: 'Generada el 02/11/2026 2:15 a. m. (America/Caracas)',
    notice: 'Documento con datos personales de pacientes.',
    generatedAt: new Date('2026-11-02T06:15:00Z'),
    days: [
      {
        date: '2026-11-02',
        title: 'Hoy · lunes 2 de noviembre de 2026',
        rows: [row('Laura Castro')],
      },
      {
        date: '2026-11-03',
        title: 'Mañana · martes 3 de noviembre de 2026',
        rows: [],
      },
    ],
    total: 1,
    ...over,
  };
}

describe('PdfkitContingencyAgendaRenderer (DX-339)', () => {
  const renderer = new PdfkitContingencyAgendaRenderer({ compress: false });

  it('genera un PDF A4 apaisado con la cabecera de la sede, las columnas y cada cita', async () => {
    const pdf = await renderer.render(model());
    const raw = pdf.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
    const lines = paintedLines(pdf);
    for (const text of [
      'Agenda de contingencia',
      'Clínica Demo · Sede Centro · Tel. +58 212-5550000',
      'Generada el 02/11/2026 2:15 a. m. (America/Caracas)',
      'Hoy · lunes 2 de noviembre de 2026',
      'Hora',
      'Paciente',
      'Teléfono',
      'Profesional',
      'Tipo de cita',
      'Alertas',
      '8:30 a. m. – 9:00 a. m.',
      'Laura Castro',
      '+58 412-1234567',
      'Dra. Ana Gómez',
      'Limpieza',
      'Confirmada · Primera visita',
      'Mañana · martes 3 de noviembre de 2026',
      'Sin citas.',
      'Documento con datos personales de pacientes.',
      'Página 1 de 1',
      'Agenda de contingencia · Sede Centro · Generada el 02/11/2026 2:15 a. m. (America/Caracas)',
    ]) {
      expect(lines).toContain(text);
    }
  });

  it('una sede sin teléfono no pinta «Tel.»', async () => {
    const lines = paintedLines(
      await renderer.render(model({ locationPhone: null })),
    );
    expect(lines).toContain('Clínica Demo · Sede Centro');
  });

  it('con muchas citas pasa de página y repite la cabecera de columnas en cada una', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`Paciente ${i + 1}`));
    const pdf = await renderer.render(
      model({
        days: [{ ...model().days[0], rows }, model().days[1]],
        total: 60,
      }),
    );
    const lines = paintedLines(pdf);
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? [])
      .length;
    expect(pages).toBeGreaterThan(1);
    const continued = lines.filter(
      (l) => l === 'Hoy · lunes 2 de noviembre de 2026 (continúa)',
    ).length;
    expect(continued).toBeGreaterThan(0);
    // Una cabecera de columnas en la primera página del día y otra en cada continuación.
    expect(lines.filter((l) => l === 'Paciente').length).toBe(continued + 1);
    expect(lines).toContain('Paciente 60');
    expect(lines).toContain(`Página ${pages} de ${pages}`);
    // Sin páginas en blanco: cada página tiene su pie y algo más.
    expect(lines.filter((l) => l.startsWith('Página ')).length).toBe(pages);
  });

  it('el aviso final nunca pisa el pie, tenga el día las citas que tenga', async () => {
    const notice = model().notice;
    for (let n = 1; n <= 45; n++) {
      const rows = Array.from({ length: n }, (_, i) =>
        row(`Paciente ${i + 1}`),
      );
      const painted = paintedAt(
        await renderer.render(
          model({ days: [{ ...model().days[0], rows }], total: n }),
        ),
      );
      const footerY = Math.max(
        ...painted.filter((p) => p.text.startsWith('Página ')).map((p) => p.y),
      );
      const noticeY = painted.find((p) => p.text === notice)?.y;
      expect({
        n,
        above: noticeY !== undefined && noticeY > footerY + 8,
      }).toEqual({ n, above: true });
    }
  });

  it('es determinista: la misma entrada da los mismos bytes', async () => {
    const a = await renderer.render(model());
    const b = await renderer.render(model());
    expect(a.equals(b)).toBe(true);
  });
});
