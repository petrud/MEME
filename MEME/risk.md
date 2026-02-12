# Risk Documentation

## Hard Limits & Kill Switches

### Daily Drawdown Kill Switch (CRITICAL)
- **Threshold**: 2% daily drawdown (configurable)
- **Action**: All new orders blocked for 24 hours
- **Detection**: Checked every 10 seconds
- **Recovery**: Auto-resumes after 24h, or manual deactivation
- **Consequence**: Open positions are maintained (not force-closed) to avoid selling at worst prices

### Manual Kill Switch
- **Location**: Red button in status bar (always visible)
- **Action**: Immediate halt of all new orders
- **Requires**: Single click + browser confirmation dialog
- **Recovery**: Manual deactivation via UI or API

### Consecutive Loss Pause
- **Threshold**: 3 consecutive losing trades (configurable)
- **Action**: New entries paused
- **Rationale**: Consecutive losses may indicate regime shift or strategy decay

### Trade Rate Limits
- **Hourly**: Max 3 trades/hour
- **Daily**: Max 10 trades/day
- **Purpose**: Prevents runaway trading from data quality issues or bugs

## Failure Mode Analysis

### 1. Backtest Overfitting / Data Snooping
- **Prevention**: Rule-based strategy with no optimization. Filters use domain knowledge, not fitted parameters
- **Detection**: Paper trading divergence from expectations
- **Recovery**: Conservative defaults, continuous evaluation

### 2. Unrealistic Cost Assumptions
- **Prevention**: Paper trading simulates 1.5x worse slippage, 5% tx failure rate
- **Detection**: Compare paper slippage vs live execution
- **Recovery**: Adjust slippage multiplier based on live data

### 3. MEV / Toxic Flow
- **Prevention**: Conservative slippage limits, priority fees, order splitting for larger trades
- **Detection**: Monitor slippage distribution for anomalies
- **Recovery**: Increase priority fees or pause trading

### 4. Software / Config Errors
- **Prevention**: Config validation, safe defaults, typed configuration
- **Detection**: Startup validation warnings, health monitoring
- **Recovery**: "Reset to Safe Defaults" button, graceful restart

### 5. Missing Pre-Trade Risk Controls
- **Prevention**: Risk governor checks every trade before execution
- **Detection**: All risk checks logged in decision cards
- **Recovery**: Kill switch immediately available

### 6. Data Quality / Stale State
- **Prevention**: RPC health monitoring, connection status tracking
- **Detection**: RPC latency > 2000ms or error rate > 20% triggers halt
- **Recovery**: Auto-reconnect, pause new entries until healthy

### 7. Duplicate Events / Race Conditions
- **Prevention**: Idempotency keys on all orders, deduplication in event processing
- **Detection**: Database unique constraints, duplicate detection logs
- **Recovery**: Rejected duplicates logged as incidents

### 8. Transaction Failures
- **Prevention**: Simulate/preview before execution, conservative compute budgets
- **Detection**: Track tx status, handle expired blockhash
- **Recovery**: Retry with budget (max 2 retries), log failures

### 9. Liquidity Rugs / Token Traps
- **Prevention**: Minimum liquidity filter, token permission checks
- **Detection**: Rapid price decline detection, concentration monitoring
- **Recovery**: Hard stop-loss limits maximum loss per position

### 10. Monitoring Blindness
- **Prevention**: Persistent UI status bar, WebSocket real-time updates
- **Detection**: Incident timeline, alert panel on overview
- **Recovery**: All auto-actions logged, "flight recorder" export

### 11. Key / Security Leaks
- **Prevention**: Keys never exposed to UI, never logged, wallet path sanitized
- **Detection**: No secrets in API responses or logs
- **Recovery**: Use dedicated trading wallet with limited funds

### 12. Regime Shifts / Strategy Decay
- **Prevention**: Regime gate adapts to market conditions
- **Detection**: Win rate trend monitoring, drawdown tracking
- **Recovery**: Auto-halt on drawdown, manual review cycle

## Risk Parameters

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Risk per trade | 0.2% | 0.1-0.3% | % of equity |
| Max exposure | 1.0% | 0.5-2.0% | Total open positions |
| Daily drawdown limit | 2.0% | 1.0-3.0% | Kill switch threshold |
| Stop-loss | 25% | 15-35% | Per-position hard stop |
| Max trades/hour | 3 | 1-5 | Rate limit |
| Max trades/day | 10 | 5-20 | Rate limit |
| Consecutive loss limit | 3 | 2-5 | Pause trigger |

## Operator Checklist

### Before Starting Paper Trading
- [ ] Config file reviewed
- [ ] Risk limits set appropriately
- [ ] RPC endpoint configured
- [ ] Kill switch tested
- [ ] UI connected and showing data

### Before Going Live
- [ ] Paper trading run for at least 1 week
- [ ] Paper results reviewed and documented
- [ ] Dedicated trading wallet created
- [ ] Wallet funded with only intended trading amount
- [ ] All risk limits confirmed
- [ ] Kill switch tested and accessible
- [ ] Monitoring/alerts configured
- [ ] Backup plan documented (what to do if things go wrong)
