import { IsOptional, IsString, validate } from 'class-validator';
import { TextMaxLength } from './input-limits';

class Probe {
  @IsString({ message: 'nota debe ser un texto.' })
  @TextMaxLength(5)
  nota!: unknown;

  @IsOptional()
  @IsString({ each: true })
  @TextMaxLength(3, { each: true })
  dientes?: unknown[];
}

async function messages(value: Partial<Probe>): Promise<string[]> {
  const probe = Object.assign(new Probe(), { nota: 'ok', ...value });
  const errors = await validate(probe);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('TextMaxLength (DX-111)', () => {
  it('acepta hasta el tope y rechaza uno más, en español', async () => {
    expect(await messages({ nota: '12345' })).toEqual([]);
    expect(await messages({ nota: '123456' })).toEqual([
      'nota no puede tener más de 5 caracteres.',
    ]);
  });

  it('un valor que no es texto da SOLO el mensaje de @IsString', async () => {
    expect(await messages({ nota: 123456 })).toEqual([
      'nota debe ser un texto.',
    ]);
  });

  it('con each, cada elemento', async () => {
    expect(await messages({ dientes: ['11', '1234'] })).toEqual([
      'Cada valor de dientes no puede tener más de 3 caracteres.',
    ]);
  });
});
