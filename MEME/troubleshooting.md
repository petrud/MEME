# Troubleshooting Guide

## Common Issues

### Bot shows "Backend unavailable" in UI
The cockpit UI falls back to demo data when it can't reach the API.

**Fix**: Ensure the backend is running on port 3001:
```bash
npm run dev:backend
```

### No tokens appearing in Radar
In paper mode, synthetic tokens are generated automatically. If none appear:
1. Check backend logs for errors
2. Verify the bot state is "RUNNING" (not paused/halted)
3. Check regime score — if too low, no tokens will be evaluated

### All tokens show "SKIP"
This is by design. The 13-filter pipeline is intentionally aggressive. Most tokens will fail.

**Common filter failures**:
- Regime Gate: Market too quiet. Wait for activity
- Liquidity: Most new tokens have insufficient liquidity
- Concentration: Early tokens often have concentrated holders
- Breadth: Not enough unique buyers yet

### Kill switch won't deactivate
Call the deactivation endpoint:
```bash
curl -X POST http://localhost:3001/api/kill-switch/deactivate
```

### Database errors
Delete and recreate:
```bash
rm -rf data/bot.db
npm run dev
```

### RPC connection failures
1. Check your RPC endpoint is correct in `.env`
2. Public endpoints have rate limits — consider a paid provider
3. In paper mode, the bot simulates the connection

### Paper trading shows unrealistic results
Paper mode applies 1.5x slippage multiplier and 5% failure rate, but:
- Price simulation is simplified (random walk, not market-driven)
- Real execution may be significantly worse
- Don't extrapolate paper results to live performance

## Health Indicators

| Indicator | Healthy | Degraded | Critical |
|-----------|---------|----------|----------|
| RPC Latency | < 500ms | 500-2000ms | > 2000ms |
| Error Rate | < 5% | 5-20% | > 20% |
| Slot Lag | < 10 | 10-50 | > 50 |
| WS Connection | Connected | Reconnecting | Disconnected |

## Flight Recorder Export

To export diagnostic data for debugging:
1. Go to Settings → Export Flight Recorder
2. Or manually collect: `data/bot.db` + `.env` (redacted) + recent logs

## Getting Help

1. Check the incident timeline in the Health tab
2. Review decision cards for specific tokens
3. Check backend console logs for error details
4. Review the auto-halt reasons if trading stopped unexpectedly
