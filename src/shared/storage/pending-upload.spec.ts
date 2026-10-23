import { BadRequestException } from '@nestjs/common';
import { InMemoryFileStorage } from './__fixtures__/in-memory-file-storage';
import {
  CHECKSUM_MISMATCH_MESSAGE,
  EMPTY_FILE_MESSAGE,
  PENDING_META,
  SIZE_MISMATCH_MESSAGE,
  checkPendingUpload,
} from './pending-upload';
import { createHash } from 'node:crypto';

const KEY = 'x-docs/pending/t/u';
const rules = (maxBytes = 100) => ({
  maxBytes,
  tooLargeMessage: 'grande',
  isOwner: (m: Record<string, string>) => m[PENDING_META.uploadedBy] === 'yo',
  contentRejected: (message: string) =>
    new BadRequestException({ code: 'RECHAZADO', message }),
});
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function put(storage: InMemoryFileStorage, bytes: Buffer, meta = {}) {
  storage.simulateDirectUpload(KEY, bytes, {
    metadata: {
      [PENDING_META.uploadedBy]: 'yo',
      [PENDING_META.size]: String(bytes.length),
      [PENDING_META.sha256]: hex(bytes),
      ...meta,
    },
  });
}

describe('comprobación de una subida directa pendiente (compartida)', () => {
  let storage: InMemoryFileStorage;
  beforeEach(() => {
    storage = new InMemoryFileStorage();
  });

  it('un objeto del usuario con tamaño y huella declarados es válido', async () => {
    const bytes = Buffer.from('hola');
    put(storage, bytes);
    const out = await checkPendingUpload(storage, KEY, rules());
    expect(out).toMatchObject({ ok: true, declaredSha: hex(bytes) });
  });

  it('inexistente o de otro es NOT_FOUND, sin distinguir', async () => {
    expect(await checkPendingUpload(storage, KEY, rules())).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    put(storage, Buffer.from('hola'), { [PENDING_META.uploadedBy]: 'otro' });
    expect(await checkPendingUpload(storage, KEY, rules())).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });

  it.each([
    ['vacío', Buffer.alloc(0), {}, EMPTY_FILE_MESSAGE],
    ['grande', Buffer.alloc(101), {}, 'grande'],
    [
      'tamaño distinto',
      Buffer.from('hola'),
      { [PENDING_META.size]: '9' },
      SIZE_MISMATCH_MESSAGE,
    ],
    [
      'huella distinta',
      Buffer.from('hola'),
      { [PENDING_META.sha256]: 'ab'.repeat(32) },
      CHECKSUM_MISMATCH_MESSAGE,
    ],
  ])('rechaza %s', async (_n, bytes, meta, message) => {
    put(storage, bytes, meta);
    const out = await checkPendingUpload(storage, KEY, rules());
    expect(out).toMatchObject({ ok: false, reason: 'REJECTED' });
    if (!out.ok && out.reason === 'REJECTED') {
      expect(out.error.getResponse()).toMatchObject({ message });
    }
  });
});
