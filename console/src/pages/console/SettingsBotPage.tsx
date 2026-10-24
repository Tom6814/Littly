import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TuneIcon from '@mui/icons-material/Tune';
import Typography from '@mui/material/Typography';
import { bots } from '../../api/endpoints';
import { isRecord } from '../../api/client';
import type { BotChannels } from '../../api/types';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId, useCurrentBot } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import { FieldGrid, SettingsField, EffectiveHint } from '../../components/SettingsField';

const SECRET_RE = /key|token|secret|password|apikey|api_key/i;

const GROUP_META: { key: string; title: string; subtitle?: string }[] = [
  { key: 'ai', title: 'AI 参数', subtitle: '模型与采样参数；未设置的项沿用全局配置' },
  { key: 'humanize', title: '拟人化', subtitle: '打字节奏、口语习惯等拟真行为' },
  { key: 'proactive', title: '主动性与静默时段', subtitle: '主动性归模型判断，这里只是物理防线' },
  { key: 'memory', title: '记忆' },
  { key: 'diary', title: '日记' },
  { key: 'voice', title: '语音' },
  { key: 'call', title: '通话' },
];

const CHANNEL_META: Record<string, { title: string; help?: string }> = {
  telegram: { title: 'Telegram', help: 'Bot Token 在 @BotFather 创建' },
  snowluma: { title: 'SnowLuma（QQ 账号）', help: '使用 QQ 账号协议接入' },
  qq: { title: 'QQ 官方', help: 'QQ 开放平台的机器人凭证' },
  qqp: { title: 'QQ 个人', help: '个人 QQ 协议接入' },
  discord: { title: 'Discord', help: 'Discord Bot Token' },
  wechat: { title: '微信', help: '微信接入配置' },
};

const LABELS: Record<string, string> = {
  model: '模型',
  chatModel: '对话模型',
  growthModel: '成长模型',
  temperature: '温度',
  maxTokens: '最大回复长度',
  topP: 'Top P',
  presencePenalty: '存在惩罚',
  frequencyPenalty: '频率惩罚',
  baseURL: 'API 地址',
  apiKey: 'API Key',
  enabled: '启用',
  token: 'Token',
  botToken: 'Bot Token',
  appid: 'AppID',
  appId: 'AppID',
  appSecret: 'AppSecret',
  guildId: '服务器 ID',
  channelId: '频道 ID',
  selfId: '账号',
  password: '密码',
  endpoint: '接入点',
  webhook: 'Webhook',
  proxy: '代理',
  interval: '间隔（秒）',
  minInterval: '最小间隔（秒）',
  dailyLimit: '每日上限',
  quietStart: '静默开始',
  quietEnd: '静默结束',
  proactiveEnabled: '允许主动',
  typing: '打字机节奏',
  voiceEnabled: '启用语音',
  ttsVoice: '音色',
  autoDiary: '自动写日记',
  callEnabled: '启用通话',
};

function fieldLabel(k: string): string {
  return LABELS[k] ?? k;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}

export default function SettingsBotPage() {
  const botId = useBotId();
  const bot = useCurrentBot();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const botQuery = useQuery({
    queryKey: ['bot', botId],
    queryFn: () => bots.get(botId ?? ''),
    enabled: !!botId,
  });

  const channelsQuery = useQuery({
    queryKey: ['bot-channels', botId],
    queryFn: () => bots.channels(botId ?? ''),
    enabled: !!botId,
  });

  const original = botQuery.data?.settings ?? {};
  const [edited, setEdited] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    setEdited(null);
  }, [botId, botQuery.data]);

  const settingsObj: Record<string, unknown> = edited ?? original;
  const dirtySettings = edited !== null && prettyJson(edited) !== prettyJson(original);
  const effective = useMemo(() => {
    const e = original['effective'];
    return isRecord(e) ? e : undefined;
  }, [original]);

  const saveSettingsMutation = useMutation({
    mutationFn: () => bots.update(botId ?? '', { settings: settingsObj }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bot', botId] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      setEdited(null);
      showSnack('机器人设置已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  // 渠道
  const originalChannels: BotChannels = channelsQuery.data ?? {};
  const [editedChannels, setEditedChannels] = useState<BotChannels | null>(null);
  useEffect(() => {
    setEditedChannels(null);
  }, [botId, channelsQuery.data]);
  const channelsObj: BotChannels = editedChannels ?? originalChannels;
  const dirtyChannels = editedChannels !== null && prettyJson(editedChannels) !== prettyJson(originalChannels);

  const saveChannelsMutation = useMutation({
    mutationFn: () => bots.putChannels(botId ?? '', channelsObj),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bot-channels', botId] });
      setEditedChannels(null);
      showSnack('渠道配置已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const patchGroup = (group: string, key: string, value: unknown) => {
    setEdited((prev) => {
      const base: Record<string, unknown> = prev ? structuredClone(prev) : structuredClone(original);
      const g = isRecord(base[group]) ? { ...(base[group] as Record<string, unknown>) } : {};
      if (value === '' || value === undefined) delete g[key];
      else g[key] = value;
      base[group] = g;
      return base;
    });
  };

  const patchChannel = (channel: string, key: string, value: unknown) => {
    setEditedChannels((prev) => {
      const base: BotChannels = prev ? structuredClone(prev) : structuredClone(originalChannels);
      const existing = base[channel];
      const c: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
      c[key] = value;
      base[channel] = c;
      return base;
    });
  };

  const extraGroups = Object.keys(original).filter(
    (k) => !GROUP_META.some((g) => g.key === k) && isRecord(original[k]) && k !== 'effective',
  );

  if (!botId) {
    return (
      <Box>
        <PageHeader title="机器人设置" />
        <Alert severity="info">先选择一个机器人</Alert>
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title={`机器人设置 · ${bot?.name ?? ''}`}
        subtitle="系统给她的是权限与上下文，不是行为规则"
        actions={
          <Stack direction="row" spacing={1}>
            <Button disabled={!dirtySettings} onClick={() => setEdited(null)}>
              撤销
            </Button>
            <Button
              variant="contained"
              startIcon={<TuneIcon />}
              disabled={!dirtySettings || saveSettingsMutation.isPending}
              onClick={() => saveSettingsMutation.mutate()}
            >
              {saveSettingsMutation.isPending ? '保存中…' : dirtySettings ? '保存设置' : '无修改'}
            </Button>
          </Stack>
        }
      />

      {saveSettingsMutation.isSuccess && !dirtySettings && (
        <Alert severity="success" sx={{ mb: 2 }}>
          已保存
        </Alert>
      )}

      {botQuery.isPending ? (
        <Skeleton variant="rounded" height={320} />
      ) : (
        <>
          {GROUP_META.map((g) => {
            const groupVal = settingsObj[g.key];
            const groupRec = isRecord(groupVal) ? groupVal : {};
            const entries = Object.entries(groupRec).filter(([, v]) => typeof v !== 'object' || v === null);
            const hasContent = entries.length > 0 || (groupRec['effective'] !== undefined && g.key === 'ai');
            return (
              <Accordion key={g.key} defaultExpanded={g.key === 'ai'}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Typography variant="subtitle2">{g.title}</Typography>
                    {entries.length === 0 && !hasContent && (
                      <Chip size="small" label="未配置" variant="outlined" />
                    )}
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  {g.subtitle && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                      {g.subtitle}
                    </Typography>
                  )}
                  {entries.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      暂无可配置项。后端提供的字段会自动出现在这里。
                    </Typography>
                  ) : (
                    <FieldGrid>
                      {entries.map(([k, v]) => (
                        <Box key={k}>
                          <SettingsField
                            label={fieldLabel(k)}
                            value={v}
                            secret={SECRET_RE.test(k)}
                            onChange={(nv) => patchGroup(g.key, k, nv)}
                          />
                          {g.key === 'ai' && effective && <EffectiveHint value={effective[k]} />}
                        </Box>
                      ))}
                    </FieldGrid>
                  )}
                </AccordionDetails>
              </Accordion>
            );
          })}
          {extraGroups.map((k) => {
            const groupRec = original[k] as Record<string, unknown>;
            const entries = Object.entries(groupRec).filter(([, v]) => typeof v !== 'object' || v === null);
            return (
              <Accordion key={k}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="subtitle2">{fieldLabel(k)}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <FieldGrid>
                    {entries.map(([fk, fv]) => (
                      <SettingsField key={fk} label={fieldLabel(fk)} value={fv} secret={SECRET_RE.test(fk)} onChange={(nv) => patchGroup(k, fk, nv)} />
                    ))}
                  </FieldGrid>
                </AccordionDetails>
              </Accordion>
            );
          })}
        </>
      )}

      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
        渠道（她在场的方式）
      </Typography>

      {channelsQuery.isPending ? (
        <Skeleton variant="rounded" height={220} />
      ) : (
        <>
          <Stack spacing={1.5}>
            {Object.keys(CHANNEL_META).map((ch) => {
              const cfg = channelsObj[ch];
              const meta = CHANNEL_META[ch]!;
              const rec = isRecord(cfg) ? cfg : {};
              const enabled = rec['enabled'] === true;
              const entries = Object.entries(rec).filter(([k]) => k !== 'enabled');
              return (
                <Paper key={ch} variant="outlined" sx={{ p: 2 }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle2">{meta.title}</Typography>
                      {enabled && <Chip size="small" color="success" label="已启用" />}
                    </Stack>
                    <FormControlLabel
                      control={<Switch checked={enabled} onChange={(e) => patchChannel(ch, 'enabled', e.target.checked)} />}
                      label="启用"
                    />
                  </Stack>
                  {meta.help && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      {meta.help}
                    </Typography>
                  )}
                  {entries.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      打开开关后，在下方填写该渠道的配置。
                    </Typography>
                  ) : (
                    <FieldGrid>
                      {entries.map(([k, v]) => (
                        <SettingsField key={k} label={fieldLabel(k)} value={v} secret={SECRET_RE.test(k)} onChange={(nv) => patchChannel(ch, k, nv)} />
                      ))}
                    </FieldGrid>
                  )}
                </Paper>
              );
            })}
          </Stack>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
            <Button disabled={!dirtyChannels} onClick={() => setEditedChannels(null)}>
              撤销
            </Button>
            <Button variant="contained" disabled={!dirtyChannels || saveChannelsMutation.isPending} onClick={() => saveChannelsMutation.mutate()}>
              {saveChannelsMutation.isPending ? '保存中…' : dirtyChannels ? '保存渠道配置' : '无修改'}
            </Button>
          </Stack>
        </>
      )}
    </Box>
  );
}
