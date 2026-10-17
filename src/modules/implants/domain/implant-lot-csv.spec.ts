import { IMPLANT_LOT_CSV_HEADER, toImplantLotCsv } from './implant-lot-csv';

describe('toImplantLotCsv (DX-191)', () => {
  it('BOM, cabecera, una línea por implante y anti fórmulas', () => {
    const csv = toImplantLotCsv([
      {
        implantId: 'i1',
        patientId: 'p1',
        patientName: '=HYPERLINK("x")',
        patientDocument: 'CC 123',
        phone: '+57 300',
        placedOn: '2026-10-10',
        toothNumber: '36',
        kind: 'IMPLANT',
        manufacturer: 'Straumann',
        system: null,
        reference: '021.5310',
        lot: 'LOT-1',
        professionalName: 'Dra. "Ruiz"',
        locationName: 'Sede\nprincipal',
        voided: true,
      },
    ]);
    const [header, line, end] = csv.split('\r\n');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(header).toBe(`\uFEFF${IMPLANT_LOT_CSV_HEADER.join(',')}`);
    expect(line).toBe(
      `"'=HYPERLINK(""x"")","CC 123","'+57 300",2026-10-10,36,Implante,"Straumann","","021.5310","LOT-1","Dra. ""Ruiz""","Sede principal",Sí`,
    );
    expect(end).toBe('');
  });

  it('sin filas, solo la cabecera', () => {
    expect(toImplantLotCsv([]).split('\r\n')).toHaveLength(2);
  });
});
