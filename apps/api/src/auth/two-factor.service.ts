import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

@Injectable()
export class TwoFactorService {
  generateSecret(email: string) {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(email, 'DOT Trader', secret);
    return { secret, otpauthUrl };
  }

  async generateQrCodeDataUrl(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl);
  }

  verifyCode(secret: string, code: string): boolean {
    return authenticator.verify({ token: code, secret });
  }
}
