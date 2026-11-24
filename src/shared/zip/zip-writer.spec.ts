import { PassThrough, Writable } from 'node:stream';
import { crc32, inflateRawSync } from 'node:zlib';
import { ZipTooLargeError, ZipWriter } from './zip-writer';

interface ReadEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  data: Buffer;
}

/** Lector mínimo del ZIP (directorio central → cabecera local → deflate). */
function readZip(zip: Buffer): ReadEntry[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBe(zip.length - 22);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const localName = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + localName;
    const data = inflateRawSync(zip.subarray(start, start + compressed));
    expect(data.length).toBe(size);
    // Descriptor de datos detrás del contenido, con los mismos valores.
    const d = start + compressed;
    expect(zip.readUInt32LE(d)).toBe(0x08074b50);
    expect(zip.readUInt32LE(d + 4)).toBe(crc);
    expect(zip.readUInt32LE(d + 8)).toBe(compressed);
    expect(zip.readUInt32LE(d + 12)).toBe(size);
    entries.push({ name, flags, method, crc, data });
    p += 46 + nameLength;
  }
  return entries;
}

async function zipOf(
  build: (zip: ZipWriter) => Promise<void>,
): Promise<{ bytes: Buffer; total: number }> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const zip = new ZipWriter(out);
  await build(zip);
  const total = await zip.finish();
  out.end();
  return { bytes: Buffer.concat(chunks), total };
}

describe('ZipWriter (DX-053)', () => {
  const when = new Date(2026, 10, 21, 9, 30, 10);

  it('escribe un ZIP válido: deflate, UTF-8, CRC y tamaños en el descriptor', async () => {
    const { bytes, total } = await zipOf(async (zip) => {
      await zip.addFile(
        'pacientes.csv',
        ['﻿"Nombre"\r\n', '"Ana Pérez"\r\n'],
        when,
      );
      await zip.addFile('vacío.csv', [], when);
      await zip.addFile('LEEME.txt', [Buffer.from('hola')], when);
    });
    expect(total).toBe(bytes.length);
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name)).toEqual([
      'pacientes.csv',
      'vacío.csv',
      'LEEME.txt',
    ]);
    for (const e of entries) {
      expect(e.method).toBe(8);
      expect(e.flags & 0x0808).toBe(0x0808);
      expect(e.crc).toBe(crc32(e.data) >>> 0);
    }
    expect(entries[0].data.toString('utf8')).toBe(
      '﻿"Nombre"\r\n"Ana Pérez"\r\n',
    );
    expect(entries[1].data.length).toBe(0);
  });

  it('acepta un origen asíncrono grande y lo comprime en streaming', async () => {
    const rows = 20_000;
    async function* csv(): AsyncGenerator<string> {
      for (let i = 0; i < rows; i++) {
        if (i % 1000 === 0) await Promise.resolve();
        yield `"fila ${i}","Caracas"\r\n`;
      }
    }
    const { bytes } = await zipOf(async (zip) => {
      const { size } = await zip.addFile('grande.csv', csv(), when);
      expect(size).toBeGreaterThan(rows * 10);
    });
    const [entry] = readZip(bytes);
    const lines = entry.data.toString('utf8').split('\r\n');
    expect(lines).toHaveLength(rows + 1);
    expect(lines[rows - 1]).toBe(`"fila ${rows - 1}","Caracas"`);
    // Comprimido: mucho menor que el original.
    expect(bytes.length).toBeLessThan(entry.data.length / 3);
  });

  it('respeta la contrapresión: no adelanta el origen más allá de lo que el destino acepta', async () => {
    let produced = 0;
    let maxAhead = 0;
    let written = 0;
    const slow = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _e, cb) {
        written += chunk.length;
        setImmediate(cb);
      },
    });
    async function* source(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 200; i++) {
        await Promise.resolve();
        produced += 1;
        maxAhead = Math.max(maxAhead, produced * 64 * 1024 - written);
        // Bytes aleatorios: casi no se comprimen.
        yield Buffer.from(
          Array.from({ length: 64 * 1024 }, () =>
            Math.floor(Math.random() * 256),
          ),
        );
      }
    }
    const zip = new ZipWriter(slow);
    await zip.addFile('aleatorio.bin', source(), when);
    await zip.finish();
    await new Promise((resolve) => slow.end(resolve));
    expect(produced).toBe(200);
    expect(written).toBe(zip.bytesWritten);
    // 12,5 MB de origen; nunca más de unos pocos MB por delante del destino.
    expect(maxAhead).toBeLessThan(4 * 1024 * 1024);
  });

  it('rechaza nombres peligrosos y repetidos', async () => {
    const zip = new ZipWriter(new PassThrough());
    for (const name of [
      '',
      '/abs.csv',
      '../x.csv',
      'a/../b.csv',
      'a\\b.csv',
      'a\nb.csv',
    ]) {
      await expect(zip.addFile(name, [], when)).rejects.toThrow(
        'Nombre de entrada ZIP inválido',
      );
    }
    await zip.addFile('a.csv', [], when);
    await expect(zip.addFile('a.csv', [], when)).rejects.toThrow('repetida');
  });

  it('no admite añadir tras cerrar', async () => {
    const zip = new ZipWriter(new PassThrough());
    await zip.finish();
    await expect(zip.addFile('a.csv', [], when)).rejects.toThrow('cerrado');
    await expect(zip.finish()).rejects.toThrow('cerrado');
  });

  it('ZipTooLargeError tiene mensaje en español', () => {
    expect(new ZipTooLargeError().message).toContain('supera los 4 GB');
  });
});
