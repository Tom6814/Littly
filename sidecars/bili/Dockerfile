# Littly bili sidecar —— bili-agent (bili-cli) + HTTP wrapper
# 构建（仓库根执行）：docker build -f sidecars/bili/Dockerfile -t littly-bili sidecars/bili
# 运行：见 deploy/docker-compose.yml（BILI_CLI_HOME=/app/data/bili-cli，卷 bili-data:/app/data）

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    BILI_CLI_HOME=/app/bili-data/bili-cli \
    BILI_SIDECAR_DATA=/app/bili-data/wrapper

# ffmpeg：可选依赖——高清抽帧（video frames -q hd）、语音转写、投稿封面截取需要
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖先行，命中层缓存；bili-agent 版本钉死（0.9.1 实测通过，mcp extra 提供 17 工具的 MCP 服务器）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "bili-agent[mcp]==0.9.1"

COPY wrapper.py allowlist.py ./

RUN mkdir -p /app/bili-data
VOLUME ["/app/bili-data"]

EXPOSE 3010

HEALTHCHECK --interval=15s --timeout=5s --retries=8 --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:3010/health',timeout=3)"

CMD ["uvicorn", "wrapper:app", "--host", "0.0.0.0", "--port", "3010"]
