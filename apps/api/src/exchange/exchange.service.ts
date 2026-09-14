import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinanceConnector, ExchangeConnector } from '@dot-trader/exchange-connectors';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/crypto.util';

/**
 * Charge le connecteur d'échange actif. Garde-fous avant de risquer de l'argent réel :
 *  1. Le mode ("testnet" | "live") est déterminé par LIVE_TRADING_ENABLED côté serveur, jamais
 *     par un flag envoyé par un client — impossible de "passer en réel" par erreur depuis l'UI.
 *  2. Les credentials "live" viennent soit de `platform_exchange_accounts` (chiffré en base,
 *     pour une future gestion admin), soit de BINANCE_LIVE_API_KEY/SECRET en variable
 *     d'environnement (même mécanisme que le testnet) — jamais saisies via une route HTTP de
 *     cette API : aucun endpoint n'accepte de credentials exchange en entrée.
 *  3. Si le mode live est activé sans qu'aucune des deux sources ne soit configurée, le
 *     connecteur refuse de démarrer plutôt que de trader avec les mauvaises clés.
 */
@Injectable()
export class ExchangeService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeService.name);
  private connector: ExchangeConnector | null = null;
  private activeMode: 'testnet' | 'live' = 'testnet';

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.activeMode = this.config.get<string>('LIVE_TRADING_ENABLED') === 'true' ? 'live' : 'testnet';
    await this.loadConnector();
  }

  /** Recharge le connecteur depuis la base — appelé après qu'un admin configure/change des credentials. */
  async loadConnector() {
    const account = await this.prisma.platformExchangeAccount.findFirst({
      where: { exchange: 'binance', mode: this.activeMode, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (account) {
      const encryptionKey = this.config.get<string>('ENCRYPTION_KEY');
      if (!encryptionKey) {
        this.logger.error('ENCRYPTION_KEY absente — impossible de déchiffrer les credentials exchange stockés.');
        this.connector = null;
        return;
      }
      const apiKey = decryptSecret(account.apiKeyEncrypted, encryptionKey);
      const apiSecret = decryptSecret(account.apiSecretEncrypted, encryptionKey);
      this.connector = new BinanceConnector({ apiKey, apiSecret, mode: this.activeMode });
      this.logger.log(`Connecteur Binance (${this.activeMode}) chargé depuis la base (compte ${account.id}).`);
      return;
    }

    // Rien en base : repli sur les variables d'environnement du mode actif. Même mécanisme
    // pour live et testnet — la seule différence est le nom des variables lues.
    const apiKey = this.config.get<string>(
      this.activeMode === 'live' ? 'BINANCE_LIVE_API_KEY' : 'BINANCE_TESTNET_API_KEY',
    );
    const apiSecret = this.config.get<string>(
      this.activeMode === 'live' ? 'BINANCE_LIVE_API_SECRET' : 'BINANCE_TESTNET_API_SECRET',
    );
    if (!apiKey || !apiSecret) {
      this.logger.warn(
        this.activeMode === 'live'
          ? 'LIVE_TRADING_ENABLED=true mais BINANCE_LIVE_API_KEY/SECRET absents — connecteur non initialisé.'
          : 'BINANCE_TESTNET_API_KEY/SECRET absents — connecteur non initialisé.',
      );
      this.connector = null;
      return;
    }
    this.connector = new BinanceConnector({ apiKey, apiSecret, mode: this.activeMode });
  }

  getActiveMode(): 'testnet' | 'live' {
    return this.activeMode;
  }

  getConnector(): ExchangeConnector {
    if (!this.connector) {
      throw new ServiceUnavailableException(
        this.activeMode === 'live'
          ? 'Connecteur Binance live non configuré — renseignez BINANCE_LIVE_API_KEY/SECRET dans les variables d\'environnement du service.'
          : "Connecteur Binance testnet non configuré — renseignez BINANCE_TESTNET_API_KEY/SECRET dans apps/api/.env (clés à générer sur testnet.binance.vision), puis redémarrez l'API.",
      );
    }
    return this.connector;
  }
}
