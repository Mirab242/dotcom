import { Balance, Candle, OrderSide } from '@dot-trader/shared-types';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface PlaceOrderParams {
  symbol: string; // format unifié "DOT/USDT"
  side: OrderSide;
  type: 'market' | 'limit';
  amount: number;
  price?: number; // requis si type === 'limit'
  clientOrderId: string; // idempotence — généré côté plateforme (ex: orderId interne)
}

export interface ExchangeOrderResult {
  exchangeOrderId: string;
  status: string;
  filledAmount: number;
  averagePrice: number | null;
  raw: unknown;
}

/**
 * Interface commune à tous les connecteurs d'exchange.
 * En mode custodial, ces méthodes opèrent sur LE COMPTE DE LA PLATEFORME
 * (platform_exchange_accounts), jamais sur un compte utilisateur individuel.
 */
export interface ExchangeConnector {
  readonly exchangeName: string;
  readonly mode: 'testnet' | 'live';

  getBalance(): Promise<Balance[]>;
  getCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<Candle[]>;
  placeOrder(params: PlaceOrderParams): Promise<ExchangeOrderResult>;
  fetchOrderStatus(exchangeOrderId: string, symbol: string): Promise<ExchangeOrderResult>;
  cancelOrder(exchangeOrderId: string, symbol: string): Promise<void>;
  getOpenPositions(): Promise<unknown[]>;
  /** Vérifie que les clés API sont valides, en lecture seule — utilisé avant toute activation. */
  testConnection(): Promise<boolean>;
}
