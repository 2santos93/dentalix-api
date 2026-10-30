import type { PhoneRegion } from '../../../shared/phone/phone-number';
import {
  withPhoneInternational,
  type WithPhoneInternational,
} from '../../../shared/phone/with-phone-international';
import type { ResponsiblePartyOutput } from './doc-type-name.presenter';

export type ResponsiblePartyWithPhoneOutput = WithPhoneInternational<
  Omit<ResponsiblePartyOutput, 'responsiblePatient'> & {
    responsiblePatient: WithPhoneInternational<
      NonNullable<ResponsiblePartyOutput['responsiblePatient']>
    > | null;
  }
>;

/**
 * DX-387: el responsable y, si es otro paciente, su resumen, con el
 * `phoneInternational` leído con la región de la petición.
 */
export function responsiblePartyWithPhoneInternational(
  party: ResponsiblePartyOutput,
  region: PhoneRegion | null,
): ResponsiblePartyWithPhoneOutput {
  return withPhoneInternational(
    {
      ...party,
      responsiblePatient:
        party.responsiblePatient &&
        withPhoneInternational(party.responsiblePatient, region),
    },
    region,
  );
}
