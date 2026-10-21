import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { FilesController } from './files.controller';
import { InMemoryFileStorage } from './__fixtures__/in-memory-file-storage';

function fakeRes(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    set(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

describe('FilesController · avatares (DX-259)', () => {
  it('con If-None-Match que coincide responde 304 con un HeadObject, sin descargar el objeto', async () => {
    const storage = new InMemoryFileStorage();
    await storage.save(
      'avatars/u1-0123456789abcdef.png',
      Buffer.from('PNG'),
      'image/png',
    );
    const { etag } = (await storage.stat('avatars/u1-0123456789abcdef.png'))!;
    const openRead = jest.spyOn(storage, 'openRead');
    const res = fakeRes();
    const req = {
      headers: { 'if-none-match': etag },
      fresh: true,
    } as unknown as Request;
    const out = await new FilesController(storage).getAvatar(
      'u1-0123456789abcdef.png',
      req,
      res,
    );
    expect(out).toBeUndefined();
    expect(openRead).not.toHaveBeenCalled();
    expect(res.headers).toMatchObject({
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  it('sin If-None-Match (o si cambió) lo sirve en streaming con su ETag', async () => {
    const storage = new InMemoryFileStorage();
    await storage.save('avatars/u1.png', Buffer.from('PNG'), 'image/png');
    const stat = jest.spyOn(storage, 'stat');
    const res = fakeRes();
    const req = { headers: {}, fresh: false } as unknown as Request;
    const out = await new FilesController(storage).getAvatar(
      'u1.png',
      req,
      res,
    );
    expect(stat).not.toHaveBeenCalled();
    expect(out?.getStream()).toBeInstanceOf(Readable);
    expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    expect(res.headers['Content-Type']).toBe('image/png');
  });
});
