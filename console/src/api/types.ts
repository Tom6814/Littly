/** 领域类型。后端并行开发中，此处字段尽量宽松（可选项多），页面用 client.ts 的窄化工具读取。 */

export interface User {
  id: string;
  username: string;
  role?: string;
}

export interface Bot {
  id: string;
  name: string;
  avatarUrl?: string;
  createdAt?: string;
  settings?: Record<string, unknown>;
}

export interface BotChannels {
  [channel: string]: Record<string, unknown> | undefined;
}

export interface Character {
  id: string;
  name: string;
  /** chara_card_v2 原始 JSON（含 spec / data） */
  card?: Record<string, unknown>;
  mask?: string;
  deepseekPersonaTags?: string[];
  avatarUrl?: string;
  preset?: boolean;
  createdAt?: string;
}

export interface WorldEntry {
  id: string;
  botId?: string;
  keys: string[];
  secondKeys?: string[];
  /** 命中逻辑：AND_ALL / AND_ANY / OR_ANY / NOT_ANY 等，交给后端定义 */
  logic?: string;
  probability?: number;
  priority?: number;
  position?: string;
  constant?: boolean;
  enabled?: boolean;
  content?: string;
  comment?: string;
}

export interface Contact {
  id: string;
  botId?: string;
  name: string;
  avatarUrl?: string;
  profile?: Record<string, unknown>;
  lastActiveAt?: string;
}

export interface Relation {
  id?: string;
  botId?: string;
  fromContactId?: string;
  toContactId?: string;
  fromName?: string;
  toName?: string;
  type?: string;
  description?: string;
}

export interface Memory {
  id: string;
  botId?: string;
  sender?: string;
  category?: string;
  importance?: number;
  eventTime?: string;
  provenance?: string;
  volatility?: string;
  content?: string;
  tags?: string[];
  supersededBy?: string;
  supersedes?: string;
  validUntil?: string;
  deletedAt?: string | null;
  createdAt?: string;
  /** ⑨ newest-N 硬保护能力位 */
  protected?: boolean;
}

export interface MemoryExplain {
  memory: Memory;
  timing: {
    eventTime: string;
    eventTimeRaw: string;
    recordedAt: string;
    lastVerified?: string | null;
    effectiveTime: string;
    volatility: string;
    halfLifeDays: number;
  };
  provenance: { kind: string; note: string };
  tombstone: {
    deleted: boolean;
    deletedAt?: string | null;
    deletedReason: string;
    supersededBy?: string | null;
    supersededByContent?: string | null;
    supersededFrom: Array<{ id: string; content: string }>;
  };
  retrieval: {
    score: number;
    matchedBy: string;
    signals: { relevance: number; importance: number; recency: number };
  };
  protected?: boolean;
}

export interface Diary {
  id: string;
  botId?: string;
  date?: string;
  content?: string;
  mood?: string;
  createdAt?: string;
}

export interface Photo {
  id: string;
  botId?: string;
  url?: string;
  caption?: string;
  tags?: string[];
  createdAt?: string;
}

export interface ScheduledMessage {
  id: string;
  botId?: string;
  fireAt?: string;
  prompt?: string;
  origin?: string;
  status?: string;
  strictness?: string;
  createdAt?: string;
}

export interface PersonaRules {
  content?: string;
  enabled?: boolean;
}

export interface ChatMessagePiece {
  type: 'text' | 'voice' | 'image' | 'file' | 'tool_call' | 'unknown';
  text?: string;
  url?: string;
  name?: string;
  status?: 'running' | 'done' | 'failed';
}

export interface ChatMessage {
  id: string;
  role?: string;
  sender?: string;
  botId?: string;
  createdAt?: string;
  pieces: ChatMessagePiece[];
}

export interface BufferState {
  buffered?: number;
  count?: number;
  fireAt?: string;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
}

export interface GrowthDimension {
  name: string;
  level: number;
  max?: number;
  description?: string;
}

export interface GrowthVersion {
  version?: number;
  createdAt?: string;
  summary?: string;
  author?: string;
}

export interface GrowthProposal {
  id: string;
  kind?: string;
  title?: string;
  summary?: string;
  evidence?: string[];
  payload?: Record<string, unknown>;
  status?: string;
  createdAt?: string;
}

export interface GrowthData {
  profile?: {
    dimensions?: GrowthDimension[];
    summary?: string;
    report?: string;
    version?: number;
  };
  versions?: GrowthVersion[];
  proposals?: GrowthProposal[];
  window?: {
    nextAt?: string;
    lastAt?: string;
    reason?: string;
  };
}

export interface McpServer {
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  status?: string;
  tools?: number;
}

export interface SkillItem {
  name: string;
  description?: string;
  source?: string;
}

export interface ToolItem {
  name: string;
  namespace?: string;
  source?: string;
  description?: string;
  enabledBots?: string[];
}

export interface DshPlugin {
  name: string;
  version?: string;
  description?: string;
  enabled?: boolean;
}

export interface InstalledPlugin {
  id?: string;
  name: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  phase?: string;
}

export interface InstallableBundle {
  name: string;
  official?: boolean;
  availability?: string;
  installTarget?: string;
  version?: string;
}

export interface PluginsData {
  mcp?: McpServer[];
  skills?: SkillItem[];
  tools?: ToolItem[];
  dsh?: DshPlugin[];
  /** 已装的 dsh 插件（可启停/卸载） */
  installed?: InstalledPlugin[];
  /** 可安装的 bundle */
  bundles?: InstallableBundle[];
}

export interface BiliStatus {
  /** sidecar 是否连得上（false = 服务没起，不是账号问题） */
  connected?: boolean;
  logined?: boolean;
  username?: string;
  mid?: string | number;
  /** 连不上时的原因 */
  error?: string;
  /** 连不上时怎么办 */
  hint?: string;
}

export interface BiliQrState {
  status?: 'waiting' | 'scanned' | 'confirmed' | 'expired' | string;
  qrImage?: string;
  qrUrl?: string;
  message?: string;
  /** sidecar 会话 id：轮询状态时必须带上 */
  sessionId?: string;
}

export interface PromptLayer {
  name: string;
  source?: string;
  content?: string;
  chars?: number;
}

export interface PromptViewData {
  layers?: PromptLayer[];
  totalChars?: number;
  compiled?: string;
}

export interface AuditEntry {
  id?: string;
  time?: string;
  category?: string;
  botId?: string;
  summary?: string;
  detail?: string;
}
