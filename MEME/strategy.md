# Strategy Documentation

## Philosophy

**Trade rarely, filter aggressively, protect execution, cap downside, let rare winners run.**

This is a survivability-first memecoin strategy. Most memecoins go to zero. Alpha decays rapidly. The edge comes from extreme selectivity and disciplined risk management.

## Decision Pipeline

```
Token Event → Feature Computation → 13 Filters → Risk Check → Execution → Position Mgmt
```

ALL 13 filters must pass. One failure = SKIP.

## Regime Gate

Only trades when Pump.fun ecosystem is active. Measured by launch rate, volume proxy, and graduation rate. Score 0-100, threshold: 40.

## 13 Filters

1. **Regime Gate** (score ≥ 40) — no trading in dead markets
2. **Min Liquidity** (≥ 5 SOL) — avoid illiquid traps
3. **Concentration** (top 10 ≤ 70%) — reduce rug risk
4. **Creator Behavior** — no early dumping
5. **Token Permissions** — mint/freeze revoked
6. **Buyer Breadth** (≥ 3/min) — organic demand
7. **Buy Distribution** (score ≥ 0.3) — many small > few whales
8. **Execution Risk** (slippage ≤ 300bps) — protect execution
9. **Spread** (≤ 500bps) — sufficient liquidity
10. **Graduation Timing** (30-600s) — avoid chaos, don't chase
11. **Buy Pressure** (net positive) — active buying
12. **Risk Limits** — all portfolio limits clear
13. **No Duplicate** — one position per token

## Exit Strategy (Heavy-Tail Aware)

- **Take-profit**: Sell 30% at +50%, sell 30% at +100%
- **Trailing stop**: 15% from high water mark on remainder
- **Time stop**: Exit after 60 min with <10% gain
- **Hard stop-loss**: -25%

## Position Sizing

- Risk per trade: 0.2% of equity
- Max exposure: 1.0% of equity
- No leverage
- At -25% stop, max loss ≈ 0.05% of equity per trade

## Known Limitations

1. Feature quality depends on event data quality and RPC reliability
2. Concentration estimates are approximate (no direct holder API in real-time)
3. Price simulation in paper mode uses random walk, not real market microstructure
4. Strategy has not been backtested on historical data (no historical Pump.fun event replay data readily available)
5. All parameter defaults are based on domain reasoning, not statistical optimization — this is intentional to avoid overfitting, but means they may not be optimal
6. The regime gate may miss opportunities in quiet markets or trade too eagerly in false-mania conditions

## Design Decisions

**Why rule-based instead of ML?** Explainability is non-negotiable. Every decision must have a human-readable reason trail. ML models are opaque and prone to overfitting on memecoin data which is extremely noisy.

**Why so many filters?** False positive cost is extremely high (losing money on a bad trade). False negative cost is low (missing one token when thousands launch daily). The strategy is designed to maximize precision at the expense of recall.

**Why post-graduation preference?** Pre-graduation tokens have no standard AMM liquidity. Post-graduation tokens trade on Raydium/Jupiter with better execution, more reliable pricing, and established liquidity.
