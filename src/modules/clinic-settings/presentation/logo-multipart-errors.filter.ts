import {
  BadRequestException,
  Catch,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MultipartErrorsFilter } from '../../patient-documents/presentation/multipart-errors.filter';
import { LOGO_MESSAGES } from '../domain/logo-image';

/** DX-019: los errores de multer del logo, en español y con su tope de 1 MB. */
@Catch(PayloadTooLargeException, BadRequestException)
export class LogoMultipartErrorsFilter extends MultipartErrorsFilter {
  protected override readonly tooLargeMessage = LOGO_MESSAGES.tooLarge;
}
