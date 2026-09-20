import {
  ChallengeRules,
  ChallengeSnapshot,
  computeClosedPnl,
  computePayoutCapacity,
  evaluateChallenge,
  grossForTraderAmount,
  nextPhase,
  SIMULATED_FEE_RATE,
  validateChallengeOrder,
} from './challenge-rules';

const rules: ChallengeRules = {
  accountSize: 10000,
  profitTargetPct: 8,
  maxDailyLossPct: 5,
  maxTotalDrawdownPct: 10,
  minTradingDays: 4,
  maxDays: 30,
};

const start = new Date('2026-01-01T00:00:00Z');

function snap(over: Partial<ChallengeSnapshot> = {}): ChallengeSnapshot {
  return {
    phase: 'phase1',
    balance: 10000,
    equity: 10000,
    dayStartEquity: 10000,
    tradingDays: 0,
    openPositions: 0,
    phaseStartedAt: start,
    now: new Date('2026-01-05T12:00:00Z'),
    ...over,
  };
}

describe('evaluateChallenge', () => {
  it('reste actif tant qu aucune limite ni objectif n est atteint', () => {
    const v = evaluateChallenge(rules, snap({ balance: 10300, equity: 10300, dayStartEquity: 10300, tradingDays: 2 }));
    expect(v.status).toBe('active');
  });

  it('échoue sur la perte journalière (limite atteinte, borne incluse)', () => {
    const v = evaluateChallenge(rules, snap({ equity: 9500, dayStartEquity: 10000 })); // -5,00 %
    expect(v).toMatchObject({ status: 'failed', reason: 'max_daily_loss' });
  });

  it('ne déclenche pas la perte journalière juste sous la limite', () => {
    const v = evaluateChallenge(rules, snap({ equity: 9501, dayStartEquity: 10000 })); // -4,99 %
    expect(v.status).toBe('active');
  });

  it('échoue sur le drawdown total statique même si la perte du jour est faible', () => {
    // équité 9000 = -10 % du capital de départ, mais la journée a commencé à 9100 (-1,1 %)
    const v = evaluateChallenge(rules, snap({ equity: 9000, dayStartEquity: 9100 }));
    expect(v).toMatchObject({ status: 'failed', reason: 'max_total_drawdown' });
  });

  it('valide l objectif quand profit, jours minimum et compte à plat sont réunis', () => {
    const v = evaluateChallenge(rules, snap({ balance: 10800, equity: 10800, dayStartEquity: 10800, tradingDays: 4 }));
    expect(v.status).toBe('target_reached');
  });

  it('ne valide pas l objectif avant le nombre minimal de jours de trading', () => {
    const v = evaluateChallenge(rules, snap({ balance: 10900, equity: 10900, dayStartEquity: 10900, tradingDays: 3 }));
    expect(v.status).toBe('active');
    if (v.status === 'active') expect(v.metrics.tradingDaysMissing).toBe(1);
  });

  it('ne valide pas l objectif tant qu une position est ouverte (gain latent)', () => {
    const v = evaluateChallenge(
      rules,
      snap({ balance: 10800, equity: 10900, dayStartEquity: 10800, tradingDays: 5, openPositions: 1 }),
    );
    expect(v.status).toBe('active');
  });

  it('échoue à la limite de temps si l objectif n est pas atteint', () => {
    const v = evaluateChallenge(rules, snap({ now: new Date('2026-01-31T00:00:00Z'), tradingDays: 5 }));
    expect(v).toMatchObject({ status: 'failed', reason: 'time_limit' });
  });

  it('valide l objectif le dernier jour plutôt que d échouer sur le temps', () => {
    const v = evaluateChallenge(
      rules,
      snap({ balance: 10800, equity: 10800, dayStartEquity: 10800, tradingDays: 5, now: new Date('2026-01-31T00:00:00Z') }),
    );
    expect(v.status).toBe('target_reached');
  });

  it('une violation l emporte sur l objectif', () => {
    // équité repassée au vert mais perte du jour dépassée : le compte doit échouer
    const v = evaluateChallenge(
      rules,
      snap({ balance: 10800, equity: 10800, dayStartEquity: 11500, tradingDays: 5 }), // -6,1 % sur la journée
    );
    expect(v).toMatchObject({ status: 'failed', reason: 'max_daily_loss' });
  });

  it('un compte financé n a jamais d objectif ni de limite de temps', () => {
    const funded = { ...rules, profitTargetPct: 0, maxDays: null };
    const v = evaluateChallenge(
      funded,
      snap({ phase: 'funded', balance: 12000, equity: 12000, dayStartEquity: 12000, tradingDays: 50, now: new Date('2027-01-01T00:00:00Z') }),
    );
    expect(v.status).toBe('active');
  });

  it('un compte financé échoue quand même sur une violation', () => {
    const funded = { ...rules, profitTargetPct: 0, maxDays: null };
    const v = evaluateChallenge(funded, snap({ phase: 'funded', equity: 9000, dayStartEquity: 9100 }));
    expect(v).toMatchObject({ status: 'failed', reason: 'max_total_drawdown' });
  });
});

describe('nextPhase', () => {
  it('enchaîne phase1 → phase2 → funded puis s arrête', () => {
    expect(nextPhase('phase1')).toBe('phase2');
    expect(nextPhase('phase2')).toBe('funded');
    expect(nextPhase('funded')).toBeNull();
  });
});

describe('validateChallengeOrder', () => {
  const ok = { availableCash: 10000, equity: 10000, entryPrice: 5, qty: 100, stopLoss: 4.8, takeProfit: 5.5 };

  it('accepte un ordre valide', () => {
    expect(validateChallengeOrder(ok)).toBeNull(); // risque = 20 USDT = 0,2 %
  });

  it('refuse un ordre sans stop-loss ou avec un stop au-dessus de l entrée', () => {
    expect(validateChallengeOrder({ ...ok, stopLoss: 0 })).toMatch(/Stop-loss obligatoire/);
    expect(validateChallengeOrder({ ...ok, stopLoss: 5.2 })).toMatch(/sous le prix d'entrée/);
  });

  it('refuse un take-profit sous l entrée', () => {
    expect(validateChallengeOrder({ ...ok, takeProfit: 4.9 })).toMatch(/take-profit/);
  });

  it('refuse un achat supérieur au cash disponible (aucun levier)', () => {
    expect(validateChallengeOrder({ ...ok, qty: 3000 })).toMatch(/Liquidités insuffisantes/);
  });

  it('inclut les frais d entrée dans la vérification du cash', () => {
    // 2000 × 5 = 10000 exactement le cash, mais les frais (0,1 %) le font dépasser
    expect(validateChallengeOrder({ ...ok, qty: 2000, stopLoss: 4.999 })).toMatch(/Liquidités insuffisantes/);
  });

  it('plafonne le risque par trade à 3 % de l équité', () => {
    // risque = (5 - 4) × 400 = 400 USDT = 4 % de 10000
    expect(validateChallengeOrder({ ...ok, qty: 400, stopLoss: 4 })).toMatch(/Risque trop élevé/);
  });
});

describe('computeClosedPnl', () => {
  it('déduit les frais d entrée et de sortie', () => {
    const pnl = computeClosedPnl(5, 6, 100); // brut = 100
    const fees = (500 + 600) * SIMULATED_FEE_RATE; // 1,1
    expect(pnl).toBeCloseTo(100 - fees, 8);
  });

  it('un trade à plat perd les frais', () => {
    expect(computeClosedPnl(5, 5, 100)).toBeLessThan(0);
  });
});

describe('retraits', () => {
  it('aucun retrait possible avec une position ouverte', () => {
    const c = computePayoutCapacity({ accountSize: 10000, balance: 11000, openPositions: 1, profitSplitPct: 80 });
    expect(c).toEqual({ grossProfit: 0, traderShare: 0 });
  });

  it('aucun retrait sous le capital initial', () => {
    const c = computePayoutCapacity({ accountSize: 10000, balance: 9800, openPositions: 0, profitSplitPct: 80 });
    expect(c.traderShare).toBe(0);
  });

  it('la part du trader suit le partage des profits', () => {
    const c = computePayoutCapacity({ accountSize: 10000, balance: 11000, openPositions: 0, profitSplitPct: 80 });
    expect(c.grossProfit).toBe(1000);
    expect(c.traderShare).toBe(800);
  });

  it('retrouve le profit brut à retirer pour un montant trader donné', () => {
    expect(grossForTraderAmount(800, 80)).toBe(1000);
  });
});
