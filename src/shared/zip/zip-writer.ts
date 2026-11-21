import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw } from 'node:zlib';

/**
 * DX-053: escritor de ZIP en STREAMING (sin dependencias): cada fichero se
 * comprime con deflate a medida que llega y se escribe en `out` respetando
 * su contrapresión, así que un CSV de millones de filas nunca está entero en
 * memoria. Formato clásico (APPNOTE 6.3): cabecera local con el bit 3 (los
 * tamaños y el CRC van en el descriptor de datos, detrás del contenido) y el
 * bit 11 (nombres en UTF-8), directorio central y registro final.
 *
 * Sin ZIP64: un fichero, el ZIP entero o más de 65 535 entradas por encima
 * de los límites de 32/16 bits lanzan `ZipTooLargeError` (una clínica real
 * queda muy lejos de 4 GB de CSV comprimido).
 */
export class ZipTooLargeError extends Error {
  constructor() {
    super('El ZIP supera los 4 GB o las 65 535 entradas (sin ZIP64).');
    this.name = 'ZipTooLargeError';
  }
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** Bit 3 (descriptor de datos) + bit 11 (nombre en UTF-8). */
const FLAGS = 0x0808;
const DEFLATE = 8;
/** 2.0: deflate y descriptor de datos. */
const VERSION = 20;

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

/** Fecha y hora MS-DOS (hora local del proceso; resolución de 2 s). */
function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    dosTime:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    dosDate:
      ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function assertU32(value: number): void {
  if (value > MAX_U32) throw new ZipTooLargeError();
}

/** Nombre de entrada seguro: sin rutas absolutas, `..`, barras invertidas ni controles. */
function assertEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((s) => s === '' || s === '.' || s === '..') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error(`Nombre de entrada ZIP inválido: "${name}"`);
  }
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private finished = false;

  constructor(private readonly out: Writable) {}

  /** Bytes escritos hasta ahora. */
  get bytesWritten(): number {
    return this.offset;
  }

  /**
   * Añade `name` con el contenido de `source` (texto en UTF-8 o bytes),
   * comprimido mientras se lee. Devuelve el tamaño sin comprimir.
   */
  async addFile(
    name: string,
    source: AsyncIterable<string | Buffer> | Iterable<string | Buffer>,
    modifiedAt: Date,
  ): Promise<{ size: number }> {
    if (this.finished) throw new Error('ZIP ya cerrado');
    assertEntryName(name);
    if (this.names.has(name)) {
      throw new Error(`Entrada ZIP repetida: "${name}"`);
    }
    if (this.entries.length >= MAX_ENTRIES) throw new ZipTooLargeError();
    this.names.add(name);

    const nameBytes = Buffer.from(name, 'utf8');
    const { dosTime, dosDate } = dosDateTime(modifiedAt);
    const offset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    // CRC y tamaños a 0: van en el descriptor de datos (bit 3).
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([header, nameBytes]));

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    async function* tap(): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        const bytes =
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (bytes.length === 0) continue;
        crc = crc32(bytes, crc);
        size += bytes.length;
        if (size > MAX_U32) throw new ZipTooLargeError();
        yield bytes;
      }
    }
    // El deflate escribe en `out` a través de `write` (contrapresión y
    // offset); `out` no se cierra ni acumula escuchadores por fichero.
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        compressedSize += chunk.length;
        this.write(chunk).then(() => callback(), callback);
      },
    });
    await pipeline(Readable.from(tap()), createDeflateRaw({ level: 6 }), sink);
    assertU32(compressedSize);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    assertU32(this.offset);

    this.entries.push({
      name: nameBytes,
      crc: crc >>> 0,
      compressedSize,
      size,
      offset,
      dosTime,
      dosDate,
    });
    return { size };
  }

  /** Escribe el directorio central y el registro final. Devuelve el tamaño total. */
  async finish(): Promise<number> {
    if (this.finished) throw new Error('ZIP ya cerrado');
    this.finished = true;
    const start = this.offset;
    for (const e of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      // «Hecho por»: 2.0, MS-DOS (atributos externos a 0).
      record.writeUInt16LE(VERSION, 4);
      record.writeUInt16LE(VERSION, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(DEFLATE, 10);
      record.writeUInt16LE(e.dosTime, 12);
      record.writeUInt16LE(e.dosDate, 14);
      record.writeUInt32LE(e.crc, 16);
      record.writeUInt32LE(e.compressedSize, 20);
      record.writeUInt32LE(e.size, 24);
      record.writeUInt16LE(e.name.length, 28);
      record.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([record, e.name]));
    }
    const centralSize = this.offset - start;
    assertU32(this.offset);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    return this.offset;
  }

  /** Escribe respetando la contrapresión de `out`. */
  private async write(bytes: Buffer): Promise<void> {
    this.offset += bytes.length;
    if (this.out.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        this.out.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.out.off('drain', onDrain);
        reject(err);
      };
      this.out.once('drain', onDrain);
      this.out.once('error', onError);
    });
  }
}
