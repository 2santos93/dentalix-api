import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { dx266Code, mergeHttpError, MERGE_BLOCKER_CODES } from './merge-errors';

describe('errores de la fusión (DX-266)', () => {
  it('saca el código DX266_* del mensaje o del meta de un error de Prisma', () => {
    expect(
      dx266Code(
        new Error(
          'Raw query failed. Code: `DX266`. Message: `DX266_NOT_FOUND`',
        ),
      ),
    ).toBe('DX266_NOT_FOUND');
    const prismaLike = Object.assign(new Error('fallo'), {
      meta: { code: 'DX266', message: 'DX266_OPEN_PAYMENT_PROMISES' },
    });
    expect(dx266Code(prismaLike)).toBe('DX266_OPEN_PAYMENT_PROMISES');
    expect(dx266Code(new Error('otra cosa'))).toBeNull();
  });

  it('cada código da su respuesta HTTP en español', () => {
    expect(mergeHttpError('DX266_NOT_FOUND')).toBeInstanceOf(NotFoundException);
    expect(mergeHttpError('DX266_SAME_PATIENT')).toBeInstanceOf(
      BadRequestException,
    );
    const inactive = mergeHttpError('DX266_PATIENT_INACTIVE');
    expect(inactive).toBeInstanceOf(ConflictException);
    expect(inactive.getResponse()).toMatchObject({
      code: 'MERGE_PATIENT_INACTIVE',
    });
    // DX-266-bis: volver a pasar lo tardío de un paciente no fusionado.
    const notMerged = mergeHttpError('DX266_NOT_MERGED');
    expect(notMerged).toBeInstanceOf(ConflictException);
    expect(notMerged.getResponse()).toMatchObject({
      code: 'MERGE_PATIENT_NOT_MERGED',
      message:
        'Este paciente no está fusionado con otro: no hay nada que volver a pasar.',
    });
    for (const code of MERGE_BLOCKER_CODES) {
      const error = mergeHttpError(code);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        code: expect.stringMatching(/^MERGE_/) as unknown,
        message: expect.stringMatching(/[a-záéíóú]/) as unknown,
      });
    }
    expect(mergeHttpError('DX266_LO_QUE_SEA')).toBeInstanceOf(
      ConflictException,
    );
  });
});
