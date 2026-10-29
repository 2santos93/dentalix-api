import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePatientDto } from './create-patient.dto';
import { UpdatePatientDto } from './update-patient.dto';
import {
  CreateResponsiblePartyDto,
  UpdateResponsiblePartyDto,
} from './responsible-party.dto';
import { DOCUMENT_TYPES } from '../../domain/document-type';
import { LEGACY_CODES } from '../../domain/legacy-doc-type';

const DOC_TYPE_MESSAGE =
  'El tipo de documento debe ser uno de: NATIONAL_ID, PASSPORT, RESIDENCE_PERMIT, TAX_ID, OTHER.';

const DTOS = [
  CreatePatientDto,
  UpdatePatientDto,
  CreateResponsiblePartyDto,
  UpdateResponsiblePartyDto,
] as const;

async function docTypeErrors(
  dto: (typeof DTOS)[number],
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance<object, object>(dto, body));
  return errors
    .filter((e) => e.property === 'docType' || e.property === 'docTypeLabel')
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('docType and docTypeLabel in the patient and responsible DTOs (DX-327)', () => {
  it.each(DTOS)('docType accepts the five generic types (%p)', async (dto) => {
    for (const docType of DOCUMENT_TYPES) {
      expect(await docTypeErrors(dto, { docType })).toEqual([]);
    }
  });

  it.each(DTOS)(
    'legacy codes pass validation for the controller to translate (%p)',
    async (dto) => {
      for (const docType of LEGACY_CODES) {
        expect(await docTypeErrors(dto, { docType })).toEqual([]);
      }
    },
  );

  it.each(DTOS)(
    'an unknown type is 400 with the generic list (%p)',
    async (dto) => {
      for (const docType of ['XX', 'national_id', 'constructor', '__proto__']) {
        expect(await docTypeErrors(dto, { docType })).toEqual([
          DOC_TYPE_MESSAGE,
        ]);
      }
    },
  );

  it('the patient type is required and has no default', async () => {
    expect(await docTypeErrors(CreatePatientDto, {})).toEqual([
      DOC_TYPE_MESSAGE,
    ]);
    expect(new CreatePatientDto().docType).toBeUndefined();
  });

  it.each(DTOS)('docTypeLabel is optional text (%p)', async (dto) => {
    const docType = 'OTHER';
    expect(
      await docTypeErrors(dto, { docType, docTypeLabel: 'ID local' }),
    ).toEqual([]);
    expect(await docTypeErrors(dto, { docType, docTypeLabel: null })).toEqual(
      [],
    );
    expect(await docTypeErrors(dto, { docType, docTypeLabel: 7 })).toEqual([
      'docTypeLabel debe ser un texto.',
    ]);
  });
});
