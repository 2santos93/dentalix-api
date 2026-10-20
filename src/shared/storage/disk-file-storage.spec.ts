import { DiskFileStorage } from './disk-file-storage';

const CFG = {
  driver: 'disk' as const,
  root: '/no-se-usa',
  publicBaseUrl: 'http://localhost:3000/api/v1/files',
};

describe('DiskFileStorage · URL firmada (DX-084)', () => {
  afterEach(() => jest.useRealTimers());

  it('firma clave y caducidad; vale hasta el TTL y no después', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const storage = new DiskFileStorage(CFG);
    const url = new URL(await storage.getSignedUrl('clinical/x.pdf', 60));
    expect(`${url.origin}${url.pathname}`).toBe(
      'http://localhost:3000/api/v1/files/signed',
    );
    const key = url.searchParams.get('key') ?? '';
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    expect(key).toBe('clinical/x.pdf');
    expect(Number(expires)).toBe(Date.parse('2026-10-19T12:01:00Z') / 1000);

    jest.setSystemTime(new Date('2026-10-19T12:00:59Z'));
    expect(storage.verifySignedUrl(key, expires, signature)).toBe(true);
    jest.setSystemTime(new Date('2026-10-19T12:01:01Z'));
    expect(storage.verifySignedUrl(key, expires, signature)).toBe(false);
  });

  it('rechaza firmas manipuladas, de otra clave o de otra instancia', async () => {
    const storage = new DiskFileStorage(CFG);
    const url = new URL(await storage.getSignedUrl('clinical/x.pdf', 60));
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    expect(storage.verifySignedUrl('clinical/y.pdf', expires, signature)).toBe(
      false,
    );
    expect(
      storage.verifySignedUrl(
        'clinical/x.pdf',
        String(Number(expires) + 3600),
        signature,
      ),
    ).toBe(false);
    expect(storage.verifySignedUrl('clinical/x.pdf', expires, 'abc')).toBe(
      false,
    );
    expect(
      new DiskFileStorage(CFG).verifySignedUrl(
        'clinical/x.pdf',
        expires,
        signature,
      ),
    ).toBe(false);
  });

  it('rechaza un TTL fuera de rango', async () => {
    await expect(
      new DiskFileStorage(CFG).getSignedUrl('clinical/x.pdf', 0),
    ).rejects.toThrow('TTL');
  });
});
