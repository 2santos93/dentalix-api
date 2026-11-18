import { ConflictException } from '@nestjs/common';
import { LEAD_MESSAGES, LEAD_PHONE_TAKEN_CODE } from '../domain/lead-rules';

/** El 409 del teléfono repetido (alta o edición que pierde la carrera). */
export function phoneTakenError(existing: {
  kind: 'PATIENT' | 'LEAD';
  id: string | null;
  name: string | null;
}): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: LEAD_PHONE_TAKEN_CODE,
    message: LEAD_MESSAGES.phoneTaken,
    existing,
  });
}
