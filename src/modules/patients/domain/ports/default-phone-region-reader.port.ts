import type { PhoneRegion } from '../../../../shared/phone/phone-number';

/**
 * DX-387: la región por defecto del teléfono de la petición (la de la sede
 * activa o, en la vista consolidada, la de la principal; ver
 * `PatientCommunicationRepository.defaultPhoneRegion`). Las salidas de
 * pacientes y responsables la leen una vez por petición para su
 * `phoneInternational`.
 */
export abstract class DefaultPhoneRegionReader {
  abstract defaultPhoneRegion(): Promise<PhoneRegion | null>;
}
