import { StorageOpLogger, errorName } from './storage-op-log';

function capture() {
  const info: unknown[] = [];
  const warn: unknown[] = [];
  const logger = new StorageOpLogger({
    log: (line: unknown) => info.push(line),
    warn: (line: unknown) => warn.push(line),
  });
  return { logger, info, warn };
}

const KEY = 'patient-documents/6c1d0b4e-1111/9f00-ana-gomez.pdf';

describe('StorageOpLogger: la línea storage.op (DX-259)', () => {
  it('una subida y una lectura dejan operación, duración y resultado, nada más', async () => {
    const { logger, info } = capture();
    await logger.time(
      's3',
      'put',
      () => Promise.resolve(KEY),
      () => 'error',
      () => 2048,
    );
    await logger.time(
      's3',
      'get',
      () => Promise.resolve({ name: 'radiografía-ana.pdf' }),
      () => 'error',
    );
    expect(info).toEqual([
      {
        event: 'storage.op',
        driver: 's3',
        op: 'put',
        outcome: 'ok',
        durationMs: expect.any(Number) as number,
        bytes: 2048,
      },
      {
        event: 'storage.op',
        driver: 's3',
        op: 'get',
        outcome: 'ok',
        durationMs: expect.any(Number) as number,
      },
    ]);
    // Ni la clave, ni el nombre del fichero, ni nada de lo que devolvió la
    // operación llega a la línea.
    expect(JSON.stringify(info)).not.toMatch(
      /6c1d|9f00|ana|gomez|radiograf|pdf/i,
    );
  });

  it('un fallo es warn con el TIPO del error, nunca su mensaje (que puede llevar la clave)', async () => {
    const { logger, warn } = capture();
    const boom = Object.assign(new Error(`Access Denied for ${KEY}`), {
      name: 'AccessDenied',
    });
    await expect(
      logger.time(
        's3',
        'head',
        () => Promise.reject(boom),
        () => 'error',
      ),
    ).rejects.toBe(boom);
    expect(warn).toEqual([
      {
        event: 'storage.op',
        driver: 's3',
        op: 'head',
        outcome: 'error',
        durationMs: expect.any(Number) as number,
        error: 'AccessDenied',
      },
    ]);
    expect(JSON.stringify(warn)).not.toContain('6c1d');
  });

  it('not_found es info y sin error; timeout es warn', async () => {
    const { logger, info, warn } = capture();
    await expect(
      logger.time(
        'disk',
        'get',
        () => Promise.reject(new Error('x')),
        () => 'not_found',
      ),
    ).rejects.toThrow();
    await expect(
      logger.time(
        's3',
        'range',
        () => Promise.reject(new Error('x')),
        () => 'timeout',
      ),
    ).rejects.toThrow();
    expect(info).toEqual([
      expect.not.objectContaining({ error: expect.anything() as unknown }),
    ]);
    expect(warn).toEqual([expect.objectContaining({ outcome: 'timeout' })]);
  });

  it('record no deja pasar campos ajenos aunque se los pasen', () => {
    const { logger, info } = capture();
    logger.record({
      driver: 's3',
      op: 'delete',
      outcome: 'ok',
      durationMs: 1.6,
      ...({ key: KEY, fileName: 'ana.pdf' } as object),
    });
    expect(info).toEqual([
      {
        event: 'storage.op',
        driver: 's3',
        op: 'delete',
        outcome: 'ok',
        durationMs: 2,
      },
    ]);
  });

  it('errorName: el nombre o NonError', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorName('texto')).toBe('NonError');
  });
});
