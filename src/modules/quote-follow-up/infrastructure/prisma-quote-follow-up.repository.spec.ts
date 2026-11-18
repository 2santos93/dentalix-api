import { Prisma } from '@prisma/client';
import { isStepAlreadyRecorded } from './prisma-quote-follow-up.repository';

const p2002 = (message: string, target: unknown) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });

describe('isStepAlreadyRecorded (DX-561, M1)', () => {
  it('solo el UNIQUE (grupo, paso) del aviso es «ya registrado»', () => {
    expect(
      isStepAlreadyRecorded(
        p2002('Invalid `tx.quoteFollowUpMessage.create()` invocation', [
          'tenantId',
          'groupId',
          'step',
        ]),
      ),
    ).toBe(true);
    expect(
      isStepAlreadyRecorded(
        p2002('…', 'quote_follow_up_messages_group_step_key'),
      ),
    ).toBe(true);
  });

  it('otra violación de unicidad (el enlace vivo por plan, el email del aviso) no lo es', () => {
    expect(
      isStepAlreadyRecorded(
        p2002('Invalid `tx.signatureRequest.create()` invocation', null),
      ),
    ).toBe(false);
    expect(
      isStepAlreadyRecorded(
        p2002('…', 'email_outbox_quote_follow_up_reference_key'),
      ),
    ).toBe(false);
    expect(isStepAlreadyRecorded(new Error('x'))).toBe(false);
  });
});
