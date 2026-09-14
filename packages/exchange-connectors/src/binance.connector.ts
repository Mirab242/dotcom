import * as ccxt from 'ccxt';
import { Balance, Candle, OrderSide } from '@dot-trader/shared-types';
import {
  ExchangeConnector,
  ExchangeOrderResult,
  PlaceOrderParams,
  Timeframe,
} from './exchange-connector.interface';

export interface BinanceConnectorOptions {
  apiKey: string;
  apiSecret: string;
  mode: 'testnet' | 'live';
}

/**
 * Connecteur Binance (spot) via CCXT.
 * En mode 'testnet', bascule automatiquement CCXT sur le sandbox Binance
 * (https://testnet.binance.vision) — aucun fonds réel n'est jamais en jeu dans ce mode.
 */
export class BinanceConnector implements ExchangeConnector {
  readonly exchangeName = 'binance';
  readonly mode: 'testnet' | 'live';
  private readonly client: ccxt.binance;

  constructor(options: BinanceConnectorOptions) {
    this.mode = options.mode;
    this.client = new ccxt.binance({
      apiKey: options.apiKey,
      secret: options.apiSecret,
      enableRateLimit: true,
      // Corrige les erreurs -1021 "Timestamp ahead of server's time" en synchronisant
      // l'horloge locale avec celle de Binance avant de signer chaque requête.
      options: { adjustForTimeDifference: true },
    });
    if (options.mode === 'testnet') {
      this.client.setSandboxMode(true);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // fetchBalance suffit à valider les clés en lecture ; ne place aucun ordre.
      await this.client.fetchBalance();
      return true;
    } catch {
      return false;
    }
  }

  async getBalance(): Promise<Balance[]> {
    const raw = await this.client.fetchBalance();
    // Cast en Record<string, number> : les types CCXT pour total/free/used n'exposent
    // pas de signature d'index générique, alors qu'il s'agit bien d'un dictionnaire devise → montant.
    const totals = (raw.total ?? {}) as unknown as Record<string, number>;
    const frees = (raw.free ?? {}) as unknown as Record<string, number>;
    const useds = (raw.used ?? {}) as unknown as Record<string, number>;

    return Object.keys(totals)
      .filter((currency) => (totals[currency] ?? 0) > 0)
      .map((currency) => ({
        currency,
        free: frees[currency] ?? 0,
        used: useds[currency] ?? 0,
        total: totals[currency] ?? 0,
      }));
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const ohlcv = await this.client.fetchOHLCV(symbol, timeframe, undefined, limit);
    return ohlcv.map(([ts, open, high, low, close, volume]) => ({
      ts: ts as number,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
    }));
  }

  async placeOrder(params: PlaceOrderParams): Promise<ExchangeOrderResult> {
    const side: 'buy' | 'sell' = params.side === OrderSide.BUY ? 'buy' : 'sell';
    const order = await this.client.createOrder(
      params.symbol,
      params.type,
      side,
      params.amount,
      params.price,
      { newClientOrderId: params.clientOrderId },
    );
    return {
      exchangeOrderId: String(order.id),
      status: order.status ?? 'unknown',
      filledAmount: order.filled ?? 0,
      averagePrice: order.average ?? null,
      raw: order,
    };
  }

  async fetchOrderStatus(exchangeOrderId: string, symbol: string): Promise<ExchangeOrderResult> {
    const order = await this.client.fetchOrder(exchangeOrderId, symbol);
    return {
      exchangeOrderId: String(order.id),
      status: order.status ?? 'unknown',
      filledAmount: order.filled ?? 0,
      averagePrice: order.average ?? null,
      raw: order,
    };
  }

  async cancelOrder(exchangeOrderId: string, symbol: string): Promise<void> {
    await this.client.cancelOrder(exchangeOrderId, symbol);
  }

  async getOpenPositions(): Promise<unknown[]> {
    // Spot Binance : pas de "positions" à proprement parler (contrairement aux futures).
    // À étendre si le futures/margin trading est ajouté plus tard.
    return [];
  }
}
