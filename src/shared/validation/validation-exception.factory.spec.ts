import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  createAppValidationPipe,
  unknownFieldsMode,
} from './app-validation-pipe';
import {
  isDefaultValidatorMessage,
  VALIDATION_FAILED_CODE,
} from './validation-exception.factory';

enum Color {
  ROJO = 'ROJO',
  AZUL = 'AZUL',
}

class LineDto {
  @IsInt()
  @Max(10)
  qty!: number;
}

class ProbeDto {
  @IsString()
  @MaxLength(5)
  name!: string;

  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @IsOptional()
  @IsEnum(Color)
  color?: Color;

  @IsOptional()
  @IsString({ message: 'La nota debe ser un texto.' })
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines?: LineDto[];
}

const META: ArgumentMetadata = { type: 'body', metatype: ProbeDto };

async function badRequest(
  body: unknown,
  mode: 'strip' | 'reject' = 'strip',
): Promise<Record<string, unknown>> {
  try {
    await createAppValidationPipe(mode).transform(body, META);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('se esperaba un 400');
}

describe('exceptionFactory de la ValidationPipe (DX-111)', () => {
  it('traduce los mensajes por defecto y da el código por campo', async () => {
    const body = await badRequest({
      name: 'demasiado largo',
      ownerId: 'abc',
      color: 'VERDE',
    });
    expect(body).not.toHaveProperty('field');
    expect(body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      code: VALIDATION_FAILED_CODE,
    });
    expect(body.fields).toEqual([
      {
        field: 'name',
        code: 'maxLength',
        message: 'El campo «name» no puede tener más de 5 caracteres.',
      },
      {
        field: 'ownerId',
        code: 'isUuid',
        message: 'El campo «ownerId» debe ser un identificador válido.',
      },
      {
        field: 'color',
        code: 'isEnum',
        message: 'El campo «color» debe ser uno de estos valores: ROJO, AZUL.',
      },
    ]);
    expect(body.message).toEqual(
      (body.fields as { message: string }[]).map((f) => f.message),
    );
  });

  it('deja tal cual los mensajes propios en español', async () => {
    const body = await badRequest({ name: 'ok', note: 5 });
    expect(body.message).toEqual(['La nota debe ser un texto.']);
    // Un solo campo con error: va también en `field`, como en los 400 de regla.
    expect(body.field).toBe('note');
  });

  it('los campos anidados llevan su ruta', async () => {
    const body = await badRequest({ name: 'ok', lines: [{ qty: 99 }] });
    expect(body.fields).toEqual([
      {
        field: 'lines.0.qty',
        code: 'max',
        message: 'El campo «lines.0.qty» no puede ser mayor que 10.',
      },
    ]);
  });

  it('listas: tamaño máximo en español', async () => {
    const body = await badRequest({
      name: 'ok',
      lines: [{ qty: 1 }, { qty: 2 }],
    });
    expect(body.message).toEqual([
      'El campo «lines» no puede tener más de 1 elementos.',
    ]);
  });

  it('strip (por defecto): un campo de más se descarta sin error', async () => {
    const value = (await createAppValidationPipe('strip').transform(
      { name: 'ok', intruso: 1 },
      META,
    )) as Record<string, unknown>;
    expect(value).not.toHaveProperty('intruso');
  });

  it('reject: un campo de más → 400 whitelistValidation en español', async () => {
    const body = await badRequest({ name: 'ok', intruso: 1 }, 'reject');
    expect(body.fields).toEqual([
      {
        field: 'intruso',
        code: 'whitelistValidation',
        message: 'El campo «intruso» no está permitido en esta solicitud.',
      },
    ]);
  });

  it('ningún mensaje del 400 queda en inglés', async () => {
    const body = await badRequest({
      name: 7,
      ownerId: 1,
      color: 1,
      lines: 'x',
    });
    for (const m of body.message as string[]) {
      expect(isDefaultValidatorMessage(m)).toBe(false);
    }
  });
});

describe('unknownFieldsMode', () => {
  it('por defecto strip; reject solo si se pide; otro valor no arranca', () => {
    expect(unknownFieldsMode({})).toBe('strip');
    expect(unknownFieldsMode({ VALIDATION_UNKNOWN_FIELDS: '' })).toBe('strip');
    expect(unknownFieldsMode({ VALIDATION_UNKNOWN_FIELDS: 'REJECT' })).toBe(
      'reject',
    );
    expect(() =>
      unknownFieldsMode({ VALIDATION_UNKNOWN_FIELDS: 'quizas' }),
    ).toThrow('VALIDATION_UNKNOWN_FIELDS');
  });
});
