import { csvDecimalAmount as exactAmount } from '../../../shared/csv/csv-cells';
import { csvHeader, csvLine, zonedInstant } from './csv-format';
import type { ExportColumn } from './export-catalog';

describe('Celdas de la exportación (DX-053)', () => {
  describe('csvDecimalAmount', () => {
    it('USD y VES con 2 decimales, sin coma flotante', () => {
      expect(exactAmount('1200', 'USD')).toBe('1200.00');
      expect(exactAmount('36.5', 'VES')).toBe('36.50');
      expect(exactAmount('0.1000', 'USD')).toBe('0.10');
      expect(exactAmount('-10.5', 'USD')).toBe('-10.50');
      // Más allá de la precisión de un double, exacto.
      expect(exactAmount('12345678901234.56', 'USD')).toBe('12345678901234.56');
    });

    it('JPY entero sin decimales; con céntimos, con 2; sin moneda, 2', () => {
      expect(exactAmount('1000', 'JPY')).toBe('1000');
      expect(exactAmount('1000.50', 'JPY')).toBe('1000.50');
      expect(exactAmount('1000', null)).toBe('1000.00');
    });
  });

  describe('zonedInstant', () => {
    it('en la zona de la sede con su desfase (Caracas, UTC−4)', () => {
      expect(zonedInstant('2026-11-21T13:30:05.123Z', 'America/Caracas')).toBe(
        '2026-11-21T09:30:05-04:00',
      );
    });

    it('cambia de día si toca', () => {
      expect(zonedInstant('2026-11-21T02:00:00.000Z', 'America/Caracas')).toBe(
        '2026-11-20T22:00:00-04:00',
      );
    });

    it('sin zona, o con una inválida, en UTC con Z', () => {
      expect(zonedInstant('2026-11-21T13:30:05.123Z', null)).toBe(
        '2026-11-21T13:30:05Z',
      );
      expect(zonedInstant('2026-11-21T13:30:05.123Z', 'Nada/Inventada')).toBe(
        '2026-11-21T13:30:05Z',
      );
    });

    it('UTC como zona escribe +00:00', () => {
      expect(zonedInstant('2026-11-21T13:30:05.000Z', 'UTC')).toBe(
        '2026-11-21T13:30:05+00:00',
      );
    });
  });

  describe('csvLine', () => {
    const columns: ExportColumn[] = [
      { header: 'Nombre', sql: '', kind: 'text' },
      { header: 'Código', sql: '', kind: 'int' },
      { header: 'Importe', sql: '', kind: 'amount', currency: 'x' },
      { header: 'Activo', sql: '', kind: 'bool' },
      { header: 'Fecha', sql: '', kind: 'date' },
      { header: 'Inicio', sql: '', kind: 'instant' },
      { header: 'Dientes', sql: '', kind: 'list' },
      { header: 'Alergias', sql: '', kind: 'json' },
      { header: 'Vacío', sql: '', kind: 'text' },
    ];

    it('formatea cada tipo y deja vacío lo que no hay', () => {
      const line = csvLine(columns, {
        z: 'America/Caracas',
        c0: 'Ana "la" Pérez',
        c1: '12',
        c2: '20.5',
        m2: 'USD',
        c3: true,
        c4: '2026-11-21',
        c5: '2026-11-21T13:30:00.000Z',
        c6: ['11', '12', null],
        c7: '[{"name":"Penicilina"}]',
        c8: null,
      });
      expect(line).toBe(
        '"Ana ""la"" Pérez",12,20.50,Sí,2026-11-21,2026-11-21T09:30:00-04:00,"11 | 12","[{""name"":""Penicilina""}]",',
      );
    });

    it('protege contra fórmulas y quita saltos de línea', () => {
      const line = csvLine(columns.slice(0, 1), { c0: '=HYPERLINK("x")\nmás' });
      expect(line).toBe(`"'=HYPERLINK(""x"") más"`);
      expect(csvLine(columns.slice(0, 1), { c0: '+58 412 0000000' })).toBe(
        `"'+58 412 0000000"`,
      );
    });

    it('No para false', () => {
      expect(csvLine([columns[3]], { c0: false })).toBe('No');
    });

    it('cabecera entre comillas', () => {
      expect(csvHeader(columns.slice(0, 2))).toBe('"Nombre","Código"');
    });
  });
});
