// ============================================================================
// DATABASE - SQLite schema, migrations, and query helpers
// ============================================================================

import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  TokenInfo, DecisionCard, Order, Position, RiskState,
  Incident, SystemHealth, AllFeatures, RegimeFeatures
} from '../../shared/types.js';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bot.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    const fs = require('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    -- Tokens discovered
    CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      creator TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'BONDING_CURVE',
      bonding_curve_address TEXT,
      raydium_pool_address TEXT,
      graduated_at INTEGER,
      metadata_json TEXT,
      updated_at INTEGER NOT NULL
    );

    -- Feature snapshots
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      token_mint TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      features_json TEXT NOT NULL,
      FOREIGN KEY (token_mint) REFERENCES tokens(mint)
    );
    CREATE INDEX IF NOT EXISTS idx_features_mint ON features(token_mint, computed_at DESC);

    -- Decision cards (explainability)
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      features_json TEXT NOT NULL,
      execution_plan_json TEXT,
      risk_impact_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_decisions_mint ON decisions(token_mint);

    -- Orders
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      source TEXT NOT NULL,
      amount_sol REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      estimated_price REAL NOT NULL,
      executed_price REAL,
      slippage_bps REAL,
      fee_sol REAL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      tx_signature TEXT,
      is_paper INTEGER NOT NULL DEFAULT 1,
      decision_card_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_mint ON orders(token_mint);
    CREATE INDEX IF NOT EXISTS idx_orders_idem ON orders(idempotency_key);

    -- Positions
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      entry_price REAL NOT NULL,
      current_price REAL NOT NULL,
      entry_amount_sol REAL NOT NULL,
      remaining_tokens REAL NOT NULL,
      total_tokens_bought REAL NOT NULL,
      total_tokens_sold REAL NOT NULL DEFAULT 0,
      realized_pnl_sol REAL NOT NULL DEFAULT 0,
      unrealized_pnl_sol REAL NOT NULL DEFAULT 0,
      unrealized_pnl_pct REAL NOT NULL DEFAULT 0,
      stop_loss_price REAL NOT NULL,
      take_profit_json TEXT NOT NULL,
      trailing_stop_pct REAL NOT NULL,
      trailing_stop_price REAL NOT NULL,
      high_water_mark REAL NOT NULL,
      time_stop_minutes INTEGER NOT NULL,
      entry_time INTEGER NOT NULL,
      last_update_time INTEGER NOT NULL,
      is_paper INTEGER NOT NULL DEFAULT 1,
      decision_card_id TEXT NOT NULL,
      exit_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

    -- Regime snapshots
    CREATE TABLE IF NOT EXISTS regime_history (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      regime_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_regime_ts ON regime_history(timestamp DESC);

    -- Incidents
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      auto_action TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_ts ON incidents(timestamp DESC);

    -- Equity snapshots (for charting)
    CREATE TABLE IF NOT EXISTS equity_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      equity_sol REAL NOT NULL,
      drawdown_pct REAL NOT NULL,
      exposure_pct REAL NOT NULL,
      is_paper INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity_history(timestamp DESC);

    -- Health metrics
    CREATE TABLE IF NOT EXISTS health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      metrics_json TEXT NOT NULL
    );

    -- Idempotency tracking
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      result_json TEXT
    );
  `);
}

// --- Token CRUD ---
export function upsertToken(token: TokenInfo): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO tokens (mint, name, symbol, creator, created_at, phase,
      bonding_curve_address, raydium_pool_address, graduated_at, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      phase = excluded.phase,
      raydium_pool_address = COALESCE(excluded.raydium_pool_address, raydium_pool_address),
      graduated_at = COALESCE(excluded.graduated_at, graduated_at),
      metadata_json = COALESCE(excluded.metadata_json, metadata_json),
      updated_at = excluded.updated_at
  `).run(
    token.mint, token.name, token.symbol, token.creator, token.createdAt,
    token.phase, token.bondingCurveAddress || null, token.raydiumPoolAddress || null,
    token.graduatedAt || null, token.metadata ? JSON.stringify(token.metadata) : null,
    Date.now()
  );
}

export function getToken(mint: string): TokenInfo | null {
  const row = getDb().prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as any;
  if (!row) return null;
  return {
    mint: row.mint, name: row.name, symbol: row.symbol, creator: row.creator,
    createdAt: row.created_at, phase: row.phase,
    bondingCurveAddress: row.bonding_curve_address,
    raydiumPoolAddress: row.raydium_pool_address,
    graduatedAt: row.graduated_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  };
}

export function getRecentTokens(limit: number = 50): TokenInfo[] {
  const rows = getDb().prepare(
    'SELECT * FROM tokens ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(row => ({
    mint: row.mint, name: row.name, symbol: row.symbol, creator: row.creator,
    createdAt: row.created_at, phase: row.phase,
    bondingCurveAddress: row.bonding_curve_address,
    raydiumPoolAddress: row.raydium_pool_address,
    graduatedAt: row.graduated_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  }));
}

// --- Decision CRUD ---
export function saveDecision(card: DecisionCard): void {
  getDb().prepare(`
    INSERT INTO decisions (id, token_mint, token_symbol, timestamp, verdict,
      summary_json, filters_json, features_json, execution_plan_json, risk_impact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    card.id, card.tokenMint, card.tokenSymbol, card.timestamp, card.verdict,
    JSON.stringify(card.summaryBullets), JSON.stringify(card.filters),
    JSON.stringify(card.features),
    card.executionPlan ? JSON.stringify(card.executionPlan) : null,
    card.riskImpact ? JSON.stringify(card.riskImpact) : null
  );
}

export function getRecentDecisions(limit: number = 100): DecisionCard[] {
  const rows = getDb().prepare(
    'SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(row => ({
    id: row.id, tokenMint: row.token_mint, tokenSymbol: row.token_symbol,
    timestamp: row.timestamp, verdict: row.verdict,
    summaryBullets: JSON.parse(row.summary_json),
    filters: JSON.parse(row.filters_json),
    features: JSON.parse(row.features_json),
    executionPlan: row.execution_plan_json ? JSON.parse(row.execution_plan_json) : undefined,
    riskImpact: row.risk_impact_json ? JSON.parse(row.risk_impact_json) : undefined,
  }));
}

// --- Order CRUD ---
export function saveOrder(order: Order): void {
  getDb().prepare(`
    INSERT INTO orders (id, idempotency_key, token_mint, token_symbol, side, source,
      amount_sol, amount_tokens, estimated_price, executed_price, slippage_bps, fee_sol,
      status, tx_signature, is_paper, decision_card_id, created_at, updated_at,
      retry_count, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, executed_price = excluded.executed_price,
      slippage_bps = excluded.slippage_bps, fee_sol = excluded.fee_sol,
      tx_signature = excluded.tx_signature, updated_at = excluded.updated_at,
      retry_count = excluded.retry_count, error_message = excluded.error_message
  `).run(
    order.id, order.idempotencyKey, order.tokenMint, order.tokenSymbol,
    order.side, order.source, order.amountSol, order.amountTokens,
    order.estimatedPrice, order.executedPrice || null, order.slippageBps || null,
    order.feeSol || null, order.status, order.txSignature || null,
    order.isPaper ? 1 : 0, order.decisionCardId || null,
    order.createdAt, order.updatedAt, order.retryCount, order.errorMessage || null
  );
}

export function getRecentOrders(limit: number = 50): Order[] {
  const rows = getDb().prepare(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(rowToOrder);
}

function rowToOrder(row: any): Order {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, tokenMint: row.token_mint,
    tokenSymbol: row.token_symbol, side: row.side, source: row.source,
    amountSol: row.amount_sol, amountTokens: row.amount_tokens,
    estimatedPrice: row.estimated_price, executedPrice: row.executed_price,
    slippageBps: row.slippage_bps, feeSol: row.fee_sol,
    status: row.status, txSignature: row.tx_signature,
    isPaper: !!row.is_paper, decisionCardId: row.decision_card_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    retryCount: row.retry_count, errorMessage: row.error_message,
  };
}

// --- Position CRUD ---
export function savePosition(pos: Position): void {
  getDb().prepare(`
    INSERT INTO positions (id, token_mint, token_symbol, status, entry_price,
      current_price, entry_amount_sol, remaining_tokens, total_tokens_bought,
      total_tokens_sold, realized_pnl_sol, unrealized_pnl_sol, unrealized_pnl_pct,
      stop_loss_price, take_profit_json, trailing_stop_pct, trailing_stop_price,
      high_water_mark, time_stop_minutes, entry_time, last_update_time,
      is_paper, decision_card_id, exit_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, current_price = excluded.current_price,
      remaining_tokens = excluded.remaining_tokens, total_tokens_sold = excluded.total_tokens_sold,
      realized_pnl_sol = excluded.realized_pnl_sol, unrealized_pnl_sol = excluded.unrealized_pnl_sol,
      unrealized_pnl_pct = excluded.unrealized_pnl_pct, trailing_stop_price = excluded.trailing_stop_price,
      high_water_mark = excluded.high_water_mark, last_update_time = excluded.last_update_time,
      take_profit_json = excluded.take_profit_json, exit_reason = excluded.exit_reason
  `).run(
    pos.id, pos.tokenMint, pos.tokenSymbol, pos.status, pos.entryPrice,
    pos.currentPrice, pos.entryAmountSol, pos.remainingTokens,
    pos.totalTokensBought, pos.totalTokensSold, pos.realizedPnlSol,
    pos.unrealizedPnlSol, pos.unrealizedPnlPct, pos.stopLossPrice,
    JSON.stringify(pos.takeProfitLevels), pos.trailingStopPct,
    pos.trailingStopPrice, pos.highWaterMark, pos.timeStopMinutes,
    pos.entryTime, pos.lastUpdateTime, pos.isPaper ? 1 : 0,
    pos.decisionCardId, pos.exitReason || null
  );
}

export function getOpenPositions(): Position[] {
  const rows = getDb().prepare(
    "SELECT * FROM positions WHERE status IN ('OPEN', 'PARTIALLY_CLOSED') ORDER BY entry_time DESC"
  ).all() as any[];
  return rows.map(rowToPosition);
}

export function getAllPositions(limit: number = 100): Position[] {
  const rows = getDb().prepare(
    'SELECT * FROM positions ORDER BY entry_time DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(rowToPosition);
}

function rowToPosition(row: any): Position {
  return {
    id: row.id, tokenMint: row.token_mint, tokenSymbol: row.token_symbol,
    status: row.status, entryPrice: row.entry_price, currentPrice: row.current_price,
    entryAmountSol: row.entry_amount_sol, remainingTokens: row.remaining_tokens,
    totalTokensBought: row.total_tokens_bought, totalTokensSold: row.total_tokens_sold,
    realizedPnlSol: row.realized_pnl_sol, unrealizedPnlSol: row.unrealized_pnl_sol,
    unrealizedPnlPct: row.unrealized_pnl_pct, stopLossPrice: row.stop_loss_price,
    takeProfitLevels: JSON.parse(row.take_profit_json),
    trailingStopPct: row.trailing_stop_pct, trailingStopPrice: row.trailing_stop_price,
    highWaterMark: row.high_water_mark, timeStopMinutes: row.time_stop_minutes,
    entryTime: row.entry_time, lastUpdateTime: row.last_update_time,
    isPaper: !!row.is_paper, decisionCardId: row.decision_card_id,
    exitReason: row.exit_reason,
  };
}

// --- Incidents ---
export function saveIncident(incident: Incident): void {
  getDb().prepare(`
    INSERT INTO incidents (id, timestamp, severity, category, message, details, auto_action, resolved, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    incident.id, incident.timestamp, incident.severity, incident.category,
    incident.message, incident.details || null, incident.autoAction || null,
    incident.resolved ? 1 : 0, incident.resolvedAt || null
  );
}

export function getRecentIncidents(limit: number = 50): Incident[] {
  const rows = getDb().prepare(
    'SELECT * FROM incidents ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(row => ({
    id: row.id, timestamp: row.timestamp, severity: row.severity,
    category: row.category, message: row.message, details: row.details,
    autoAction: row.auto_action, resolved: !!row.resolved, resolvedAt: row.resolved_at,
  }));
}

// --- Equity History ---
export function saveEquitySnapshot(equity: number, drawdown: number, exposure: number, isPaper: boolean): void {
  getDb().prepare(`
    INSERT INTO equity_history (timestamp, equity_sol, drawdown_pct, exposure_pct, is_paper)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), equity, drawdown, exposure, isPaper ? 1 : 0);
}

export function getEquityHistory(since: number, isPaper: boolean): { timestamp: number; equity: number; drawdown: number; exposure: number }[] {
  const rows = getDb().prepare(
    'SELECT * FROM equity_history WHERE timestamp > ? AND is_paper = ? ORDER BY timestamp ASC'
  ).all(since, isPaper ? 1 : 0) as any[];
  return rows.map(r => ({
    timestamp: r.timestamp, equity: r.equity_sol,
    drawdown: r.drawdown_pct, exposure: r.exposure_pct,
  }));
}

// --- Regime History ---
export function saveRegimeSnapshot(regime: RegimeFeatures): void {
  getDb().prepare(`
    INSERT INTO regime_history (id, timestamp, regime_json) VALUES (?, ?, ?)
  `).run(uuidv4(), Date.now(), JSON.stringify(regime));
}

// --- Idempotency ---
export function checkIdempotency(key: string): boolean {
  const row = getDb().prepare('SELECT key FROM idempotency_keys WHERE key = ?').get(key);
  return !!row;
}

export function setIdempotency(key: string, result?: any): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO idempotency_keys (key, created_at, result_json) VALUES (?, ?, ?)
  `).run(key, Date.now(), result ? JSON.stringify(result) : null);
}

// --- Stats ---
export function getTodayTradeCount(): number {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM orders WHERE created_at > ? AND status = 'CONFIRMED' AND side = 'BUY'"
  ).get(startOfDay.getTime()) as any;
  return row?.cnt || 0;
}

export function getHourTradeCount(): number {
  const oneHourAgo = Date.now() - 3600_000;
  const row = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM orders WHERE created_at > ? AND status = 'CONFIRMED' AND side = 'BUY'"
  ).get(oneHourAgo) as any;
  return row?.cnt || 0;
}

export function getConsecutiveLosses(): number {
  const rows = getDb().prepare(
    "SELECT realized_pnl_sol FROM positions WHERE status = 'CLOSED' ORDER BY last_update_time DESC LIMIT 20"
  ).all() as any[];
  let count = 0;
  for (const row of rows) {
    if (row.realized_pnl_sol < 0) count++;
    else break;
  }
  return count;
}
