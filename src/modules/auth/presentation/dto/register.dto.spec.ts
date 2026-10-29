import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REGISTER_TEXT_MAX_LENGTH, RegisterDto } from './register.dto';

// DX-144 (SEC-034): el alta pública no admite textos largos en lo que el
// solicitante escribe (nombre de la clínica y de la persona), igual que las
// invitaciones (120). Mensajes en español, para la web.
describe('RegisterDto (DX-144)', () => {
  const valid = {
    clinicName: 'Clínica Sonrisa',
    subdomain: 'sonrisa',
    email: 'dueña@sonrisa.co',
    password: 'Clave-Segura-2026!',
    fullName: 'Dra. Ana Pérez',
  };

  async function messagesFor(
    field: 'clinicName' | 'fullName',
    value: string,
  ): Promise<string[]> {
    const dto = plainToInstance(RegisterDto, { ...valid, [field]: value });
    const errors = await validate(dto);
    return Object.values(
      errors.find((e) => e.property === field)?.constraints ?? {},
    );
  }

  it('el límite es 120, como en las invitaciones', () => {
    expect(REGISTER_TEXT_MAX_LENGTH).toBe(120);
  });

  it('acepta 120 caracteres en el nombre de la clínica y de la persona', async () => {
    expect(await messagesFor('clinicName', 'C'.repeat(120))).toEqual([]);
    expect(await messagesFor('fullName', 'N'.repeat(120))).toEqual([]);
  });

  it('rechaza un nombre de la clínica de más de 120 caracteres, en español', async () => {
    expect(await messagesFor('clinicName', 'C'.repeat(121))).toEqual([
      'El nombre de la clínica admite como mucho 120 caracteres',
    ]);
  });

  it('rechaza un nombre de la persona de más de 120 caracteres, en español', async () => {
    expect(await messagesFor('fullName', 'N'.repeat(121))).toEqual([
      'Tu nombre admite como mucho 120 caracteres',
    ]);
  });

  it('un texto de phishing largo en el nombre no pasa la validación', async () => {
    const lure =
      'Tu cuenta bancaria fue bloqueada, entra en https://bit.ly/xxxx y llama al +57 300 000 0000 para desbloquearla hoy mismo antes de que la cerremos';
    expect(lure.length).toBeGreaterThan(120);
    expect(await messagesFor('fullName', lure)).toHaveLength(1);
  });

  it('los mínimos siguen en español', async () => {
    expect(await messagesFor('clinicName', 'C')).toEqual([
      'El nombre de la clínica debe tener al menos 2 caracteres',
    ]);
    expect(await messagesFor('fullName', 'N')).toEqual([
      'Tu nombre debe tener al menos 2 caracteres',
    ]);
  });
});

// G1 (spec §3.5): los cuatro campos de la primera sede. El DTO solo comprueba
// tipos; presencia, subconjuntos y la lista de monedas son del caso de uso.
describe('RegisterDto · primera sede (G1)', () => {
  const base = {
    clinicName: 'Clínica Sonrisa',
    subdomain: 'sonrisa',
    email: 'duena@sonrisa.co',
    password: 'Clave-Segura-2026!',
    fullName: 'Dra. Ana Pérez',
  };

  async function messages(extra: object): Promise<string[]> {
    const errors = await validate(
      plainToInstance(RegisterDto, { ...base, ...extra }),
    );
    return errors.flatMap((e) => Object.values(e.constraints ?? {}));
  }

  it('acepta los cuatro campos; la forma legada sin ninguno pasa el DTO y la rechaza el caso de uso (400)', async () => {
    expect(
      await messages({
        locationCountry: 'CO',
        locationCurrency: 'JPY',
        locationTimeZone: 'Asia/Tokyo',
        locationLocale: 'ja-JP',
      }),
    ).toEqual([]);
    expect(await messages({})).toEqual([]);
  });

  it('un país que no es texto: 400 con el mensaje del campo', async () => {
    expect(await messages({ locationCountry: 5 })).toEqual([
      'Elige el país de la sede.',
    ]);
    // La lista de países la comprueba el caso de uso, no el DTO.
    expect(await messages({ locationCountry: 'VE' })).toEqual([]);
    expect(await messages({ locationCurrency: 840 })).toEqual([
      'Elige la moneda de la sede.',
    ]);
    expect(await messages({ locationTimeZone: 5 })).toEqual([
      'Elige la zona horaria de la sede.',
    ]);
    expect(await messages({ locationLocale: true })).toEqual([
      'Elige el formato regional de la sede.',
    ]);
  });
});
