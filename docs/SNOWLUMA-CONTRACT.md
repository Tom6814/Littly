# SnowLuma 适配器契约（子代理调研产物，2026-10-25，v2.2.0）

> 结论全部来自官方文档站 / SnowLumaDocs 仓库 / 主仓库源码。✅=文档+源码双确认；⚠️=动作存在但返回字段细节未验证（运行时探测）；❌=确认不支持。

## 1. 部署与连接

- 形态：向运行中的 NTQQ 进程 ptrace 注入 native hook，解析内部包，以 OneBot v11 对外暴露。发行 full（自带 Node）/ lite（Node ≥22，推荐 24）；平台 linux-x64/arm64、win-x64。
- Docker 官方镜像：QQ + Xvfb + VNC + noVNC + supervisord，需 `SYS_PTRACE` + `seccomp=unconfined`；**noVNC 6081 扫码登录**。
- 端口：OneBot HTTP `:3000`、正向 WS `:3001`、WebUI `:5099`（初始密码仅首启日志打印一次）、noVNC 6081。
- 配置：`config/onebot.json`（全局）+ `config/onebot_<uin>.json`（账号级，端口需错开）；适配器四类：`httpServers` / `wsServers`（正向，host/port/path/role）/ `wsClients`（反向，url/role/reconnectIntervalMs 默认 5000）/ `httpClients`（POST 上报）。
- 通用字段：`name`、`enabled`、`accessToken`（自动生成）、`messageFormat: "array"(默认)|"string"`、`reportSelfMessage`（开启则 `post_type:"message_sent"`）。顶层 `musicSignUrl`。
- 鉴权：`Authorization: Bearer <token>` 或 `?access_token=`；HTTP/WS token 各自独立。
- **多账号**：一 UIN 一 OneBot 实例，事件 `self_id` 即 UIN；第二条连接必须换端口或用反向 WS。插件按 `self_id` 路由。
- 信封：`{status, retcode, data, message, wording}`；**HTTP 200 仍可能是业务失败，必须查 `retcode===0`**。`message_id` 为有符号 int32，**负值合法，不得取绝对值**。支持快速操作 `handle_quick_operation`（reply/at_sender 等）。

## 2. 动作清单（全部 200 个已确认存在）

- 消息(6)：`send_msg / send_private_msg / send_group_msg / delete_msg / get_msg / send_custom_face`
- 系统(5)：`get_login_info / get_status / get_version_info / can_send_image / can_send_record`
- 好友(3)：`get_friend_list / get_stranger_info / delete_friend`
- 群信息(7)：`get_group_info / get_group_list / get_group_member_info / get_group_member_list / get_group_honor_info / get_group_share_link / get_group_system_msg`
- 群管理(21)：`set_group_name/card/special_title/admin/ban/whole_ban/kick/kick_members/leave/add_option/member_invite_policy/member_permissions/new_member_history_visibility/portrait/search/sign` + group tag 系列（`set_group_anonymous`/`anonymous_ban` 未实现）
- 请求(2)：`set_friend_add_request / set_group_add_request`
- 群文件(12)+群相册(9)：`upload_group_file / upload_private_file / get_group_file_url / ... / get_group_album_list / upload_image_to_qun_album / ...`
- **空间(10)**：`get_qzone_msg_list / get_qzone_msg_detail / get_qzone_feeds / send_qzone_msg / delete_qzone_msg / set_qzone_msg_right / like_qzone / unlike_qzone / comment_qzone / set_qzone_ban`
- 扩展(115，节选)：`set_qq_profile(nickname?/personal_note?/sex?)`、`set_qq_avatar(file)`、`set_online_status / set_diy_online_status / set_self_longnick`、`send_like / send_poke / group_poke / friend_poke`、**`get_cookies(domain)` / `get_csrf_token / get_credentials / get_clientkey`**、`get_image / get_record(out_format→base64) / fetch_ptt_text / ocr_image`、`send_forward_msg / send_group_forward_msg / send_private_forward_msg / get_forward_msg / upload_forward_msg`、`download_file(url|base64) / get_file / upload_file_stream(4GiB 分块)`、`get_friend_msg_history / get_group_msg_history / get_recent_contact`、`set_friend_remark / set_msg_emoji_like / set_group_reaction / set_essence_msg / _send_group_notice / mark_*_as_read / set_input_status`、`send_flash_msg / fetch_custom_face*`、`get_mini_app_ark / send_ark_share` 等
- 流式(6)+系统表情(4)：`upload_file_stream / download_file_* / clean_stream_temp_file / test_download_stream`；`fetch_sys_faces / search_sys_faces / fetch_face_entity / fetch_super_face_id`
- 占位/不支持：`set_restart` 恒失败；`clean_cache` 无操作；`set_group_anonymous*`、`create_collection`、`.get_word_slices` 未实现；`unlike_qzone` 端点未经真机核实。

## 3. 事件负载（全确认）

- 消息：`message_type:"private"`（sub_type friend|group 临时；临时带 `sender.group_id`）、`"group"`（sender{user_id,nickname,card,role}）；`message` 段数组（受 messageFormat 影响）、`raw_message` CQ 码；自身回显 `message_sent`（需 reportSelfMessage，120s 去重窗）。
- 通知：`group_increase/decrease/ban/admin`、`friend_recall/group_recall`、`notify`（poke/profile_like/title/group_name/**input_status(正在输入/录音)**/essence/group_upload/friend_add/group_card/emoji_like/**bot_offline/bot_status(上下线推送)**）。
- 请求：friend / group(invite)。
- 元事件：`lifecycle(connect/enable/disable)`、`heartbeat`（**固定 30s**）。

## 4. 消息段（收发双向）

- 收：text/face/at/reply/image(file id + url，闪照 type:flash，商城表情映射为 image)/record/video/file/json/xml/markdown/poke/forward/flash_file/inline_keyboard；畸形段跳过不丢整条；`get_msg` 会逐段刷新媒体 URL。
- 发：接受 **CQ 字符串 / 段数组 / 单段对象**（顶层字段合并）；支持 text/face/at/reply/image/record/video/file/json/xml/poke/forward/mface/markdown + 糖段 `share/music(签名)/location/contact/dice/rps/shake`；`node` 段仅限整条合并转发；视频仅单视频。
- **媒体来源优先级**（`pickMediaSource`）：①`base64://`/`data:` ②`http(s)://` **服务端拉取** ③`file://`/本地路径（指 SnowLuma 服务端）④裸 token+url 并存时优先 url。大文件走 `upload_file_stream` 得服务端路径再发。

## 5. 风险

早期项目接口不稳（官方明示，固定版本 tag）；协议注入固有封号风险；许可为源码可见非商业（非商业自托管 OK）；`comment_qzone` 高频触发风控需限流；**消息发送无内置限速——插件自建**；ptrace 环境（`SYS_PTRACE`/`seccomp=unconfined`，ptrace_scope=3 直接失败）；容器重建可能要重新扫码；OneBot/WebUI/noVNC 端口勿暴露公网。

## 6. 能力契约总表（适配器实现核对用）

| 能力 | 动作/段 | 状态 |
|---|---|---|
| 正向/反向 WS + HTTP API | wsServers / wsClients / httpServers，Bearer 鉴权 | ✅ |
| 多账号 | self_id 路由，一连接一账号 | ✅ |
| 私聊/群聊文本 | send_private_msg / send_group_msg | ✅ |
| 表情/AT/引用回复 | face / at(qq=all) / reply(id 有符号 int32) | ✅ |
| 图片/语音/视频/文件 | image / record / video / file 段（URL/base64/服务端路径）+ upload_*_file / upload_file_stream | ✅ |
| JSON/XML/音乐/名片/位置卡片 | json / xml / share / music / contact / location 段 | ✅ |
| 合并转发 | send_forward_msg 系 + get_forward_msg | ✅ |
| 戳一戳/点赞/表情回应 | send_poke / send_like / set_msg_emoji_like / set_group_reaction + notify 事件 | ✅ |
| 改资料/头像/状态 | set_qq_profile / set_qq_avatar / set_online_status / set_self_longnick | ✅ |
| Cookies/凭证 | get_cookies / get_csrf_token / get_credentials / get_clientkey | ✅ |
| **QQ 空间** | **send_qzone_msg(content, images, ugc_right)** / like / comment / delete / get_qzone_* —— **原生支持，替代旧项目逆向 JSONP 链路** | ✅ |
| 好友/群管理/群文件/群相册 | 全套 | ✅（返回结构⚠️） |
| 撤回/历史/转文字 | delete_msg / get_msg / get_*_msg_history / fetch_ptt_text / ocr_image | ✅ |
| 事件订阅 | message/message_sent/notice(含 bot_status)/request/meta(heartbeat 30s) | ✅ |
| 能力探测 | get_version_info(`app_name:"SnowLuma"`) + SDK `SNOWLUMA_ACTIONS`/`isSnowLumaAction` + MCP `list_actions/get_action` | ✅ |
| 重启/匿名 | set_restart / set_group_anonymous* | ❌ |

**运行时探测未确认项**：各 get_* 扩展动作完整返回字段、send_packet 可用性、QZone 拉取返回结构、群相册返回结构。探测手段：`get_version_info` + 单动作 retcode 试调 + SDK 动作清单。

## 7. 对 Littly 适配器的设计影响

1. **QZone 工具直接映射 `send_qzone_msg`**（原生带图上传 `file:// http:// base64://`），旧 `postQzone` JSONP 链路废弃；`get_cookies` 保留作通用凭证工具。
2. 心跳「正在输入」可反向利用：`input_status` 事件让 AI 知道对方在打字。
3. `bot_status/bot_offline` 事件接入自愈/告警，替代旧「60s 幂等自愈」的一半职责。
4. 多账号：Bot 增加 `snowlumaAccount`(self_id/uin) 字段；连接配置支持正向 WS（默认）与反向 WS（多账号端口受限时的推荐姿势）。
5. 发送限速器在插件内实现（片间延迟沿用拟人化分片逻辑 + 全局最小间隔）。
6. `message_id` 用有符号 int32 传递（JS number 安全），**不要 Math.abs**。
