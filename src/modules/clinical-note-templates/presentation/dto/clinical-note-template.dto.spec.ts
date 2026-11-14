import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateClinicalNoteTemplateDto,
  UpdateClinicalNoteTemplateDto,
} from './clinical-note-template.dto';
import { NOTE_SHORTCUT_FORMAT_MESSAGE } from '../../domain/note-template-shortcut';

// DX-455: el DTO solo comprueba el tipo y un tope del atajo; el formato fino
// (cualquier alfabeto, tras NFC) lo valida el caso de uso.
const base = { name: 'Resina', body: 'Texto', prompts: [] };

async function errorsOf(
  cls: new () => object,
  body: object,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('DTO de plantillas: atajo (DX-455)', () => {
  it.each([undefined, null, '#resina', '#extracción'])(
    'el alta acepta %p',
    async (shortcut) => {
      expect(
        await errorsOf(CreateClinicalNoteTemplateDto, { ...base, shortcut }),
      ).toEqual([]);
    },
  );

  it.each([42, `#${'a'.repeat(60)}`])(
    'el alta rechaza %p',
    async (shortcut) => {
      expect(
        await errorsOf(CreateClinicalNoteTemplateDto, { ...base, shortcut }),
      ).toContain(NOTE_SHORTCUT_FORMAT_MESSAGE);
    },
  );

  it('la edición acepta null (quitar el atajo) y rechaza un número', async () => {
    expect(
      await errorsOf(UpdateClinicalNoteTemplateDto, {
        version: 1,
        shortcut: null,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(UpdateClinicalNoteTemplateDto, {
        version: 1,
        shortcut: 7,
      }),
    ).toContain(NOTE_SHORTCUT_FORMAT_MESSAGE);
  });
});
