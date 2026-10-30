#!/usr/bin/env node
/**
 * 微信渠道验证（历史入口，保留兼容）。
 *
 * 旧实现已按 SPEC §3 重写：iLink 协议客户端迁到 src/ilink-client.ts，扫码会话到
 * src/ilink-bind.ts，长轮询/出站到 src/ilink-account.ts（旧 src/ilink.ts 已删除）。
 * 本文件保留为**兼容入口**，直接运行完整的 mock 验证套件（见 verify-wechat.mjs）。
 *
 * 运行：node scripts/verify-wechat-ilink.mjs
 */
import './verify-wechat.mjs'
