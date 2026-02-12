// ============================================================================
// SHARED TYPES - Core data structures for the entire system
// ============================================================================

// --- System Modes ---
export type TradingMode = 'PAPER' | 'LIVE';
export type BotState = 'RUNNING' | 'PAUSED' | 'HALTED' | 'ARMING';

// --- Token Lifecycle ---
export type TokenPhase = 'BONDING_CURVE' | 'GRADUATED' | 'RAYDIUM_POOL' | 'DEAD';

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: number;
  phase: TokenPhase;
  bondingCurveAddress?: string;
  raydiumPoolAddress?: string;
  graduatedAt?: number;
  metadata?: TokenMetadata;
}

export interface TokenMetadata {
  uri?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

// --- Feature Engineering ---
export interface RegimeFeatures {
  pumpfunLaunchRate: number;        // launches per 5min
  pumpfunVolumeProxy: number;       // SOL volume proxy
  solVolatility: number;            // rolling volatility
  marketRiskOn: boolean;            // composite risk-on signal
  regimeScore: number;              // 0-100 composite
  regime: 'MANIA' | 'NORMAL' | 'COLD';
  reason: string;
}

export interface TokenTractionFeatures {
  uniqueBuyersPerMin: number;
  netBuyPressure: number;           // (buys - sells) / total
  buyCountSmall: number;            // < 0.1 SOL
  buyCountMedium: number;           // 0.1 - 1 SOL
  buyCountLarge: number;            // > 1 SOL
  breadthScore: number;             // many small > few large
  priceVelocity: number;            // % change per minute
  volumeAcceleration: number;       // volume increase rate
  drawdownFromHigh: number;         // % below local high
  timeSinceLaunchSec: number;
  timeSinceGraduationSec: number | null;
}

export interface ConcentrationFeatures {
  top10HolderPct: number;           // 0-100
  top20HolderPct: number;
  creatorHoldingPct: number;
  creatorSoldPct: number;           // how much creator has sold
  suspiciousCreator: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  reason: string;
}

export interface ExecutionRiskFeatures {
  liquidityDepthSol: number;        // available liquidity in SOL
  spreadBps: number;                // estimated spread
  estimatedSlippageBps: number;     // for intended order size
  rpcLatencyMs: number;
  recentFailureRate: number;        // % of recent txs that failed
  executionRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  reason: string;
}

export interface AllFeatures {
  regime: RegimeFeatures;
  traction: TokenTractionFeatures;
  concentration: ConcentrationFeatures;
  execution: ExecutionRiskFeatures;
  computedAt: number;
}

// --- Decision Engine ---
export type FilterResult = 'PASS' | 'FAIL';

export interface FilterCheck {
  name: string;
  result: FilterResult;
  value: number | string | boolean;
  threshold: number | string | boolean;
  reason: string;
}

export interface DecisionCard {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  timestamp: number;
  verdict: 'TRADE' | 'SKIP';
  summaryBullets: string[];         // 3 plain-language bullets
  filters: FilterCheck[];
  features: AllFeatures;
  executionPlan?: ExecutionPlan;
  riskImpact?: RiskImpact;
}

export interface ExecutionPlan {
  route: 'JUPITER' | 'RAYDIUM_DIRECT' | 'PUMP_BONDING_CURVE';
  inputMint: string;
  outputMint: string;
  amountInSol: number;
  estimatedSlippageBps: number;
  estimatedOutputTokens: number;
  priorityFeeLamports: number;
  splitOrders: number;
}

export interface RiskImpact {
  riskPct: number;                  // % of equity at risk
  maxLossSol: number;
  newExposurePct: number;
  withinLimits: boolean;
  limitDetails: string;
}

// --- Orders & Positions ---
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export type OrderSource = 'ENTRY_SIGNAL' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL' | 'KILL_SWITCH';

export interface Order {
  id: string;
  idempotencyKey: string;
  tokenMint: string;
  tokenSymbol: string;
  side: OrderSide;
  source: OrderSource;
  amountSol: number;
  amountTokens: number;
  estimatedPrice: number;
  executedPrice?: number;
  slippageBps?: number;
  feeSol?: number;
  status: OrderStatus;
  txSignature?: string;
  isPaper: boolean;
  decisionCardId?: string;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  errorMessage?: string;
}

export type PositionStatus = 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';

export interface Position {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  status: PositionStatus;
  entryPrice: number;
  currentPrice: number;
  entryAmountSol: number;
  remainingTokens: number;
  totalTokensBought: number;
  totalTokensSold: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  unrealizedPnlPct: number;
  stopLossPrice: number;
  takeProfitLevels: TakeProfitLevel[];
  trailingStopPct: number;
  trailingStopPrice: number;
  highWaterMark: number;
  timeStopMinutes: number;
  entryTime: number;
  lastUpdateTime: number;
  isPaper: boolean;
  decisionCardId: string;
  exitReason?: string;
}

export interface TakeProfitLevel {
  pctGain: number;                  // e.g., 50 for +50%
  sellPct: number;                  // e.g., 30 for sell 30%
  triggered: boolean;
  orderId?: string;
}

// --- Risk & Portfolio ---
export interface RiskState {
  equitySol: number;
  startOfDayEquity: number;
  todayPnlSol: number;
  todayPnlPct: number;
  todayDrawdownPct: number;
  currentExposureSol: number;
  currentExposurePct: number;
  openPositionCount: number;
  todayTradeCount: number;
  hourTradeCount: number;
  consecutiveLosses: number;
  isHalted: boolean;
  haltReason?: string;
  haltedAt?: number;
  resumeAt?: number;
  limits: RiskLimits;
}

export interface RiskLimits {
  maxRiskPerTradePct: number;       // default 0.2%
  maxExposurePct: number;           // default 1.0%
  dailyMaxDrawdownPct: number;      // default 2.0%
  maxTradesPerHour: number;         // default 3
  maxTradesPerDay: number;          // default 10
  maxConsecutiveLosses: number;     // default 3
  stopLossPct: number;              // default 25%
  takeProfitLevels: TakeProfitLevel[];
  trailingStopPct: number;          // default 15%
  timeStopMinutes: number;          // default 60
}

// --- Health & System ---
export interface SystemHealth {
  rpcConnected: boolean;
  rpcLatencyMs: number;
  rpcErrorRate: number;
  slotLag: number;
  wsConnected: boolean;
  lastEventAt: number;
  uptimeSeconds: number;
  memoryUsageMb: number;
  dbSizeMb: number;
  lastReconciliationAt: number;
  reconciliationDrift: number;      // SOL difference
}

export interface Incident {
  id: string;
  timestamp: number;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  category: string;
  message: string;
  details?: string;
  autoAction?: string;
  resolved: boolean;
  resolvedAt?: number;
}

// --- Config ---
export interface BotConfig {
  mode: TradingMode;
  rpcEndpoint: string;
  rpcWsEndpoint: string;
  walletPath?: string;
  // Regime thresholds
  regimeScoreThreshold: number;     // default 40
  // Filter thresholds
  minLiquidityDepthSol: number;     // default 5
  maxTop10HolderPct: number;        // default 70
  minUniqueBuyersPerMin: number;    // default 3
  minBreadthScore: number;          // default 0.3
  maxSpreadBps: number;             // default 500
  maxEstimatedSlippageBps: number;  // default 300
  // Entry timing
  minSecondsAfterGraduation: number;// default 30
  maxSecondsAfterGraduation: number;// default 600
  // Risk
  riskPerTradePct: number;          // default 0.2
  maxExposurePct: number;           // default 1.0
  dailyMaxDrawdownPct: number;      // default 2.0
  maxTradesPerHour: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  // Exits
  stopLossPct: number;
  takeProfitLevels: { pctGain: number; sellPct: number }[];
  trailingStopPct: number;
  timeStopMinutes: number;
  // Execution
  maxSlippageBps: number;           // default 300
  priorityFeeLamports: number;      // default 10000
  maxRetries: number;               // default 2
  computeBudget: number;            // default 200000
  // Paper
  paperStartingEquity: number;      // default 10
  paperSlippageMultiplier: number;  // default 1.5
  paperFailureRate: number;         // default 0.05
  paperLatencyMs: number;           // default 500
  // Trading scope
  tradePreGraduation: boolean;      // default false
  tradePostGraduation: boolean;     // default true
}

// --- WebSocket Messages ---
export type WsMessageType =
  | 'SYSTEM_STATUS'
  | 'REGIME_UPDATE'
  | 'TOKEN_EVENT'
  | 'DECISION_CARD'
  | 'ORDER_UPDATE'
  | 'POSITION_UPDATE'
  | 'RISK_UPDATE'
  | 'HEALTH_UPDATE'
  | 'INCIDENT'
  | 'EQUITY_TICK'
  | 'RADAR_UPDATE';

export interface WsMessage {
  type: WsMessageType;
  payload: any;
  timestamp: number;
}

// --- API Responses ---
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}
