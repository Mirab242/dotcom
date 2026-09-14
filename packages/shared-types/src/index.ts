// Types et enums partagés entre apps/api, apps/web et apps/worker.
// Aucune dépendance à NestJS/Prisma ici : ce package reste consommable partout (front compris).

export enum Role {
  USER = 'user',
  ADMIN = 'admin',
}

export enum TradingMode {
  MANUAL = 'manual',
  ASSISTED = 'assisted',
  AUTO = 'auto',
}

export enum OrderSide {
  BUY = 'buy',
  SELL = 'sell',
}

export enum OrderStatus {
  PENDING = 'pending',
  OPEN = 'open',
  FILLED = 'filled',
  CANCELLED = 'cancelled',
  REJECTED = 'rejected',
}

export enum PositionStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export interface Candle {
  ts: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  symbol: string;
  side: OrderSide;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  riskRewardRatio: number;
  confidence: number; // 0-100
  reasons: string[];
  createdAt: string;
}

export interface Balance {
  currency: string;
  free: number;
  used: number;
  total: number;
}

// Marchés actifs de la plateforme (§ roadmap Phase 7). Toute route qui accepte un symbole
// en entrée doit le restreindre à cette liste (@IsIn) — un symbole non contraint transite
// vers l'admin (ordres, bots, positions) et devient un vecteur XSS stocké si rendu sans
// échappement côté frontend.
export const SUPPORTED_SYMBOLS = ['DOT/USDT', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT'] as const;
