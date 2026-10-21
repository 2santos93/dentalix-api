import {
  BadRequestException,
  Catch,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MultipartErrorsFilter } from '../../patient-documents/presentation/multipart-errors.filter';
import { FILE_TOO_LARGE_MESSAGE } from '../domain/import-fields';

/** Los errores de multer de la importación, en español y con su tope de 5 MB. */
@Catch(PayloadTooLargeException, BadRequestException)
export class ImportMultipartErrorsFilter extends MultipartErrorsFilter {
  protected override readonly tooLargeMessage = FILE_TOO_LARGE_MESSAGE;
}
