# Solana Memecoin Trading Cockpit

A production-grade automated trading bot for Solana memecoins with a cockpit-style web UI. Designed for resilience, observability, and continuous evaluation.

**⚠️ No claims of profitability. This is experimental software for educational purposes. Memecoin trading is extremely risky.**

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    COCKPIT UI                         │
│  Status Bar · Radar · Positions · Risk · Health       │
│  (cockpit.html — opens in any browser)                │
└────────────────────┬─────────────────────────────────┘
                     │ HTTP + WebSocket (port 3001)
┌────────────────────┴─────────────────────────────────┐
│                   BACKEND SERVICE                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Ingestion│→ │ Features │→ │ Strategy Engine   │   │
│  │ (Solana) │  │  Engine  │  │ (13 filters)      │   │
│  └──────────┘  └──────────┘  └───────┬──────────┘   │
│                                      │               │
│  ┌──────────────┐  ┌────────────────┴──────┐        │
│  │ Risk Governor│← │ Execution Module      │        │
│  │ (Kill Switch)│  │ (Paper / Live)        │        │
│  └──────────────┘  └──────────────────────┘        │
│                                                      │
│  ┌──────────────────────────────────────────┐       │
│  │ SQLite Database                            │       │
│  │ tokens · decisions · orders · positions    │       │
│  │ incidents · equity_history · idempotency   │       │
│  └──────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────┘
```

## Tech Stack

**TypeScript/Node.js** — chosen for:
- Native Solana Web3.js ecosystem
- Strong typing for complex financial logic
- Async I/O for websocket subscriptions
- Shared types between backend and frontend

## Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd solana-memecoin-bot
npm install

# 2. Configure (optional — safe defaults work out of box)
cp .env.example .env
# Edit RPC endpoint if desired

# 3. Start (PAPER mode by default)
npm run dev

# 4. Open cockpit
open http://localhost:3000/cockpit.html
# API at http://localhost:3001/api
```

The bot starts in **PAPER mode** with 10 SOL simulated equity. No real funds are at risk.

## Configuration

All settings controlled via `config/defaults.ts` and environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `PAPER` | PAPER or LIVE |
| `RPC_ENDPOINT` | mainnet-beta | Solana RPC URL |
| `RISK_PER_TRADE_PCT` | `0.2` | % of equity per trade |
| `MAX_EXPOSURE_PCT` | `1.0` | Max total exposure % |
| `DAILY_MAX_DRAWDOWN_PCT` | `2.0` | Kill switch threshold |
| `STOP_LOSS_PCT` | `25` | Hard stop-loss % |
| `TRAILING_STOP_PCT` | `15` | Trailing stop % |
| `MAX_TRADES_PER_DAY` | `10` | Daily trade limit |
| `PAPER_STARTING_EQUITY` | `10` | Starting paper SOL |

## Strategy Overview

**Philosophy: Trade rarely, filter aggressively, protect execution, cap downside, let rare winners run.**

### 13-Filter Pipeline

Every token must pass ALL 13 filters:

1. **Regime Gate** — Market must be active (score ≥ 40/100)
2. **Minimum Liquidity** — ≥ 5 SOL depth
3. **Holder Concentration** — Top 10 holders ≤ 70%
4. **Creator Behavior** — No suspicious dumping
5. **Token Permissions** — Mint/freeze authority revoked
6. **Buyer Breadth** — ≥ 3 unique buyers/min
7. **Buy Distribution** — Many small > few large
8. **Execution Risk** — Slippage ≤ 300bps
9. **Spread** — ≤ 500bps
10. **Graduation Timing** — 30-600s post-graduation window
11. **Buy Pressure** — Net positive
12. **Risk Limits** — All portfolio limits OK
13. **No Duplicate** — Not already in position

### Exit Strategy (Heavy-Tail Aware)

- **Take profit ladder**: Sell 30% at +50%, sell 30% at +100%
- **Trailing stop**: 15% from high water mark on remainder
- **Time stop**: Exit after 60 min with <10% gain
- **Hard stop-loss**: -25%

### Risk Governor (Hard Limits)

- Daily drawdown kill switch: 2%
- Max trades: 3/hour, 10/day
- Pause after 3 consecutive losses
- RPC health gate: halt if degraded

## Cockpit UI

The web UI provides full situational awareness:

- **Status Bar**: Mode (PAPER/LIVE), state, P&L, drawdown, exposure, kill switch
- **Overview**: Equity curve, regime indicator, rationale panel, alerts
- **Radar**: Live token feed with decision cards
- **Positions**: Open positions with P&L, stops, targets
- **Orders & Fills**: Execution history with slippage and fees
- **Risk & Limits**: Utilization gauges for all risk parameters
- **Health**: RPC latency, errors, incident timeline
- **Paper Stats**: Win rate, expectancy, slippage analysis

### Anti-Mode Confusion

Switching to LIVE requires:
1. Checklist confirmation
2. Type "TRADE LIVE" exactly
3. 10-second countdown with cancel option

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | System status, mode, risk, regime |
| GET | `/api/tokens` | Recent tokens discovered |
| GET | `/api/decisions` | Decision cards with reasoning |
| GET | `/api/positions` | Open positions |
| GET | `/api/orders` | Order/fill history |
| GET | `/api/risk` | Current risk state |
| GET | `/api/incidents` | Incident timeline |
| GET | `/api/equity` | Equity history |
| GET | `/api/paper/stats` | Paper trading statistics |
| POST | `/api/kill-switch` | Activate kill switch |
| POST | `/api/mode` | Switch PAPER/LIVE |
| POST | `/api/state` | Pause/resume bot |

WebSocket at `ws://localhost:3001/ws` for real-time updates.

## Testing

```bash
npx vitest run          # Run all tests
npx vitest --watch      # Watch mode
```

Tests cover: feature calculations, risk governor, filter pipeline, exit conditions, position sizing, idempotency, paper simulation, config validation.

## File Structure

```
├── config/defaults.ts           # Configuration with safe defaults
├── src/
│   ├── shared/types.ts          # All TypeScript interfaces
│   ├── backend/
│   │   ├── index.ts             # Main orchestrator
│   │   ├── api/server.ts        # HTTP + WebSocket API
│   │   ├── data/database.ts     # SQLite schema + queries
│   │   ├── data/ingestion.ts    # Solana event subscription
│   │   ├── features/engine.ts   # Feature engineering
│   │   ├── strategy/engine.ts   # 13-filter strategy
│   │   ├── strategy/risk-governor.ts  # Risk limits
│   │   └── paper/engine.ts      # Paper trading simulation
│   └── frontend/cockpit.html    # Complete cockpit UI
├── tests/bot.test.ts            # Test suite
├── docs/
│   ├── strategy.md              # Strategy documentation
│   ├── risk.md                  # Risk documentation
│   └── troubleshooting.md       # Troubleshooting guide
└── package.json
```

## Security

- Private keys are NEVER exposed to the UI
- Keys are never logged
- Wallet path only shows "***configured***" in API responses
- Use a **dedicated trading wallet** with only needed funds
- PAPER mode is default; LIVE requires explicit multi-step arming

## Disclaimer

This software is provided as-is for educational purposes. No guarantees of profitability. Memecoin trading carries extreme risk of total loss. The authors are not responsible for any financial losses. Always use paper trading first. Never risk more than you can afford to lose.
