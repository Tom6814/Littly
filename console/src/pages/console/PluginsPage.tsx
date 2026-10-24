import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExtensionIcon from '@mui/icons-material/Extension';
import { plugins } from '../../api/endpoints';
import { errMsg, useUiStore } from '../../stores/uiStore';
import { useBotId } from '../../hooks';
import PageHeader from '../../components/PageHeader';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import { SkeletonList } from '../../components/Loading';

export default function PluginsPage() {
  const botId = useBotId();
  const queryClient = useQueryClient();
  const showSnack = useUiStore((s) => s.showSnack);

  const pluginsQuery = useQuery({ queryKey: ['plugins'], queryFn: plugins.get, staleTime: 30_000 });
  const data = pluginsQuery.data;

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', transport: 'stdio', command: '', argsText: '', url: '' });
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['plugins'] });

  const addMutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: form.name.trim(), transport: form.transport };
      if (form.transport === 'stdio') {
        body.command = form.command.trim();
        body.args = form.argsText.split(/\s+/).filter(Boolean);
      } else {
        body.url = form.url.trim();
      }
      return plugins.addMcp(body);
    },
    onSuccess: () => {
      setAddOpen(false);
      invalidate();
      showSnack('MCP 服务已添加', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const removeMutation = useMutation({
    mutationFn: (name: string) => plugins.removeMcp(name),
    onSuccess: () => {
      setRemoveTarget(null);
      invalidate();
      showSnack('已移除 MCP 服务', 'success');
    },
    onError: (e) => showSnack(errMsg(e), 'error'),
  });

  const toolToggleMutation = useMutation({
    mutationFn: (input: { name: string; enabled: boolean }) => plugins.setToolEnabled(input.name, botId ?? '', input.enabled),
    onSuccess: () => {
      invalidate();
      showSnack('工具授权已更新', 'success');
    },
    onError: (e) => {
      invalidate();
      showSnack(errMsg(e), 'error');
    },
  });

  const mcp = data?.mcp ?? [];
  const skills = data?.skills ?? [];
  const tools = data?.tools ?? [];
  const dsh = data?.dsh ?? [];

  return (
    <Box>
      <PageHeader
        title="插件"
        subtitle="给她的手脚：MCP 服务、技能与工具清单"
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
            添加 MCP 服务
          </Button>
        }
      />

      {pluginsQuery.isPending ? (
        <SkeletonList rows={4} />
      ) : (
        <>
          {/* MCP */}
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            MCP 服务（{mcp.length}）
          </Typography>
          {mcp.length === 0 ? (
            <EmptyState text="还没有接入 MCP 服务" hint="MCP 让她能链接更多东西" />
          ) : (
            <Grid container spacing={1.5} sx={{ mb: 3 }}>
              {mcp.map((s) => (
                <Grid key={s.name} size={{ xs: 12, sm: 6, md: 4 }}>
                  <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.75 }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" noWrap>
                          {s.name}
                        </Typography>
                        <Chip size="small" variant="outlined" label={s.transport ?? 'stdio'} />
                      </Stack>
                      <Tooltip title="移除">
                        <IconButton size="small" color="error" onClick={() => setRemoveTarget(s.name)}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
                      {s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')}
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                      {s.status && <Chip size="small" color={s.status === 'ok' || s.status === 'connected' ? 'success' : 'default'} label={s.status} />}
                      {s.tools !== undefined && <Chip size="small" variant="outlined" label={`${s.tools} 个工具`} />}
                    </Stack>
                  </Paper>
                </Grid>
              ))}
            </Grid>
          )}

          {/* Skills */}
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            技能（{skills.length}）
          </Typography>
          {skills.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              暂无技能
            </Typography>
          ) : (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
              {skills.map((s) => (
                <Tooltip key={s.name} title={s.description ?? s.name}>
                  <Chip icon={<ExtensionIcon sx={{ fontSize: 15 }} />} label={s.name} variant="outlined" />
                </Tooltip>
              ))}
            </Stack>
          )}

          <Divider sx={{ my: 2.5 }} />

          {/* 工具清单 */}
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            工具清单（{tools.length}）
          </Typography>
          {tools.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              暂无注册的工具
            </Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>工具</TableCell>
                    <TableCell>来源命名空间</TableCell>
                    <TableCell>说明</TableCell>
                    <TableCell align="right">对当前机器人启用</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tools.map((t) => {
                    const enabled = botId ? (t.enabledBots ?? []).includes(botId) : false;
                    return (
                      <TableRow key={`${t.namespace ?? ''}/${t.name}`} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>
                            {t.name}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip size="small" variant="outlined" label={t.namespace ?? t.source ?? '—'} />
                        </TableCell>
                        <TableCell sx={{ maxWidth: 320 }}>
                          <Typography variant="caption" color="text.secondary" noWrap title={t.description ?? ''} sx={{ display: 'block' }}>
                            {t.description ?? '—'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <FormControlLabel
                            control={
                              <Switch
                                checked={enabled}
                                disabled={!botId || toolToggleMutation.isPending}
                                onChange={(e) => toolToggleMutation.mutate({ name: t.name, enabled: e.target.checked })}
                              />
                            }
                            label=""
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          <Divider sx={{ my: 2.5 }} />

          {/* dsh 插件 */}
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            DSH 插件（{dsh.length}）
          </Typography>
          {dsh.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              暂无 dsh 插件
            </Typography>
          ) : (
            <Grid container spacing={1.5}>
              {dsh.map((p) => (
                <Grid key={p.name} size={{ xs: 12, sm: 6, md: 4 }}>
                  <Paper variant="outlined" sx={{ p: 1.75 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle2" sx={{ flexGrow: 1, minWidth: 0 }} noWrap>
                        {p.name}
                      </Typography>
                      {p.version && <Chip size="small" variant="outlined" label={`v${p.version}`} />}
                      {p.enabled !== undefined && <Chip size="small" color={p.enabled ? 'success' : 'default'} label={p.enabled ? '启用' : '停用'} />}
                    </Stack>
                    {p.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {p.description}
                      </Typography>
                    )}
                  </Paper>
                </Grid>
              ))}
            </Grid>
          )}
        </>
      )}

      {/* 添加 MCP */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>添加 MCP 服务</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="名称" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} fullWidth required />
            <TextField select label="传输方式" value={form.transport} onChange={(e) => setForm((p) => ({ ...p, transport: e.target.value }))} fullWidth>
              <MenuItem value="stdio">stdio（本地进程）</MenuItem>
              <MenuItem value="http">http（远程服务）</MenuItem>
            </TextField>
            {form.transport === 'stdio' ? (
              <>
                <TextField label="启动命令" placeholder="如：npx -y @modelcontextprotocol/server-xxx" value={form.command} onChange={(e) => setForm((p) => ({ ...p, command: e.target.value }))} fullWidth />
                <TextField label="参数（空格分隔）" value={form.argsText} onChange={(e) => setForm((p) => ({ ...p, argsText: e.target.value }))} fullWidth />
              </>
            ) : (
              <TextField label="服务地址" placeholder="https://…" value={form.url} onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))} fullWidth />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={!form.name.trim() || addMutation.isPending || (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())}
            onClick={() => addMutation.mutate()}
          >
            {addMutation.isPending ? '添加中…' : '添加'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!removeTarget}
        title={`移除 MCP 服务「${removeTarget ?? ''}」？`}
        content="她的相关工具将不再可用。"
        danger
        loading={removeMutation.isPending}
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget)}
        onClose={() => setRemoveTarget(null)}
      />

      <Alert severity="info" variant="outlined" sx={{ mt: 3 }}>
        新增能力一律走「能力位 + 工具清单」动态呈现——不在人格层写死任何具体工具的行为指令。
      </Alert>
    </Box>
  );
}
