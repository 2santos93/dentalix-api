import { lockRow, type LockableTable } from './lock-row';

function fakeTx(rows: { id: string }[]) {
  const sql: string[] = [];
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push(
        strings.reduce(
          (out, part, i) =>
            out +
            part +
            (i < values.length
              ? ((values[i] as { sql?: string }).sql ?? '$')
              : ''),
          '',
        ),
      );
      return Promise.resolve(rows);
    },
  };
  return { tx: tx as never, sql };
}

describe('lockRow (DX-360)', () => {
  it('bloquea la fila con FOR UPDATE y dice si existe', async () => {
    const { tx, sql } = fakeTx([{ id: 'p1' }]);
    await expect(lockRow(tx, 'payers', 'p1')).resolves.toBe(true);
    expect(sql[0]).toMatch(/FROM "payers"/);
    expect(sql[0]).toMatch(/FOR UPDATE/);
  });

  it('FOR NO KEY UPDATE si se pide; false sin fila', async () => {
    const { tx, sql } = fakeTx([]);
    await expect(lockRow(tx, 'locations', 'l1', 'NO KEY UPDATE')).resolves.toBe(
      false,
    );
    expect(sql[0]).toMatch(/FOR NO KEY UPDATE/);
  });

  it('rechaza una tabla fuera de la lista', async () => {
    const { tx } = fakeTx([]);
    await expect(
      lockRow(tx, 'patients; --' as LockableTable, 'x'),
    ).rejects.toThrow('Tabla no bloqueable');
  });
});
