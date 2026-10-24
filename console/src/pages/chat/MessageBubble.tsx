import type { MouseEvent } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import { useTheme } from '@mui/material/styles';
import MicIcon from '@mui/icons-material/Mic';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import BoltIcon from '@mui/icons-material/Bolt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import CircularProgress from '@mui/material/CircularProgress';
import dayjs from 'dayjs';
import type { ChatMessage, ChatMessagePiece } from '../../api/types';
import { bubbleSx } from '../../theme';

function ToolChip({ piece }: { piece: ChatMessagePiece }) {
  return (
    <Chip
      size="small"
      icon={
        piece.status === 'running' ? (
          <CircularProgress size={13} sx={{ mx: 0.5 }} />
        ) : piece.status === 'failed' ? (
          <ErrorOutlineIcon sx={{ fontSize: 15 }} />
        ) : piece.status === 'done' ? (
          <CheckCircleOutlineIcon sx={{ fontSize: 15 }} />
        ) : (
          <BoltIcon sx={{ fontSize: 15 }} />
        )
      }
      label={`工具 · ${piece.name ?? '未知'}`}
      variant="outlined"
      sx={{ my: 0.25 }}
    />
  );
}

function PieceView({ piece, onImageClick }: { piece: ChatMessagePiece; onImageClick: (url: string) => void }) {
  switch (piece.type) {
    case 'voice': {
      return (
        <Tooltip title={piece.text ? `原文：${piece.text}` : '语音消息'}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 180, flexWrap: 'wrap' }}>
            <MicIcon fontSize="small" sx={{ opacity: 0.7 }} />
            {piece.url ? (
              <Box component="audio" controls src={piece.url} sx={{ height: 36, maxWidth: 240 }} />
            ) : (
              <Typography variant="body2" color="text.secondary">
                语音暂不可回放
              </Typography>
            )}
            {piece.text && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 180 }}>
                {piece.text}
              </Typography>
            )}
          </Box>
        </Tooltip>
      );
    }
    case 'image': {
      if (!piece.url) return <Typography variant="body2">（图片缺失）</Typography>;
      return (
        <Box
          component="img"
          src={piece.url}
          alt={piece.text ?? '图片'}
          onClick={() => onImageClick(piece.url ?? '')}
          sx={{ maxWidth: 260, maxHeight: 320, borderRadius: 2, cursor: 'zoom-in', display: 'block' }}
        />
      );
    }
    case 'file': {
      return (
        <Tooltip title={piece.url ?? '文件'}>
          <Chip
            size="small"
            icon={<InsertDriveFileIcon sx={{ fontSize: 15 }} />}
            label={piece.name ?? '文件'}
            component="a"
            href={piece.url ?? undefined}
            target="_blank"
            clickable={!!piece.url}
            variant="outlined"
          />
        </Tooltip>
      );
    }
    case 'tool_call':
      return <ToolChip piece={piece} />;
    case 'text':
    default:
      if (!piece.text) return null;
      return (
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 }}>
          {piece.text}
        </Typography>
      );
  }
}

interface Props {
  message: ChatMessage;
  own: boolean;
  botName: string;
  botAvatar?: string;
  senderName?: string;
  senderAvatar?: string;
  onContextMenu: (e: MouseEvent<HTMLDivElement>, message: ChatMessage) => void;
  onImageClick: (url: string) => void;
}

export default function MessageBubble({
  message,
  own,
  botName,
  botAvatar,
  senderName,
  senderAvatar,
  onContextMenu,
  onImageClick,
}: Props) {
  const theme = useTheme();
  const time = message.createdAt && dayjs(message.createdAt).isValid() ? dayjs(message.createdAt) : null;
  const timeText = time ? time.format('YYYY-MM-DD HH:mm:ss') : '';
  const visible = message.pieces.filter((p) => (p.type === 'text' ? !!p.text : true));
  if (visible.length === 0) return null;

  const authorName = own ? senderName ?? '访客' : botName;
  const avatar = own ? senderAvatar : botAvatar;

  return (
    <Tooltip title={timeText} placement={own ? 'left' : 'right'} enterDelay={400} disableHoverListener={!timeText}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: own ? 'row-reverse' : 'row',
          gap: 1,
          alignItems: 'flex-start',
          maxWidth: '100%',
        }}
        onContextMenu={(e) => onContextMenu(e, message)}
      >
        <Avatar src={avatar} sx={{ width: 30, height: 30, fontSize: 13, mt: 0.5 }}>
          {authorName.slice(0, 1)}
        </Avatar>
        <Box
          sx={{
            ...bubbleSx(theme, own),
            px: 1.75,
            py: 1.1,
            minWidth: 0,
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
            {authorName}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: own ? 'flex-end' : 'flex-start' }}>
            {visible.map((p, i) => (
              <PieceView key={i} piece={p} onImageClick={onImageClick} />
            ))}
          </Box>
        </Box>
      </Box>
    </Tooltip>
  );
}
