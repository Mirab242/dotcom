import { MAX_RISK_PERCENT_PER_TRADE } from './position-sizing';

/**
 * Règles d'un challenge "prop firm" — logique PURE (aucune dépendance base de données ni exchange),
 * pour rester testable seule et réutilisable par l'API et le worker. Toutes les valeurs monétaires
 * sont en USDT simulés : un compte de challenge ne détient jamais de vrais fonds (voir §4.6bis).
 *
 * Format : 2 phases d'évaluation puis un compte financé.
 *   phase1 → objectif de profit (ex. 8 %) → phase2 (ex. 5 %) → funded (plus d'objectif, retraits possibles)
 * À chaque changement de phase le compte repart de sa taille initiale (standard des prop firms).
 */

export type ChallengePhase = 'phase1' | 'phase2' | 'funded';

/** Frais de trading simulés par côté (0,1 % = frais spot Binance standard). */
export const SIMULATED_FEE_RATE = 0.001;

export interface ChallengeRules {
  /** Capital simulé de départ de chaque phase. */
  accountSize: number;
  /** Objectif de profit de la phase COURANTE en % du capital de départ (0 pour "funded"). */
  profitTargetPct: number;
  /** Perte max sur une journée UTC, en % de l'équité au début du jour. */
  maxDailyLossPct: number;
  /** Drawdown max total, en % du capital de départ de la phase (statique, pas glissant). */
  maxTotalDrawdownPct: number;
  /** Nombre minimal de jours de trading distincts avant de pouvoir valider l'objectif. */
  minTradingDays: number;
  /** Durée max de la phase en jours (null = illimitée). */
  maxDays: number | null;
}

export interface ChallengeSnapshot {
  phase: ChallengePhase;
  /** Solde réalisé (trades fermés uniquement). */
  balance: number;
  /** Solde + résultat latent des positions ouvertes, au dernier prix. */
  equity: number;
  /** Équité au début du jour UTC courant. */
  dayStartEquity: number;
  /** Jours UTC distincts où au moins un trade a été ouvert dans la phase. */
  tradingDays: number;
  openPositions: number;
  phaseStartedAt: Date;
  now: Date;
}

export type ChallengeBreach = 'max_daily_loss' | 'max_total_drawdown' | 'time_limit';

export interface ChallengeMetrics {
  profitPct: number;
  equityProfitPct: number;
  dailyLossPct: number;
  totalDrawdownPct: number;
  daysElapsed: number;
  tradingDaysMissing: number;
}

export type ChallengeVerdict =
  | { status: 'active'; metrics: ChallengeMetrics }
  | { status: 'failed'; reason: ChallengeBreach; metrics: ChallengeMetrics }
  | { status: 'target_reached'; metrics: ChallengeMetrics };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function nextPhase(phase: ChallengePhase): ChallengePhase | null {
  if (phase === 'phase1') return 'phase2';
  if (phase === 'phase2') return 'funded';
  return null;
}

export function computeMetrics(rules: ChallengeRules, s: ChallengeSnapshot): ChallengeMetrics {
  const start = rules.accountSize;
  const profitPct = start > 0 ? ((s.balance - start) / start) * 100 : 0;
  const equityProfitPct = start > 0 ? ((s.equity - start) / start) * 100 : 0;
  const dailyLossPct = s.dayStartEquity > 0 ? Math.max(0, ((s.dayStartEquity - s.equity) / s.dayStartEquity) * 100) : 0;
  const totalDrawdownPct = start > 0 ? Math.max(0, ((start - s.equity) / start) * 100) : 0;
  const daysElapsed = Math.floor((s.now.getTime() - s.phaseStartedAt.getTime()) / MS_PER_DAY);
  return {
    profitPct,
    equityProfitPct,
    dailyLossPct,
    totalDrawdownPct,
    daysElapsed,
    tradingDaysMissing: Math.max(0, rules.minTradingDays - s.tradingDays),
  };
}

/**
 * Verdict d'un compte de challenge. Ordre volontaire : les violations passent AVANT l'objectif
 * (un compte qui a dépassé sa perte max échoue même s'il est repassé au vert), et l'objectif
 * passe avant la limite de temps (atteindre l'objectif le dernier jour valide la phase).
 * Un compte "funded" ne peut jamais "réussir" : il n'a que des violations possibles.
 */
export function evaluateChallenge(rules: ChallengeRules, s: ChallengeSnapshot): ChallengeVerdict {
  const metrics = computeMetrics(rules, s);

  if (metrics.dailyLossPct >= rules.maxDailyLossPct) {
    return { status: 'failed', reason: 'max_daily_loss', metrics };
  }
  if (metrics.totalDrawdownPct >= rules.maxTotalDrawdownPct) {
    return { status: 'failed', reason: 'max_total_drawdown', metrics };
  }

  if (s.phase !== 'funded') {
    const targetMet =
      metrics.profitPct >= rules.profitTargetPct &&
      s.openPositions === 0 && // pas de "victoire" sur un gain latent qui peut encore s'évaporer
      s.tradingDays >= rules.minTradingDays;
    if (targetMet) return { status: 'target_reached', metrics };

    if (rules.maxDays !== null && metrics.daysElapsed >= rules.maxDays) {
      return { status: 'failed', reason: 'time_limit', metrics };
    }
  }

  return { status: 'active', metrics };
}

// --- Ordres simulés -------------------------------------------------------------------------

export interface ChallengeOrderCheck {
  /** Liquidités disponibles = solde réalisé − capital déjà engagé dans les positions ouvertes. */
  availableCash: number;
  equity: number;
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit?: number | null;
}

/**
 * Valide l'ouverture d'une position long simulée. Retourne un message d'erreur, ou null si valide.
 * Mêmes principes que le compte réel (§4.5) : stop-loss obligatoire, risque par trade plafonné
 * à MAX_RISK_PERCENT_PER_TRADE, et aucun levier (un challenge ne peut pas acheter plus que son cash).
 */
export function validateChallengeOrder(o: ChallengeOrderCheck): string | null {
  if (!isFinite(o.qty) || o.qty <= 0) return 'Quantité invalide';
  if (!isFinite(o.entryPrice) || o.entryPrice <= 0) return 'Prix de marché indisponible';
  if (!isFinite(o.stopLoss) || o.stopLoss <= 0) return 'Stop-loss obligatoire';
  if (o.stopLoss >= o.entryPrice) return 'Le stop-loss doit être sous le prix d\'entrée (positions long uniquement)';
  if (o.takeProfit != null && o.takeProfit <= o.entryPrice) return 'Le take-profit doit être au-dessus du prix d\'entrée';

  const notional = o.qty * o.entryPrice;
  const entryFee = notional * SIMULATED_FEE_RATE;
  if (notional + entryFee > o.availableCash) return 'Liquidités insuffisantes (pas de levier sur un challenge)';

  const riskAmount = (o.entryPrice - o.stopLoss) * o.qty;
  const maxRisk = o.equity * (MAX_RISK_PERCENT_PER_TRADE / 100);
  if (riskAmount > maxRisk) {
    return `Risque trop élevé : ${((riskAmount / o.equity) * 100).toFixed(2)} % de l'équité (maximum ${MAX_RISK_PERCENT_PER_TRADE} % par trade)`;
  }
  return null;
}

/** Résultat net d'une position long fermée, frais d'entrée et de sortie inclus. */
export function computeClosedPnl(entryPrice: number, exitPrice: number, qty: number): number {
  const gross = (exitPrice - entryPrice) * qty;
  const fees = (entryPrice * qty + exitPrice * qty) * SIMULATED_FEE_RATE;
  return gross - fees;
}

/** Résultat latent (frais de sortie estimés déduits) — utilisé pour l'équité en temps réel. */
export function computeUnrealizedPnl(entryPrice: number, lastPrice: number, qty: number): number {
  const gross = (lastPrice - entryPrice) * qty;
  const fees = (entryPrice * qty + lastPrice * qty) * SIMULATED_FEE_RATE;
  return gross - fees;
}

// --- Retraits (comptes financés) ------------------------------------------------------------

export interface PayoutInput {
  accountSize: number;
  balance: number;
  openPositions: number;
  profitSplitPct: number;
}

export interface PayoutCapacity {
  /** Profit réalisé disponible (brut, avant partage). */
  grossProfit: number;
  /** Part du trader = grossProfit × profitSplitPct. */
  traderShare: number;
}

/** Un retrait n'est possible que sur le profit réalisé, compte à plat, au-dessus du capital initial. */
export function computePayoutCapacity(p: PayoutInput): PayoutCapacity {
  if (p.openPositions > 0) return { grossProfit: 0, traderShare: 0 };
  const grossProfit = Math.max(0, p.balance - p.accountSize);
  return { grossProfit, traderShare: grossProfit * (p.profitSplitPct / 100) };
}

/** Profit brut à retirer du solde simulé pour verser `traderAmount` au trader. */
export function grossForTraderAmount(traderAmount: number, profitSplitPct: number): number {
  return traderAmount / (profitSplitPct / 100);
}
