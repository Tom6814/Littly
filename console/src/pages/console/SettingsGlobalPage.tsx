import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import SettingsIcon from '@mui/icons-material/Settings';
import { settings } from '../../api/endpoints';
import { isRecord } from '../../api/client';
import { errMsg, useUiStore } from '../../stores/uiStore';
import PageHeader from '../../components/PageHeader';
import { FieldGrid, SettingsField } from '../../components/SettingsField';

const SECRET_RE = /key|token|secret|password|apikey|api_key/i;

const LABELS: Record<string, string> = {
  baseURL: 'API 地址',
  apiKey: 'API Key',
  chatModel: '对话模型',
  growthModel: '成长模型',
  model: '模型',
  webSearch: '联网搜索',
  webSearchEnabled: '联网搜索',
  registrationEnabled: '开放注册',
  registration: '开放注册',
  embedding: 'Embedding 服务',
  image: '图像生成服务',
};

function label(k: string): string {
  return LABELS[k] ?? k;
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}

/** 渲染一个设置对象：顶层基元 → 字段；嵌套对象 → 小节 */
function SettingsObjectView({
  value,
  onChange,
  nestedTitles,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  nestedTitles?: Record<string, string>;
}) {
  const primitives = Object.entries(value).filter(([, v]) => typeof v !== 'object' || v === null);
  const nested = Object.entries(value).filter(([, v]) => isRecord(v));
  return (
    <Stack spacing={2.5}>
      {primitives.length > 0 && (
        <FieldGrid>
          {primitives.map(([k, v]) => (
            <SettingsField
              key={k}
              label={label(k)}
              value={v}
              secret={SECRET_RE.test(k)}
              multiline={typeof v === 'string' && v.length > 90}
              onChange={(nv) => onChange({ ...value, [k]: nv })}
            />
          ))}
        </FieldGrid>
      )}
      {nested.map(([k, v]) => (
        <Box key={k}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {nestedTitles?.[k] ?? label(k)}
          </Typography>
          <FieldGrid>
            {Object.entries(v).map(([fk, fv]) => (
              <SettingsField
                key={fk}
                label={label(fk)}
                value={fv}
                secret={SECRET_RE.test(fk)}
                onChange={(nv) => onChange({ ...value, [k]: { ...(v as Record<string, unknown>), [fk]: nv } })}
              />
            ))}
          </FieldGrid>
        </Box>
      ))}
      {primitives.length === 0 && nested.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          暂无可配置项。
        </Typography>
      )}
    </Stack>
  );
}

export default function SettingsGlobalPage() {
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const aiQuery = useQuery({ queryKey: ['settings-ai'], queryFn: settings.getAi });
  const platformQuery = useQuery({ queryKey: ['settings-platform'], queryFn: settings.getPlatform });

  const [aiEdited, setAiEdited] = useState<Record<string, unknown> | null>(null);
  const [platformEdited, setPlatformEdited] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    setAiEdited(null);
  }, [aiQuery.data]);
  useEffect(() => {
    setPlatformEdited(null);
  }, [platformQuery.data]);

  const aiOriginal = aiQuery.data ?? {};
  const aiValue = aiEdited ?? aiOriginal;
  const aiDirty = aiEdited !== null && pretty(aiEdited) !== pretty(aiOriginal);

  const platformOriginal = platformQuery.data ?? {};
  const platformValue = platformEdited ?? platformOriginal;
  const platformDirty = platformEdited !== null && pretty(platformEdited) !== pretty(platformOriginal);

  const saveAiMutation = useMutation({
    mutationFn: () => settings.putAi(aiValue),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings-ai'] });
      setAiEdited(null);
      showSnack('AI 服务配置已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const savePlatformMutation = useMutation({
    mutationFn: () => settings.putPlatform(platformValue),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings-platform'] });
      setPlatformEdited(null);
      showSnack('平台设置已保存', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  return (
    <Box>
      <PageHeader title="全局设置" subtitle="AI 服务与平台开关，对她所有生效" />

      {aiQuery.isPending ? (
        <Skeleton variant="rounded" height={260} sx={{ mb: 3 }} />
      ) : (
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <SettingsIcon fontSize="small" sx={{ color: 'primary.main' }} />
              <Typography variant="subtitle2">AI 服务配置</Typography>
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button size="small" disabled={!aiDirty} onClick={() => setAiEdited(null)}>
                撤销
              </Button>
              <Button size="small" variant="contained" disabled={!aiDirty || saveAiMutation.isPending} onClick={() => saveAiMutation.mutate()}>
                {saveAiMutation.isPending ? '保存中…' : aiDirty ? '保存' : '无修改'}
              </Button>
            </Stack>
          </Stack>
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            API Key 保存后由后端打码显示；留空表示保持不变。Embedding / 图像未单独配置时沿用主服务配置。
          </Alert>
          <SettingsObjectView
            value={aiValue}
            onChange={setAiEdited}
            nestedTitles={{ embedding: 'Embedding（向量）三项', image: '图像生成三项' }}
          />
        </Paper>
      )}

      {platformQuery.isPending ? (
        <Skeleton variant="rounded" height={160} />
      ) : (
        <>
          <Divider sx={{ mb: 2 }} />
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
              <Typography variant="subtitle2">平台设置</Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" disabled={!platformDirty} onClick={() => setPlatformEdited(null)}>
                  撤销
                </Button>
                <Button size="small" variant="contained" disabled={!platformDirty || savePlatformMutation.isPending} onClick={() => savePlatformMutation.mutate()}>
                  {savePlatformMutation.isPending ? '保存中…' : platformDirty ? '保存' : '无修改'}
                </Button>
              </Stack>
            </Stack>
            <SettingsObjectView value={platformValue} onChange={setPlatformEdited} />
          </Paper>
        </>
      )}
    </Box>
  );
}
