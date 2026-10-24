/** 各领域的类型化 API 封装。页面只调用这里的函数，不直接 fetch。 */
import { http, pickArray, pickRecord, asStr, asNum, asBool, firstOf, isRecord, downloadFile } from './client';
import type {
  AuditEntry,
  Bot,
  BotChannels,
  BiliQrState,
  BiliStatus,
  BufferState,
  ChatMessage,
  ChatMessagePiece,
  Character,
  Contact,
  Diary,
  GrowthData,
  Memory,
  PersonaRules,
  Photo,
  PluginsData,
  PromptViewData,
  Relation,
  ScheduledMessage,
  ToolCallEvent,
  User,
  WorldEntry,
} from './types';

/* ---------------- 通用窄化 ---------------- */

function toUser(v: unknown): User | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'userId', 'uid'));
  const username = asStr(firstOf(v, 'username', 'name'));
  if (!id && !username) return undefined;
  return { id: id ?? username ?? '', username: username ?? id ?? '', role: asStr(v.role) };
}

function toBot(v: unknown): Bot | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'botId'));
  const name = asStr(firstOf(v, 'name', 'botName'));
  if (!id && !name) return undefined;
  return {
    id: id ?? name ?? '',
    name: name ?? id ?? '',
    avatarUrl: asStr(firstOf(v, 'avatarUrl', 'avatar')),
    createdAt: asStr(v.createdAt),
    settings: pickRecord(v, 'settings'),
  };
}

/* ---------------- 消息规范化 ---------------- */

function toPiece(rec: Record<string, unknown>): ChatMessagePiece {
  const kind = (asStr(firstOf(rec, 'type', 'kind')) ?? '').toLowerCase();
  const url = asStr(firstOf(rec, 'url', 'audioUrl', 'audio_url', 'imageUrl', 'image_url', 'fileUrl', 'file_url'));
  const text = asStr(firstOf(rec, 'text', 'content', 'transcript', 'originalText', 'caption'));
  const name = asStr(firstOf(rec, 'name', 'toolName', 'tool', 'fileName', 'title'));
  const statusRaw = (asStr(firstOf(rec, 'status', 'state')) ?? '').toLowerCase();
  const status: ChatMessagePiece['status'] =
    statusRaw === 'running' || statusRaw === 'pending' || statusRaw === 'start'
      ? 'running'
      : statusRaw === 'failed' || statusRaw === 'error'
        ? 'failed'
        : statusRaw === 'done' || statusRaw === 'ok'
          ? 'done'
          : undefined;

  let type: ChatMessagePiece['type'] = 'unknown';
  if (kind.startsWith('text')) type = 'text';
  else if (kind.includes('voice') || kind.includes('audio')) type = 'voice';
  else if (kind.includes('image') || kind.includes('photo')) type = 'image';
  else if (kind.includes('file') || kind.includes('doc')) type = 'file';
  else if (kind.includes('tool')) type = 'tool_call';
  else if (url && !text) type = 'image';
  else type = 'text';
  return { type, text, url, name, status };
}

function piecesOf(raw: Record<string, unknown>): ChatMessagePiece[] {
  const arr = firstOf(raw, 'pieces', 'parts', 'segments', 'attachments');
  if (Array.isArray(arr) && arr.length > 0) {
    return arr
      .filter(isRecord)
      .map(toPiece)
      .filter((p) => p.type !== 'text' || !!p.text || !!p.url);
  }
  // 顶层字段探测：语音 / 图片 / 文件 / 工具
  const out: ChatMessagePiece[] = [];
  const audioUrl = asStr(firstOf(raw, 'audioUrl', 'audio_url', 'voiceUrl'));
  if (audioUrl) {
    out.push({ type: 'voice', url: audioUrl, text: asStr(firstOf(raw, 'text', 'content', 'originalText')) });
  }
  const imageUrl = asStr(firstOf(raw, 'imageUrl', 'image_url', 'photoUrl'));
  if (imageUrl) out.push({ type: 'image', url: imageUrl, text: asStr(raw.caption) });
  const fileUrl = asStr(firstOf(raw, 'fileUrl', 'file_url'));
  if (fileUrl) out.push({ type: 'file', url: fileUrl, name: asStr(firstOf(raw, 'fileName', 'file_name')) ?? '文件' });
  const toolName = asStr(firstOf(raw, 'toolName', 'tool_name', 'tool'));
  if (toolName) out.push({ type: 'tool_call', name: toolName, status: 'done' });

  const text = asStr(firstOf(raw, 'text', 'content', 'body', 'message'));
  if (out.length === 0 || (text && !out.some((p) => p.type === 'voice'))) {
    out.unshift({ type: 'text', text: text ?? '' });
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }];
}

export function normalizeMessage(raw: unknown, idx = 0): ChatMessage {
  if (!isRecord(raw)) return { id: `msg-${idx}`, pieces: [{ type: 'text', text: '' }] };
  const id = asStr(firstOf(raw, 'id', 'messageId', 'msgId')) ?? `msg-${idx}`;
  const role = asStr(firstOf(raw, 'role', 'senderRole', 'from')) ?? undefined;
  const sender = asStr(firstOf(raw, 'sender', 'senderId', 'contactId', 'fromId'));
  return {
    id,
    role,
    sender,
    botId: asStr(raw.botId),
    createdAt: asStr(firstOf(raw, 'createdAt', 'created_at', 'time', 'timestamp', 'sentAt')),
    pieces: piecesOf(raw),
  };
}

export function normalizeMessages(data: unknown): ChatMessage[] {
  return pickArray<Record<string, unknown>>(data, 'messages', 'items', 'list')
    .map((m, i) => normalizeMessage(m, i));
}

/* ---------------- 鉴权 ---------------- */

export const auth = {
  async session(): Promise<User | null> {
    const data = await http.get<unknown>('/api/auth/session');
    const user = pickRecord(data, 'user');
    return toUser(user ?? data) ?? null;
  },
  async login(username: string, password: string): Promise<User> {
    const data = await http.post<unknown>('/api/auth/login', { username, password });
    const user = toUser(pickRecord(data, 'user') ?? data);
    if (!user) throw new Error('登录响应异常');
    return user;
  },
  async register(username: string, password: string): Promise<User> {
    const data = await http.post<unknown>('/api/auth/register', { username, password });
    const user = toUser(pickRecord(data, 'user') ?? data);
    if (!user) throw new Error('注册响应异常');
    return user;
  },
  logout(): Promise<unknown> {
    return http.post('/api/auth/logout');
  },
};

/* ---------------- 机器人 ---------------- */

export const bots = {
  async list(): Promise<{ bots: Bot[]; current?: string }> {
    const data = await http.get<unknown>('/api/bots');
    const rec = isRecord(data) ? data : {};
    const list = pickArray<unknown>(rec, 'bots', 'items', 'list')
      .map(toBot)
      .filter((b): b is Bot => !!b);
    const current = asStr(firstOf(rec, 'current', 'currentId', 'currentBotId', 'currentBot'));
    return { bots: list, current };
  },
  async create(name: string): Promise<Bot | undefined> {
    const data = await http.post<unknown>('/api/bots', { name });
    return toBot(pickRecord(data, 'bot') ?? data);
  },
  async get(id: string): Promise<Bot | undefined> {
    const data = await http.get<unknown>(`/api/bots/${encodeURIComponent(id)}`);
    return toBot(pickRecord(data, 'bot') ?? data);
  },
  async update(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/bots/${encodeURIComponent(id)}`, patch);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/bots/${encodeURIComponent(id)}`);
  },
  async channels(id: string): Promise<BotChannels> {
    const data = await http.get<unknown>(`/api/bots/${encodeURIComponent(id)}/channels`);
    const rec = isRecord(data) ? data : {};
    const inner = pickRecord(rec, 'channels');
    return (inner ?? rec) as BotChannels;
  },
  async putChannels(id: string, channels: BotChannels): Promise<unknown> {
    return http.put(`/api/bots/${encodeURIComponent(id)}/channels`, { channels });
  },
};

/* ---------------- 角色卡 ---------------- */

function toCharacter(v: unknown): Character | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'characterId'));
  const name = asStr(firstOf(v, 'name', 'characterName'));
  if (!id && !name) return undefined;
  const card = pickRecord(v, 'card', 'charaCard', 'data');
  return {
    id: id ?? name ?? '',
    name: name ?? id ?? '',
    card,
    mask: asStr(firstOf(v, 'mask', 'maskText')),
    deepseekPersonaTags: pickArray<string>(v, 'deepseekPersonaTags', 'personaTags', 'tags'),
    avatarUrl: asStr(firstOf(v, 'avatarUrl', 'avatar')),
    preset: asBool(firstOf(v, 'preset', 'isPreset')),
    createdAt: asStr(v.createdAt),
  };
}

export const characters = {
  async list(): Promise<Character[]> {
    const data = await http.get<unknown>('/api/characters');
    return pickArray<unknown>(data, 'characters', 'items', 'list')
      .map(toCharacter)
      .filter((c): c is Character => !!c);
  },
  async create(body: Record<string, unknown>): Promise<Character | undefined> {
    const data = await http.post<unknown>('/api/characters', body);
    return toCharacter(pickRecord(data, 'character') ?? data);
  },
  async update(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/characters/${encodeURIComponent(id)}`, patch);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/characters/${encodeURIComponent(id)}`);
  },
  async importPng(file: File): Promise<Character | undefined> {
    const fd = new FormData();
    fd.append('file', file);
    const data = await http.upload<unknown>('/api/characters/import-png', fd);
    return toCharacter(pickRecord(data, 'character') ?? data);
  },
  exportPng(id: string): Promise<void> {
    return downloadFile(`/api/characters/${encodeURIComponent(id)}/export-png`, `${id}.png`);
  },
  async uploadAvatar(id: string, file: File): Promise<{ avatarUrl?: string }> {
    const fd = new FormData();
    fd.append('file', file);
    const data = await http.upload<unknown>(`/api/characters/${encodeURIComponent(id)}/avatar`, fd);
    return { avatarUrl: asStr(firstOf(isRecord(data) ? data : {}, 'avatarUrl', 'url')) };
  },
};

/* ---------------- 世界书 ---------------- */

function toEntry(v: unknown): WorldEntry | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'entryId'));
  if (!id) return undefined;
  const keys = pickArray<string>(v, 'keys', 'keywords', 'primaryKeys');
  const secondKeys = pickArray<string>(v, 'secondKeys', 'secondaryKeys', 'secondary_keys');
  return {
    id,
    botId: asStr(v.botId),
    keys,
    secondKeys,
    logic: asStr(firstOf(v, 'logic', 'matchLogic')) ?? 'AND_ANY',
    probability: asNum(firstOf(v, 'probability', 'triggerProbability')) ?? 100,
    priority: asNum(v.priority) ?? 0,
    position: asStr(v.position) ?? 'before',
    constant: asBool(firstOf(v, 'constant', 'isConstant')) ?? false,
    enabled: asBool(v.enabled) ?? true,
    content: asStr(firstOf(v, 'content', 'text')),
    comment: asStr(v.comment),
  };
}

export const worldbook = {
  async list(botId: string): Promise<WorldEntry[]> {
    const data = await http.get<unknown>('/api/world-entries', { botId });
    return pickArray<unknown>(data, 'entries', 'items', 'list')
      .map(toEntry)
      .filter((e): e is WorldEntry => !!e);
  },
  async create(body: Record<string, unknown>): Promise<WorldEntry | undefined> {
    const data = await http.post<unknown>('/api/world-entries', body);
    return toEntry(pickRecord(data, 'entry') ?? data);
  },
  async update(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/world-entries/${encodeURIComponent(id)}`, patch);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/world-entries/${encodeURIComponent(id)}`);
  },
  async test(botId: string, text: string): Promise<{ matchedIds: string[]; raw: unknown }> {
    const data = await http.post<unknown>('/api/world-entries/test', { botId, text });
    const rec = isRecord(data) ? data : {};
    const rows = pickArray<unknown>(rec, 'matches', 'matched', 'results', 'hits');
    const matchedIds = rows
      .map((r) => (isRecord(r) ? asStr(firstOf(r, 'id', 'entryId')) ?? '' : asStr(r) ?? ''))
      .filter((s) => s !== '');
    return { matchedIds, raw: data };
  },
};

/* ---------------- 联系人与关系 ---------------- */

function toContact(v: unknown): Contact | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'contactId'));
  const name = asStr(firstOf(v, 'name', 'nickname', 'displayName'));
  if (!id && !name) return undefined;
  return {
    id: id ?? name ?? '',
    name: name ?? id ?? '',
    botId: asStr(v.botId),
    avatarUrl: asStr(firstOf(v, 'avatarUrl', 'avatar')),
    profile: pickRecord(v, 'profile', 'meta'),
    lastActiveAt: asStr(firstOf(v, 'lastActiveAt', 'lastSeenAt')),
  };
}

export const contacts = {
  async list(botId: string): Promise<Contact[]> {
    const data = await http.get<unknown>('/api/contacts', { botId });
    return pickArray<unknown>(data, 'contacts', 'items', 'list')
      .map(toContact)
      .filter((c): c is Contact => !!c);
  },
  async get(id: string): Promise<Contact | undefined> {
    const data = await http.get<unknown>(`/api/contacts/${encodeURIComponent(id)}`);
    return toContact(pickRecord(data, 'contact') ?? data);
  },
  async update(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/contacts/${encodeURIComponent(id)}`, patch);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/contacts/${encodeURIComponent(id)}`);
  },
};

function toRelation(v: unknown): Relation {
  const rec = isRecord(v) ? v : {};
  return {
    id: asStr(rec.id),
    botId: asStr(rec.botId),
    fromContactId: asStr(firstOf(rec, 'fromContactId', 'from', 'sourceId')),
    toContactId: asStr(firstOf(rec, 'toContactId', 'to', 'targetId')),
    fromName: asStr(firstOf(rec, 'fromName', 'sourceName')),
    toName: asStr(firstOf(rec, 'toName', 'targetName')),
    type: asStr(firstOf(rec, 'type', 'relation', 'kind')),
    description: asStr(firstOf(rec, 'description', 'desc', 'note')),
  };
}

export const relations = {
  async list(botId: string): Promise<Relation[]> {
    const data = await http.get<unknown>('/api/relations', { botId });
    return pickArray<unknown>(data, 'relations', 'items', 'list').map(toRelation);
  },
  async create(botId: string, body: Record<string, unknown>): Promise<unknown> {
    return http.post('/api/relations', body, { botId });
  },
};

/* ---------------- 记忆 ---------------- */

function toMemory(v: unknown): Memory | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'memoryId'));
  if (!id) return undefined;
  return {
    id,
    botId: asStr(v.botId),
    sender: asStr(firstOf(v, 'sender', 'contactId', 'owner')),
    category: asStr(firstOf(v, 'category', 'type')),
    importance: asNum(v.importance),
    eventTime: asStr(firstOf(v, 'eventTime', 'event_time', 'happenedAt')),
    provenance: asStr(firstOf(v, 'provenance', 'source')),
    volatility: asStr(firstOf(v, 'volatility', 'volatilityLevel')),
    content: asStr(firstOf(v, 'content', 'text', 'event')),
    tags: pickArray<string>(v, 'tags', 'keywords'),
    supersededBy: asStr(firstOf(v, 'supersededBy', 'superseded_by')),
    supersedes: asStr(firstOf(v, 'supersedes', 'supersedesId')),
    validUntil: asStr(firstOf(v, 'validUntil', 'valid_until')),
    deletedAt: asStr(firstOf(v, 'deletedAt', 'deleted_at')),
    createdAt: asStr(v.createdAt),
  };
}

export const memories = {
  async list(params: { botId: string; sender?: string; includeDeleted?: boolean }): Promise<Memory[]> {
    const data = await http.get<unknown>('/api/memories', {
      botId: params.botId,
      sender: params.sender,
      includeDeleted: params.includeDeleted,
    });
    return pickArray<unknown>(data, 'memories', 'items', 'list')
      .map(toMemory)
      .filter((m): m is Memory => !!m);
  },
  async create(body: Record<string, unknown>): Promise<unknown> {
    return http.post('/api/memories', body);
  },
  async update(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/memories/${encodeURIComponent(id)}`, patch);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/memories/${encodeURIComponent(id)}`);
  },
  async restore(id: string): Promise<unknown> {
    return http.post(`/api/memories/${encodeURIComponent(id)}/restore`);
  },
  async consolidate(botId: string, sender: string, dryRun: boolean): Promise<unknown> {
    return http.post('/api/memories/consolidate', { botId, sender, dryRun });
  },
};

/* ---------------- 日记 ---------------- */

function toDiary(v: unknown): Diary | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'diaryId'));
  if (!id) return undefined;
  return {
    id,
    botId: asStr(v.botId),
    date: asStr(firstOf(v, 'date', 'day', 'createdAt')),
    content: asStr(firstOf(v, 'content', 'text', 'body')),
    mood: asStr(v.mood),
    createdAt: asStr(v.createdAt),
  };
}

export const diary = {
  async list(botId: string): Promise<Diary[]> {
    const data = await http.get<unknown>('/api/diaries', { botId });
    return pickArray<unknown>(data, 'diaries', 'items', 'list')
      .map(toDiary)
      .filter((d): d is Diary => !!d);
  },
  async get(id: string): Promise<Diary | undefined> {
    const data = await http.get<unknown>(`/api/diaries/${encodeURIComponent(id)}`);
    return toDiary(pickRecord(data, 'diary') ?? data);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/diaries/${encodeURIComponent(id)}`);
  },
  async write(botId: string): Promise<unknown> {
    return http.post('/api/diaries/write', { botId });
  },
};

/* ---------------- 相册 ---------------- */

function toPhoto(v: unknown): Photo | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'photoId'));
  if (!id) return undefined;
  return {
    id,
    botId: asStr(v.botId),
    url: asStr(firstOf(v, 'url', 'imageUrl', 'photoUrl')),
    caption: asStr(firstOf(v, 'caption', 'description')),
    tags: pickArray<string>(v, 'tags'),
    createdAt: asStr(v.createdAt),
  };
}

export const photos = {
  async list(botId: string): Promise<Photo[]> {
    const data = await http.get<unknown>('/api/photos', { botId });
    return pickArray<unknown>(data, 'photos', 'items', 'list')
      .map(toPhoto)
      .filter((p): p is Photo => !!p);
  },
  async upload(botId: string, file: File, caption?: string): Promise<unknown> {
    const fd = new FormData();
    fd.append('file', file);
    if (caption) fd.append('caption', caption);
    return http.upload('/api/photos', fd, { botId });
  },
  async update(id: string, botId: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/photos/${encodeURIComponent(id)}`, patch, { botId });
  },
  async remove(id: string, botId: string): Promise<unknown> {
    return http.del(`/api/photos/${encodeURIComponent(id)}`, { botId });
  },
};

/* ---------------- 定时消息 ---------------- */

function toScheduled(v: unknown): ScheduledMessage | undefined {
  if (!isRecord(v)) return undefined;
  const id = asStr(firstOf(v, 'id', 'scheduledId', 'jobId'));
  if (!id) return undefined;
  return {
    id,
    botId: asStr(v.botId),
    fireAt: asStr(firstOf(v, 'fireAt', 'fire_at', 'scheduledAt')),
    prompt: asStr(firstOf(v, 'prompt', 'text', 'content')),
    origin: asStr(firstOf(v, 'origin', 'source', 'createdBy')),
    status: asStr(firstOf(v, 'status', 'state')),
    strictness: asStr(v.strictness),
    createdAt: asStr(v.createdAt),
  };
}

export const scheduled = {
  async list(botId: string): Promise<ScheduledMessage[]> {
    const data = await http.get<unknown>('/api/scheduled-messages', { botId });
    return pickArray<unknown>(data, 'scheduledMessages', 'messages', 'items', 'list')
      .map(toScheduled)
      .filter((s): s is ScheduledMessage => !!s);
  },
  async create(body: Record<string, unknown>): Promise<unknown> {
    return http.post('/api/scheduled-messages', body);
  },
  async update(id: string, patch: Record<string, unknown>): Promise<unknown> {
    return http.patch(`/api/scheduled-messages/${encodeURIComponent(id)}`, patch);
  },
  async remove(id: string): Promise<unknown> {
    return http.del(`/api/scheduled-messages/${encodeURIComponent(id)}`);
  },
};

/* ---------------- 铁律 ---------------- */

export const rules = {
  async get(botId: string): Promise<PersonaRules> {
    const data = await http.get<unknown>('/api/persona-rules', { botId });
    const rec = isRecord(data) ? data : {};
    return {
      content: asStr(firstOf(rec, 'content', 'text', 'rules')) ?? '',
      enabled: asBool(firstOf(rec, 'enabled', 'isEnabled')) ?? true,
    };
  },
  async put(botId: string, body: PersonaRules): Promise<unknown> {
    return http.put('/api/persona-rules', body, { botId });
  },
};

/* ---------------- 全局设置 ---------------- */

export const settings = {
  async getAi(): Promise<Record<string, unknown>> {
    const data = await http.get<unknown>('/api/settings/ai');
    return isRecord(data) ? data : {};
  },
  async putAi(body: Record<string, unknown>): Promise<unknown> {
    return http.put('/api/settings/ai', body);
  },
  async getPlatform(): Promise<Record<string, unknown>> {
    const data = await http.get<unknown>('/api/settings/platform');
    return isRecord(data) ? data : {};
  },
  async putPlatform(body: Record<string, unknown>): Promise<unknown> {
    return http.put('/api/settings/platform', body);
  },
};

/* ---------------- 聊天 ---------------- */

export const chat = {
  async send(botId: string, sender: string, text: string): Promise<ChatMessage[]> {
    const data = await http.post<unknown>('/api/chat', { botId, sender, text });
    return normalizeMessages(data);
  },
  async startBuffer(botId: string, text: string): Promise<BufferState> {
    const data = await http.post<unknown>('/api/chat/buffer', { botId, text });
    const rec = isRecord(data) ? data : {};
    return { fireAt: asStr(rec.fireAt), buffered: asNum(rec.buffered), count: asNum(rec.count) };
  },
  async getBuffer(botId: string, sender?: string): Promise<BufferState> {
    const data = await http.get<unknown>('/api/chat/buffer', { botId, sender });
    const rec = isRecord(data) ? data : {};
    return { fireAt: asStr(rec.fireAt), buffered: asNum(rec.buffered), count: asNum(rec.count) };
  },
  async flushBuffer(botId: string, sender: string): Promise<ChatMessage[]> {
    const data = await http.post<unknown>('/api/chat/buffer/flush', { botId, sender });
    return normalizeMessages(data);
  },
  async listMessages(botId: string, sender?: string, limit?: number): Promise<ChatMessage[]> {
    const data = await http.get<unknown>('/api/messages', { botId, sender, limit });
    return normalizeMessages(data);
  },
  async listConversations(botId: string): Promise<unknown[]> {
    const data = await http.get<unknown>('/api/conversations', { botId });
    return pickArray<unknown>(data, 'conversations', 'items', 'list');
  },
  async edit(body: { botId: string; sender: string; messageId: string; text: string }): Promise<unknown> {
    return http.post('/api/chat/edit', body);
  },
  async regenerate(botId: string, sender: string): Promise<unknown> {
    return http.post('/api/chat/regenerate', { botId, sender });
  },
};

/* ---------------- 成长 ---------------- */

function toGrowth(data: unknown): GrowthData {
  const rec = isRecord(data) ? data : {};
  const profileRec = pickRecord(rec, 'profile') ?? rec;
  const dims = pickArray<unknown>(profileRec, 'dimensions', 'dims', 'axes');
  const dimensions = dims
    .filter(isRecord)
    .map((d) => ({
      name: asStr(firstOf(d, 'name', 'dimension', 'key')) ?? '未知维度',
      level: asNum(firstOf(d, 'level', 'value', 'rank')) ?? 0,
      max: asNum(firstOf(d, 'max', 'maxLevel')),
      description: asStr(firstOf(d, 'description', 'desc', 'note')),
    }));
  return {
    profile: {
      dimensions,
      summary: asStr(firstOf(profileRec, 'summary', 'description')),
      report: asStr(firstOf(profileRec, 'report', 'growthReport')),
      version: asNum(firstOf(profileRec, 'version', 'profileVersion')),
    },
    versions: pickArray<unknown>(rec, 'versions', 'history', 'versionHistory')
      .filter(isRecord)
      .map((v) => ({
        version: asNum(firstOf(v, 'version', 'v')),
        createdAt: asStr(firstOf(v, 'createdAt', 'time')),
        summary: asStr(firstOf(v, 'summary', 'note', 'description')),
        author: asStr(firstOf(v, 'author', 'by')),
      })),
    proposals: pickArray<unknown>(rec, 'proposals', 'pendingProposals', 'pending')
      .filter(isRecord)
      .map((p) => ({
        id: asStr(firstOf(p, 'id', 'proposalId')) ?? '',
        kind: asStr(firstOf(p, 'kind', 'type')),
        title: asStr(firstOf(p, 'title', 'name')),
        summary: asStr(firstOf(p, 'summary', 'description', 'reason')),
        evidence: pickArray<string>(p, 'evidence', 'evidenceChain'),
        payload: pickRecord(p, 'payload', 'changes', 'diff'),
        status: asStr(firstOf(p, 'status', 'state')),
        createdAt: asStr(p.createdAt),
      }))
      .filter((p) => p.id !== ''),
    window: (() => {
      const w = pickRecord(rec, 'window', 'reviewWindow', 'nextReview');
      if (!w) return undefined;
      return {
        nextAt: asStr(firstOf(w, 'nextAt', 'next', 'nextReviewAt')),
        lastAt: asStr(firstOf(w, 'lastAt', 'last', 'lastReviewAt')),
        reason: asStr(w.reason),
      };
    })(),
  };
}

export const growth = {
  async get(botId: string): Promise<GrowthData> {
    const data = await http.get<unknown>('/api/growth', { botId });
    return toGrowth(data);
  },
  async evaluate(botId: string): Promise<unknown> {
    return http.post('/api/growth', { action: 'evaluate', botId });
  },
  async rollback(botId: string, version?: number): Promise<unknown> {
    return http.post('/api/growth', { action: 'rollback', botId, version });
  },
  async decide(proposalId: string, decision: string, extra?: Record<string, unknown>): Promise<unknown> {
    return http.post(`/api/growth/proposals/${encodeURIComponent(proposalId)}`, { decision, ...extra });
  },
};

/* ---------------- 插件 ---------------- */

export const plugins = {
  async get(): Promise<PluginsData> {
    const data = await http.get<unknown>('/api/plugins');
    const rec = isRecord(data) ? data : {};
    return {
      mcp: pickArray<unknown>(rec, 'mcp', 'mcpServers', 'servers')
        .filter(isRecord)
        .map((s) => ({
          name: asStr(firstOf(s, 'name', 'serverName')) ?? '',
          transport: asStr(firstOf(s, 'transport', 'type')),
          command: asStr(s.command),
          args: pickArray<string>(s, 'args', 'argv'),
          url: asStr(s.url),
          status: asStr(firstOf(s, 'status', 'state', 'health')),
          tools: asNum(firstOf(s, 'tools', 'toolCount')),
        }))
        .filter((s) => s.name !== ''),
      skills: pickArray<unknown>(rec, 'skills', 'skillList')
        .filter(isRecord)
        .map((s) => ({
          name: asStr(firstOf(s, 'name', 'skill')) ?? '',
          description: asStr(firstOf(s, 'description', 'desc')),
          source: asStr(s.source),
        })),
      tools: pickArray<unknown>(rec, 'tools', 'inventory', 'toolInventory')
        .filter(isRecord)
        .map((t) => ({
          name: asStr(firstOf(t, 'name', 'tool')) ?? '',
          namespace: asStr(firstOf(t, 'namespace', 'source', 'server')),
          source: asStr(t.source),
          description: asStr(firstOf(t, 'description', 'desc')),
          enabledBots: pickArray<string>(t, 'enabledBots', 'enabled_bots', 'bots'),
        }))
        .filter((t) => t.name !== ''),
      dsh: pickArray<unknown>(rec, 'dsh', 'dshPlugins', 'plugins')
        .filter(isRecord)
        .map((p) => ({
          name: asStr(firstOf(p, 'name', 'plugin')) ?? '',
          version: asStr(p.version),
          description: asStr(firstOf(p, 'description', 'desc')),
          enabled: asBool(p.enabled),
        })),
    };
  },
  async addMcp(body: Record<string, unknown>): Promise<unknown> {
    return http.post('/api/plugins/mcp', body);
  },
  async removeMcp(name: string): Promise<unknown> {
    return http.del(`/api/plugins/mcp/${encodeURIComponent(name)}`);
  },
  async setToolEnabled(name: string, botId: string, enabled: boolean): Promise<unknown> {
    return http.patch('/api/plugins/tools', { name, botId, enabled });
  },
};

/* ---------------- Bilibili ---------------- */

export const bili = {
  async status(): Promise<BiliStatus> {
    const data = await http.get<unknown>('/api/bili/status');
    const rec = isRecord(data) ? data : {};
    return {
      logined: asBool(firstOf(rec, 'logined', 'loggedIn', 'isLogin')) ?? false,
      username: asStr(firstOf(rec, 'username', 'uname', 'nickname')),
      mid: asStr(firstOf(rec, 'mid', 'uid')) ?? undefined,
    };
  },
  async qrStart(): Promise<BiliQrState> {
    const data = await http.post<unknown>('/api/bili/qr/start');
    const rec = isRecord(data) ? data : {};
    return {
      status: asStr(firstOf(rec, 'status', 'state')),
      qrImage: asStr(firstOf(rec, 'qrImage', 'qr image', 'qrcodeImage', 'image')),
      qrUrl: asStr(firstOf(rec, 'qrUrl', 'url', 'qrcodeUrl')),
      message: asStr(rec.message),
    };
  },
  async qrStatus(): Promise<BiliQrState> {
    const data = await http.get<unknown>('/api/bili/qr/status');
    const rec = isRecord(data) ? data : {};
    return {
      status: asStr(firstOf(rec, 'status', 'state', 'code')),
      qrImage: asStr(firstOf(rec, 'qrImage', 'qrcodeImage', 'image')),
      qrUrl: asStr(firstOf(rec, 'qrUrl', 'url')),
      message: asStr(firstOf(rec, 'message', 'msg')),
    };
  },
  async cmd(argv: string[]): Promise<{ output?: string }> {
    const data = await http.post<unknown>('/api/bili/cmd', { argv });
    const rec = isRecord(data) ? data : {};
    return { output: asStr(firstOf(rec, 'output', 'stdout', 'result', 'text')) };
  },
};

/* ---------------- 调试 ---------------- */

export const debug = {
  async systemPrompt(botId: string, sender?: string): Promise<PromptViewData> {
    const data = await http.get<unknown>('/api/debug/system-prompt', { botId, sender });
    const rec = isRecord(data) ? data : {};
    const layers = pickArray<unknown>(rec, 'layers', 'sections')
      .filter(isRecord)
      .map((l) => {
        const content = asStr(firstOf(l, 'content', 'text', 'body')) ?? '';
        return {
          name: asStr(firstOf(l, 'name', 'layer', 'title')) ?? '未命名层',
          source: asStr(firstOf(l, 'source', 'origin', 'from')),
          content,
          chars: asNum(firstOf(l, 'chars', 'length')) ?? content.length,
        };
      });
    return {
      layers,
      totalChars: asNum(firstOf(rec, 'totalChars', 'total', 'totalLength')) ?? layers.reduce((a, l) => a + l.chars, 0),
      compiled: asStr(firstOf(rec, 'compiled', 'full', 'final')),
    };
  },
  async audit(botId: string, category?: string): Promise<AuditEntry[]> {
    const data = await http.get<unknown>('/api/debug/audit', { botId, category });
    return pickArray<unknown>(data, 'entries', 'items', 'list', 'logs')
      .filter(isRecord)
      .map((e) => ({
        id: asStr(firstOf(e, 'id', 'entryId')),
        time: asStr(firstOf(e, 'time', 'createdAt', 'timestamp')),
        category: asStr(firstOf(e, 'category', 'type')),
        botId: asStr(e.botId),
        summary: asStr(firstOf(e, 'summary', 'title', 'message')),
        detail: asStr(firstOf(e, 'detail', 'content', 'body')),
      }));
  },
};

/* ---------------- 工具调用事件（SSE 用） ---------------- */

export function normalizeToolCall(raw: unknown, idx = 0): ToolCallEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const name = asStr(firstOf(raw, 'name', 'toolName', 'tool', 'tool_name'));
  if (!name) return undefined;
  const statusRaw = (asStr(firstOf(raw, 'status', 'state', 'phase')) ?? 'running').toLowerCase();
  const status: ToolCallEvent['status'] =
    statusRaw.includes('fail') || statusRaw.includes('error')
      ? 'failed'
      : statusRaw.includes('done') || statusRaw.includes('finish') || statusRaw.includes('ok') || statusRaw.includes('end')
        ? 'done'
        : 'running';
  return { id: asStr(firstOf(raw, 'id', 'callId')) ?? `tool-${idx}`, name, status };
}
