import { existsSync, mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  Controller,
  INestApplication,
  Module,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  UPLOAD_SLOTS,
  UploadSlotGuard,
  UploadSlotInterceptor,
  UploadSlots,
} from './upload-slots';

/**
 * DX-259 (revisión I-1): el semáforo y sus plazos contra un servidor HTTP
 * REAL. Node solo emite el `'timeout'` de la petición mientras se lee el
 * cuerpo; después, sin nadie que lo escuche, destruye el socket. Un `req`
 * falso (upload-slots.spec.ts) no lo reproduce.
 */
const UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'slots-http-'));
const IDLE_MS = 300;
const MAX_MS = 600;
const HANDLER_MS = 1200;

const seen: {
  activeDuringHandler: number[];
  fileExistsAfterWait: boolean[];
  lastFile: string | null;
} = { activeDuringHandler: [], fileExistsAfterWait: [], lastFile: null };

let slots: UploadSlots;

@Controller('t')
class SlowUploadController {
  @Post('upload')
  @UseGuards(UploadSlotGuard)
  @UseInterceptors(
    UploadSlotInterceptor,
    FileInterceptor('file', { dest: UPLOAD_DIR }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ ok: true; size: number }> {
    // Procesamiento lento (S3 lento pero vivo) DESPUÉS de recibir el cuerpo.
    await new Promise((r) => setTimeout(r, HANDLER_MS));
    seen.activeDuringHandler.push(slots.active);
    seen.lastFile = file?.path ?? null;
    seen.fileExistsAfterWait.push(!!file && existsSync(file.path));
    return { ok: true, size: file?.size ?? 0 };
  }
}

@Module({
  controllers: [SlowUploadController],
  providers: [
    {
      provide: UPLOAD_SLOTS,
      useFactory: () =>
        new UploadSlots(1, { idleTimeoutMs: IDLE_MS, maxDurationMs: MAX_MS }),
    },
    UploadSlotGuard,
  ],
})
class SlowUploadModule {}

function multipart(boundary: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

interface Outcome {
  status?: number;
  body?: string;
  error?: string;
}

/** POST real; `stallAfter` bytes y se queda callado (cliente lento). */
function post(
  port: number,
  body: Buffer,
  stallAfter?: number,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const boundary = 'b0undary';
    const payload = multipart(boundary, body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/t/upload',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(payload.length),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
        res.on('error', (e) =>
          resolve({ error: (e as NodeJS.ErrnoException).code }),
        );
      },
    );
    req.on('error', (e) =>
      resolve({ error: (e as NodeJS.ErrnoException).code }),
    );
    if (stallAfter === undefined) req.end(payload);
    else req.write(payload.subarray(0, stallAfter));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('UploadSlotGuard + UploadSlotInterceptor con HTTP real (DX-259, I-1)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SlowUploadModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as Server;
    port = (server.address() as AddressInfo).port;
    slots = app.get<UploadSlots>(UPLOAD_SLOTS);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    seen.activeDuringHandler = [];
    seen.fileExistsAfterWait = [];
    seen.lastFile = null;
  });

  it('un procesamiento más largo que los plazos de inactividad y total, con el cuerpo ya recibido, responde 201 sin cortar la conexión', async () => {
    const out = await post(port, Buffer.alloc(64 * 1024, 7));
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(201);
    expect(JSON.parse(out.body!)).toEqual({ ok: true, size: 64 * 1024 });
  });

  it('la plaza sigue ocupada y el temporal existe mientras el handler trabaja; ambos se liberan al terminar', async () => {
    await post(port, Buffer.alloc(1024, 1));
    expect(seen.activeDuringHandler).toEqual([1]);
    expect(seen.fileExistsAfterWait).toEqual([true]);
    await waitFor(() => slots.active === 0);
    await waitFor(() => !existsSync(seen.lastFile!));
  });

  it('un cliente que se calla a mitad del cuerpo recibe 408 en español y deja la plaza libre', async () => {
    const out = await post(port, Buffer.alloc(32 * 1024, 2), 1024);
    expect(out.status).toBe(408);
    expect(JSON.parse(out.body!)).toMatchObject({
      statusCode: 408,
      message: 'La subida tardó demasiado y se canceló. Vuelve a intentarlo.',
    });
    await waitFor(() => slots.active === 0);
    expect(seen.activeDuringHandler).toEqual([]);
  });
});
