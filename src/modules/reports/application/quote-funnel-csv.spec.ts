import { ClinicRole } from '@prisma/client';
import { EMPTY_QUOTE_FUNNEL_SUMS } from '../domain/quote-funnel';
import { QUOTE_FUNNEL_CSV_COLUMNS, toQuoteFunnelCsv } from './quote-funnel-csv';
import { GetQuoteFunnelUseCase } from './use-cases/get-quote-funnel.use-case';

const MAIN = '00000000-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-0000000000a1';

async function report(currency: string | null, locationId?: string) {
  const useCase = new GetQuoteFunnelUseCase(
    {
      listLocations: () =>
        Promise.resolve([{ id: MAIN, name: 'Sede principal', isActive: true }]),
      locationInClinic: () => Promise.resolve(true),
      listProfessionals: () =>
        Promise.resolve([{ userId: ME, fullName: '=Dra. Pérez' }]),
      aggregate: () =>
        Promise.resolve({
          total: {
            ...EMPTY_QUOTE_FUNNEL_SUMS,
            presented: 10,
            presentedAmount: 2650,
            accepted: 4,
            acceptedAmount: 1000,
            scheduled: 2,
            scheduledAmount: 300,
            medianSecondsToAccept: 86_400 * 2.5,
          },
          byProfessional: [
            {
              ...EMPTY_QUOTE_FUNNEL_SUMS,
              professionalId: ME,
              professionalName: '=Dra. Pérez',
              presented: 10,
              presentedAmount: 2650,
              accepted: 4,
              acceptedAmount: 1000,
              medianSecondsToAccept: 86_400 * 2.5,
            },
          ],
          rejectionReasons: [],
        }),
      listPresentations: () => Promise.resolve({ items: [], total: 0 }),
    },
    { current: () => Promise.resolve(currency) },
  );
  return useCase.execute({
    from: '2026-10-01',
    to: '2026-10-31',
    locationId,
    actor: { userId: ME, role: ClinicRole.ADMIN, permissions: [] },
    allowedLocationIds: 'ALL',
  });
}

describe('CSV del embudo de presupuestos (DX-558)', () => {
  it('cabecera con período, sede, profesional y moneda; una fila por profesional y el total', async () => {
    const csv = toQuoteFunnelCsv(await report('USD', MAIN));
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines.slice(0, 7)).toEqual([
      '"Embudo de presupuestos"',
      '"Período","2026-10-01 a 2026-10-31"',
      '"Sede","Sede principal"',
      '"Profesional que lo elaboró","Todos"',
      '"Moneda","USD"',
      '"Presentaciones fuera de los importes (sin tasa)","0"',
      '',
    ]);
    expect(lines[7]).toBe(
      QUOTE_FUNNEL_CSV_COLUMNS.map((c) => `"${c}"`).join(','),
    );
    // Protegida contra fórmulas.
    expect(lines[8]).toBe(
      `"'=Dra. Pérez",10,2650.00,4,1000.00,0,0.00,0,0.00,0,0.00,40,37.7,2.5`,
    );
    expect(lines[9]).toBe(
      '"Total",10,2650.00,4,1000.00,2,300.00,0,0.00,0,0.00,40,37.7,2.5',
    );
    expect(lines).toHaveLength(10);
  });

  it('sin moneda de catálogo: importes y tasa por importe vacíos', async () => {
    const csv = toQuoteFunnelCsv(await report(null));
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[2]).toBe('"Sede","Todas las sedes"');
    expect(lines[4]).toBe('"Moneda","Sin moneda de catálogo: sin importes"');
    expect(lines[9]).toBe('"Total",10,,4,,2,,0,,0,,40,,2.5');
  });
});
