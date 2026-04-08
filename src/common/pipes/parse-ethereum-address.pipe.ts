import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

@Injectable()
export class ParseEthereumAddressPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!ETH_ADDRESS_RE.test(value)) {
      throw new BadRequestException(
        `"${value}" is not a valid Ethereum address`,
      );
    }
    return value.toLowerCase();
  }
}
