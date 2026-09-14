# DOT Trader — Architecture technique

Plateforme de trading crypto modulaire : User Dashboard + Trading Engine + Bot IA + Risk Management + Backtesting + Exchange API + Admin Dashboard + Sécurité + Monétisation.

Point de départ fonctionnel : **DOT/USDT**. L'architecture doit permettre d'ajouter BTC, ETH, SOL, etc. sans réécriture — chaque module traite un "symbole" en paramètre, jamais en dur.

> ⚠️ **Avertissement** : ce document couvre l'exécution réelle d'ordres sur des exchanges avec de l'argent réel. Prévoir dès le départ un **mode "paper trading" / testnet** activé par défaut, un **kill switch** admin global, et se renseigner sur le cadre réglementaire (statut PSAN/CASP selon juridiction) avant d'activer le trading automatique réel ou la commission sur trades pour des utilisateurs tiers.

---

## 1. Principes directeurs

1. **Un seul moteur, deux usages** — le code qui calcule indicateurs/signaux/décisions est *identique* en live trading et en backtesting. On ne duplique jamais la logique : le backtester rejoue des bougies historiques à travers le même moteur que le live.
2. **Le risque avant le signal** — aucun ordre ne part sans être passé par le module Risk Management (taille de position, limites de perte, drawdown). Le Risk Manager peut **rejeter** un trade même si le signal est bon.
3. **Abstraction des exchanges** — aucun module métier ne parle directement à Binance/Bybit/etc. Tout passe par une interface `ExchangeConnector` commune (via CCXT). Ajouter un exchange = ajouter un connecteur, pas modifier le moteur.
4. **Défaut = ne pas trader** — le moteur doit pouvoir conclure "conditions insuffisantes" et s'abstenir. C'est un résultat valide, pas une erreur.
5. **Traçabilité totale** — chaque décision (signal généré, trade validé/rejeté, paramètre modifié par un admin) est journalisée (audit log immuable).
6. **Secrets jamais en clair** — clés API exchange chiffrées au repos, jamais renvoyées en clair au frontend, jamais loguées.

---

## 2. Stack technique

| Couche | Choix | Pourquoi |
|---|---|---|
| Frontend web | **Next.js 14 (React, TypeScript)** + TailwindCSS | SSR pour le dashboard, écosystème riche pour les graphiques temps réel |
| Graphiques | **TradingView Lightweight Charts** | Standard du secteur, léger, gère bougies + indicateurs + dessin SL/TP |
| Backend API | **NestJS (Node.js, TypeScript)** | Architecture modulaire par design (modules/providers/DI) — colle exactement au besoin "plateforme modulaire" |
| Base de données | **PostgreSQL** + extension **TimescaleDB** | Relationnel/ACID pour comptes, ordres, abonnements ; TimescaleDB pour les séries temporelles (bougies, ticks) à grande échelle |
| Cache / Pub-Sub / Files | **Redis** + **BullMQ** | Files de jobs (exécution d'ordres, boucle du bot, backtests longs), pub/sub pour pousser les prix en websocket |
| Temps réel | **WebSocket (Socket.IO)** côté serveur ↔ client | Prix live, mise à jour de positions, notifications |
| Connecteurs exchange | **CCXT** (+ WebSocket natif de l'exchange si besoin de latence) | Unifie l'accès à 100+ exchanges (REST + partiellement WS), évite de réécrire un client par exchange |
| Indicateurs techniques | Lib maison au-dessus de **technicalindicators** (npm) | RSI/MACD/EMA/ATR/volume ; encapsulés pour rester testables et communs live/backtest |
| Auth | **JWT** (access + refresh) + **TOTP** (2FA, lib `otplib`) | Standard, compatible mobile futur |
| Chiffrement clés API | **AES-256-GCM**, clé maîtresse en **KMS/Vault** (ou variable d'env chiffrée en attendant) | Chiffrement enveloppe : chaque clé exchange est chiffrée avec une DEK, elle-même chiffrée par la clé maîtresse |
| Paiements / Abonnements | **Stripe** (Billing + Webhooks) | Gère abonnements, essais, codes promo, factures nativement |
| Notifications | WebSocket (in-app) + **email** (Resend/SES) + **push web** (dès que mobile existera : FCM) | |
| Monorepo | **pnpm workspaces** (+ Turborepo) | Partager `trading-engine` et les types entre `apps/web`, `apps/api`, et un futur `apps/bot-worker` |
| Déploiement | Docker Compose (dev) → conteneurs séparés (web / api / worker / postgres / redis) en prod | Le worker (bot + backtests) doit pouvoir scaler indépendamment de l'API |

---

## 3. Structure du monorepo

```
dot-trader/
├── apps/
│   ├── web/                # Next.js — dashboard user + admin (routes /admin/*)
│   ├── api/                # NestJS — REST + WebSocket gateway, auth, CRUD
│   └── worker/             # Process séparé — boucle du bot, exécution d'ordres, backtests (BullMQ)
├── packages/
│   ├── trading-engine/     # Indicateurs, signaux, scoring — pur, sans I/O, 100% testable
│   ├── exchange-connectors/# Wrapper CCXT + interface ExchangeConnector commune
│   ├── risk-engine/        # Position sizing, SL/TP, drawdown, kill switch
│   ├── shared-types/       # DTOs / types TypeScript partagés (Signal, Order, Position, Strategy…)
│   └── config/             # ESLint/TSConfig partagés
├── docs/
│   └── ARCHITECTURE.md     # ce document
└── docker-compose.yml
```

**Pourquoi séparer `worker` de `api`** : le bot automatique et les backtests sont des charges longues/CPU-intensives. Les isoler évite qu'un backtest lourd ne ralentisse l'API que consultent les utilisateurs, et permet de scaler/redémarrer le bot indépendamment (utile pour le kill switch admin : couper `worker` sans couper le site).

---

## 4. Modules fonctionnels

### 4.1 Espace utilisateur (`apps/api` → `UserModule`, `WalletModule`)
**Modèle retenu : custodial.** La plateforme détient les fonds ; l'utilisateur a un **solde interne** (ledger), pas ses propres clés API exchange. Voir §4.6bis pour le détail du wallet custodial.
- Inscription/connexion, profil, préférences (devise d'affichage, thème)
- Portefeuille : solde disponible / solde bloqué (en position), par devise, tenu dans `wallets` (source de vérité interne — ne reflète pas directement le compte Binance de la plateforme)
- Historique : trades, dépôts/retraits, changements de paramètres
- Dépôt : l'utilisateur obtient une adresse (ou une référence, si dépôt manuel — voir §4.6bis) ; retrait : demande soumise à validation (règles anti-fraude + double validation admin au-delà d'un seuil)

### 4.2 Marché & données (`MarketDataModule`)
- Ingestion des bougies (OHLCV) multi-timeframes (1m/5m/15m/1h/4h/1D) par symbole, via CCXT + websocket exchange
- Stockage TimescaleDB (hypertable par symbole/timeframe)
- Normalisation : toujours le même format `Candle{ts, open, high, low, close, volume}` quel que soit l'exchange source
- Cache Redis des dernières bougies pour accès rapide par le moteur

### 4.3 Moteur de trading (`packages/trading-engine`)
Pipeline pur (entrée : bougies multi-timeframes → sortie : `Signal | null`) :
1. **Contexte multi-timeframe** : tendance sur timeframe supérieur (ex. 4h) pour filtrer les trades du timeframe d'exécution (ex. 15m)
2. **Indicateurs** : EMA (tendance), RSI (momentum/surachat-survente), MACD (momentum/croisements), ATR (volatilité → sert au SL et au sizing), volume (confirmation)
3. **Structure de marché** : détection supports/résistances (swing highs/lows), cassures, zones de liquidité
4. **Agrégation en score de confiance** (0–100) : chaque critère pondéré (tendance alignée, RSI non extrême, MACD confirmé, volume suffisant, R:R correct) contribue au score
5. **Décision** : si score < seuil configurable → `null` (pas de trade). Sinon → `Signal{side, entry, sl, tp[], rr, confidence, reasons[]}`
6. Le champ `reasons[]` est important : l'utilisateur (mode assisté) et l'admin doivent voir *pourquoi* le signal a été généré, pas une boîte noire.

### 4.4 Modes de trading (`TradingModule`)
- **Manuel** : l'utilisateur passe l'ordre lui-même depuis l'interface (le moteur peut quand même afficher les indicateurs en overlay, sans imposer de signal)
- **Assisté** : le moteur génère un `Signal`, l'utilisateur voit entrée/SL/TP/RR/score, clique "Valider" → passe par le Risk Engine → exécution
- **Automatique** : un `BotInstance` (lié à une `Strategy` + un `RiskProfile`) tourne dans `apps/worker`, consomme les signaux du moteur et exécute sans validation humaine, dans les limites fixées par le Risk Engine et les garde-fous admin

### 4.5 Gestion du risque (`packages/risk-engine`)
- **Position sizing** : `taille = (capital × %risque) / (distance entrée→SL)` — jamais une taille fixe
- Stop-loss obligatoire à l'ouverture (dérivé de l'ATR ou de la structure, jamais "aucun SL")
- Take-profits multiples (TP1/TP2/TP3) avec règles de sortie partielle
- Break-even automatique après TP1
- Trailing stop (basé ATR ou %) 
- Limites : perte max par trade, perte max journalière, drawdown max du compte → au-delà, le Risk Engine **bloque tout nouveau trade** (et alerte l'admin)
- **Kill switch** : un flag global (par utilisateur ou plateforme entière) que l'admin peut activer pour stopper instantanément tout trading automatique

### 4.6 Exécution & connecteurs exchange (`packages/exchange-connectors`)
- Interface commune : `getBalance()`, `getCandles()`, `placeOrder()`, `cancelOrder()`, `getOpenPositions()`
- **Exchange retenu : Binance** (via CCXT). Tests sur **Binance Spot Testnet** avant tout mode réel.
- Important en modèle custodial : les clés API Binance appartiennent à **la plateforme**, pas à l'utilisateur — un seul (ou quelques) compte(s) Binance exécutent les trades de tous les utilisateurs. La répartition du P&L par utilisateur se fait dans le ledger interne (`wallets`, `positions`), pas côté Binance.
- File d'attente (BullMQ) pour les ordres → retry avec backoff, idempotence (éviter le double envoi d'ordre en cas de reconnexion)

### 4.6bis Garde des fonds — module le plus sensible (`CustodyModule`)
> C'est la partie la plus risquée de toute la plateforme (sécurité **et** légale). À ne construire qu'une fois les phases 0–4 validées en testnet, et **jamais en argent réel avant d'avoir clarifié le statut réglementaire** (§8).

Deux approches possibles, du plus simple au plus automatisé — recommandation : **commencer par l'option A**, migrer vers B seulement si le volume le justifie.

**Option A — Dépôt/retrait semi-manuel (recommandé pour démarrer)**
- L'utilisateur dépose par un moyen déjà maîtrisé (mobile money, virement, ou transfert crypto vers **une adresse unique de la plateforme**, avec un mémo/référence à indiquer)
- Un admin (ou un job automatique qui surveille la blockchain/l'API bancaire) rapproche le dépôt et **crédite le `wallet` interne** de l'utilisateur
- Retrait : demande utilisateur → validation admin (+ 2FA) → exécution manuelle ou semi-automatique
- Avantage : pas de gestion de wallets individuels, pas de clé privée par utilisateur, surface d'attaque minimale, réutilise vos flux mobile money existants (Seer Power/Transporteur)
- Inconvénient : latence de crédit, charge opérationnelle admin

**Option B — Dépôts/retraits on-chain automatisés**
- Génération d'une adresse de dépôt par utilisateur (via le node/API de chaque réseau, ou un prestataire type Fireblocks/BitGo/Copper qui gère la sécurité des clés pour vous)
- Détection automatique des dépôts (webhooks d'un provider comme Alchemy/Moralis/BlockCypher, ou nœud dédié) → crédit automatique du `wallet`
- Retraits automatisés avec règles (plafonds, délai de sécurité, 2FA, approbation multi-signature au-delà d'un seuil)
- Nécessite une vraie architecture **hot wallet / cold wallet**, un processus de sécurité des clés privées (HSM ou prestataire), et quasi certainement une licence VASP/PSAN dans la plupart des juridictions dès que vous détenez des fonds de tiers à grande échelle

### 4.7 Backtesting (`apps/worker` → `BacktestModule`)
- Rejoue l'historique de bougies à travers `trading-engine` + `risk-engine` tels quels (aucune logique dupliquée)
- Sortie : courbe d'equity, win rate, profit factor, max drawdown, R moyen, liste des trades simulés
- Interface web pour lancer un backtest (symbole, période, stratégie, paramètres de risque) et visualiser le rapport

### 4.8 Bot IA / Stratégies (`StrategyModule`)
- Une `Strategy` = un ensemble de paramètres (poids des critères, seuils RSI, timeframes utilisés, seuil de score minimum) — versionnée, activable/désactivable
- Possibilité de stratégies multiples en parallèle (une par bot instance), chacune avec son propre risk profile
- "IA" au sens scoring/heuristique pondérée pour la V1 ; une vraie composante ML (classification du set-up, réentraînement sur l'historique) est un axe d'évolution (§9), pas un prérequis du MVP

### 4.9 Dashboard Admin (`apps/web/admin`)
- Utilisateurs (recherche, suspension, réinitialisation 2FA)
- Cryptos disponibles (activer/désactiver un symbole, ses timeframes)
- Stratégies (créer/éditer/versionner, assigner à des utilisateurs/plans)
- Paramètres de risque par défaut et plafonds globaux (un utilisateur ne peut jamais dépasser le plafond admin)
- Bots (voir tous les `BotInstance` actifs, les arrêter individuellement ou globalement — **kill switch**)
- Statistiques plateforme (volumes, performance agrégée, revenus)
- Logs & audit (filtrable par utilisateur/action/date)
- Feature flags (activer/désactiver mode auto, tel exchange, telle fonctionnalité premium)

### 4.10 Sécurité (`SecurityModule`, transverse)
- 2FA obligatoire pour : activation du trading réel, retrait, modification des clés API
- RBAC : rôles `user`, `admin`, `superadmin` avec permissions granulaires (pas juste un booléen `isAdmin`)
- Chiffrement enveloppe des clés API exchange (voir §2)
- Rate limiting par IP/utilisateur sur les endpoints sensibles
- Audit log immuable (append-only) : qui a fait quoi, quand, depuis quelle IP

### 4.11 Notifications (`NotificationsModule`)
- Événements : signal généré, ordre exécuté, SL/TP touché, drawdown proche de la limite, kill switch activé
- Canaux : in-app (WebSocket), email ; push mobile prévu quand l'app mobile existera
- Préférences par utilisateur (quels événements, quel canal)

### 4.12 Monétisation (`BillingModule`)
- **Abonnements** : plans `Basic / Pro / Premium` définis en base (nom, prix, fonctionnalités incluses) — gérés par l'admin, pas en dur dans le code
- Intégration Stripe Billing : checkout, webhooks (paiement réussi/échoué, annulation), synchronisation du statut d'abonnement
- **Feature gating** : middleware qui vérifie le plan de l'utilisateur avant d'autoriser l'accès (ex. trading auto = Pro+, backtesting illimité = Premium)
- **Commission sur trading** : champ configurable par l'admin (%), appliqué et enregistré à l'exécution — *à activer seulement après validation du cadre réglementaire applicable*
- **Affiliation** : code de parrainage unique par utilisateur, table `referrals` (parrain, filleul, statut, récompense), règles de récompense configurables par l'admin
- **Codes promo** : gérés côté Stripe ou table interne, appliqués au checkout
- Statistiques de revenus dans le dashboard admin (MRR, churn, revenus par plan)

---

## 5. Modèle de données (vue d'ensemble)

Tables principales (PostgreSQL) :

```
users                 (id, email, password_hash, role, two_fa_secret, status, created_at)
platform_exchange_accounts (id, exchange[binance], api_key_encrypted, api_secret_encrypted, mode[testnet|live], status)
  -- comptes exchange de LA PLATEFORME (custodial) — jamais de clé API appartenant à un utilisateur
wallets                (id, user_id, currency, available_balance, locked_balance, updated_at)
  -- solde interne (ledger) de chaque utilisateur — source de vérité côté produit
deposits               (id, user_id, currency, network|null, amount, method[manual|onchain], reference, status[pending|credited|rejected], credited_by_admin_id|null, tx_hash|null, created_at)
withdrawals            (id, user_id, currency, amount, destination, status[pending|approved|sent|rejected], approved_by_admin_id|null, tx_hash|null, created_at)
ledger_entries          (id, wallet_id, type[deposit|withdrawal|trade_pnl|fee|adjustment], amount, ref_id, ref_table, created_at)
  -- traçabilité comptable complète de chaque mouvement de wallet, indépendante des tables métier
symbols               (id, code[DOT/USDT], base, quote, enabled, min_size, ...)
candles                → table Timescale hypertable (symbol_id, timeframe, ts, o, h, l, c, v)
strategies            (id, name, version, params_json, enabled)
risk_profiles         (id, user_id|null[=défaut plateforme], max_risk_pct, max_daily_loss, max_drawdown, ...)
bot_instances         (id, user_id, strategy_id, risk_profile_id, symbol_id, status[running|stopped|killed])
signals                (id, symbol_id, strategy_id, side, entry, sl, tp_json, rr, confidence, reasons_json, created_at)
orders                (id, user_id, platform_exchange_account_id, signal_id|null, symbol_id, side, type, qty, price, status, mode[manual|assisted|auto])
positions              (id, user_id, symbol_id, side, entry_avg, qty, sl, tp_json, status[open|closed], pnl)
trades                 (id, position_id, closed_at, exit_price, pnl, r_multiple)
backtests              (id, user_id, strategy_id, symbol_id, period_from, period_to, results_json, status)
plans                  (id, name, price, interval, features_json)
subscriptions          (id, user_id, plan_id, stripe_subscription_id, status, current_period_end)
referrals              (id, referrer_id, referred_id, status, reward_json)
promo_codes            (id, code, discount, valid_from, valid_to, usage_limit)
audit_logs             (id, actor_id, action, target, metadata_json, ip, created_at)
notifications          (id, user_id, type, payload_json, read_at, created_at)
```

---

## 6. Flux clé : du signal à l'ordre exécuté

```
MarketDataModule (bougies live)
        │
        ▼
trading-engine.analyze(symbol, timeframes)
        │  → Signal | null
        ▼
   ┌─────────────┐
   │ Mode manuel │ → l'utilisateur choisit tout, le moteur sert juste d'affichage
   └─────────────┘
   ┌─────────────┐
   │Mode assisté │ → Signal affiché → validation utilisateur → risk-engine.evaluate()
   └─────────────┘
   ┌─────────────┐
   │Mode auto    │ → risk-engine.evaluate() directement, sans validation humaine
   └─────────────┘
        │
        ▼
risk-engine.evaluate(signal, riskProfile, accountState)
   → rejette si drawdown/limite atteinte
   → sinon calcule la taille de position
        │
        ▼
exchange-connectors.placeOrder(...)   (file BullMQ, idempotent, retry)
        │
        ▼
orders / positions mis à jour + notification + audit log
```

---

## 7. Roadmap proposée (phasage)

| Phase | Contenu | Objectif |
|---|---|---|
| **0 — Fondations** | Monorepo, auth + 2FA, RBAC, base de données, `ExchangeConnector` en testnet | Squelette utilisable et sécurisé |
| **1 — Marché & manuel** | `MarketDataModule`, graphiques live, trading manuel sur DOT/USDT (testnet) | L'utilisateur peut voir le marché et trader manuellement |
| **2 — Moteur & assisté** | `trading-engine` (indicateurs, score, signal), mode assisté | Le cœur "intelligence" du produit |
| **3 — Risque & auto** | `risk-engine`, position sizing, SL/TP/BE/trailing, mode automatique, kill switch | Trading automatique sûr |
| **4 — Backtesting** | Rejeu historique, rapport de performance | Valider les stratégies avant de les activer en réel |
| **5 — Admin** | Dashboard admin complet (users, stratégies, risque, bots, stats, logs) | Opérabilité et supervision |
| **6 — Monétisation** | Abonnements Stripe, feature gating, affiliation, codes promo | Revenus |
| **7 — Extension** | Ajout BTC/ETH/SOL, exchanges supplémentaires, notifications mobiles, ML avancé | Scale |

Chaque phase est livrable et testable seule — on ne commence pas le trading réel avant d'avoir validé phases 0 à 4 en testnet/backtest.

---

## 8. Décisions

1. ~~Custodial ou non ?~~ **Tranché : custodial.** Voir §4.1 et §4.6bis pour l'architecture (wallet interne + dépôt/retrait semi-manuel en option A pour démarrer). C'est le choix qui porte le plus de risque légal et sécuritaire du projet — d'où l'option A (semi-manuel) recommandée pour la V1, qui évite de construire une infrastructure de garde de clés on-chain avant d'avoir un statut légal clair.
2. ~~Quel exchange en premier ?~~ **Tranché : Binance** (via CCXT, Binance Spot Testnet pour le développement).
3. **Cadre légal — encore ouvert.** Juridiction pas encore choisie ("à explorer ensemble"). Tant que ce n'est pas tranché, le plan est : construire les phases 0–4 entièrement en **testnet/backtest** (aucun fonds réel, aucune garde de fonds tiers), ce qui ne nécessite aucune licence. La bascule vers du réel (dépôts, retraits, commission sur trades pour des tiers) est explicitement gardée derrière un flag et attend cette décision — je ne l'activerai pas sans confirmation explicite de votre part une fois la structure légale connue.
4. ~~Hébergement — VPS obligatoire ?~~ **Réponse : pas besoin de gérer un VPS vous-même.** Ce genre de stack (Node.js + Postgres + Redis + workers) ne tourne pas sur du mutualisé cPanel classique, mais je peux le déployer et le maintenir sur une **plateforme managée** (Railway, Render ou Fly.io) : ce sont des VPS "sous le capot", mais administrés via dashboard/CLI — pas de SSH, pas de mises à jour serveur à faire, je peux gérer le déploiement et la configuration pour vous. Coût de départ : quelques dollars/mois en dev, évolutif selon le trafic. Alternative encore plus simple pour démarrer : tout faire tourner **en local sur votre machine** pendant les phases 0–2 (testnet, pas d'utilisateurs réels), et ne passer en hébergement managé qu'à l'approche de la mise en production.

---

## 9. Évolutions futures (hors MVP)

- Composante ML (classification de set-ups, réentraînement périodique) en remplacement/complément du scoring pondéré
- App mobile (Flutter, cohérent avec vos autres projets) consommant la même API NestJS
- Copy-trading entre utilisateurs
- Multi-exchange simultané par utilisateur avec agrégation de portefeuille
