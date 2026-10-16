import { BadRequestException } from '@nestjs/common';

/** 0 ≤ descuento ≤ precio (DX-012). La base lo repite con un CHECK. */
export function assertDiscountWithinPrice(
  price: number,
  discount: number,
): void {
  if (discount > price) {
    throw new BadRequestException(
      'El descuento no puede ser mayor que el precio del ítem.',
    );
  }
}
