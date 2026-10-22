# dsh-away-notify · 自主资讯推送与状态提醒

> **声明**：本插件完全由 DeepSeek-V4.1-Flash (1017) 编写。

DSH 原生插件：集「自主资讯检索与多通道推送」与「会话状态全局系统原生弹窗」于一体。全程主进程轻量运行，零外部常驻服务。

设置入口：「设置」→「自主资讯推送」。

---

## 核心功能

### 1. 采集资讯并主动推送
根据设定的偏好自主捕捉全网热点与专业资讯，以原生助手消息形式直接注入目标会话，或同步转发至移动端聊天软件。

- **按喜好采集资讯，支持自定义源**：支持配置自定义兴趣词与查询模板，定向跟踪特定领域动态；支持直接填入任意网址（支持 JSON、RSS、Atom 及网页 HTML），自动识别并聚合自定义源。
- **多种资讯采集方法与平滑降级**：支持内置免 Token 抓取、`web_search` 深度搜索、`dsh-ego-browser` 浏览器直连及脚本模式；多源采集失败时按序平滑降级，兼顾 0 Token 经济性与深度搜索质量。
- **持续推送与闲置推送自由切换**：支持全天或指定多时段（支持跨午夜）定时持续轮询，也支持通过底层低开销探测检测用户离席（离开电脑）后触发单次静默推送。
- **支持 IM 插件，消息同步给机器人**：无缝对接 `@xmanrui/dsh-im` 生态，支持将资讯推送到 Telegram、微信、飞书、钉钉等移动端机器人对话。
- **支持 NapCat 插件，消息同步给 NapCatQQ**：原生适配 `dsh-onebot-qq`，自动识别 QQ 私聊与群聊会话，支持跟随会话转发或固定推送到指定 QQ 聊天。
- **支持人设配置与插件，语气自适应**：自动读取并继承当前会话的角色人设与语气风格，让推送如同真人助理般自然，亦可随时切换为客观纯文本摘要。

### 2. 会话状态系统弹窗
全局深度监听 DSH 会话事件流，让用户在切到后台办公、浏览网页或离开屏幕时，不再错过任何会话进展。

- **全场景关键节点提醒**：当 AI 回答生成完毕、需要用户操作（工具审批、提问卡片确认）或执行出错时，自动触发系统级桌面通知。
- **官方归属与原生图标**：对齐 DeepSeek Harness 官方应用标识（AUMID `com.deepseek.dsh`），桌面通知规范展示 DSH 官方图标与名称，拒绝第三方控制台伪装。
- **跨平台原生支持**：零新增原生 npm 依赖，Windows 走原生 WinRT Toast / 气泡通知，macOS 走 `osascript`，Linux 走 `notify-send`。
- **会话标题智能识别**：自动解析并显示真实会话标题，拒绝展示冷冰冰的内部会话 UUID。

---

## 安装步骤

### 方式一：插件市场安装（推荐）
在 DSH 桌面端进入「设置」→「插件市场」，搜索 `dsh-away-notify` 点击安装即可。

### 方式二：手动 / 本地源码安装
1. 将本插件代码克隆或解压至用户 DSH 目录，例如：
   ```bash
   git clone https://github.com/Echo-Cry/dsh-away-notify.git ~/.dsh/away-notify
   ```
   *(Windows 用户对应路径通常为 `%USERPROFILE%\.dsh\away-notify`)*

2. 在配置文件 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中添加本地引用：
   ```json
   "dependencies": {
     "dsh-away-notify": "link:../../away-notify"
   }
   ```
   *(或使用绝对路径 `"link:C:/Users/<你的用户名>/.dsh/away-notify"`)*

3. 在同文件的 `dsh.profile.bundles` 数组中追加插件名称：
   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "dsh-away-notify"
       ]
     }
   }
   ```

4. 重启 DeepSeek Harness 桌面端客户端。
5. 在「设置」→「自主资讯推送」中配置所需的工作区、会话及推送偏好，点击「马上试一次」即可验证。

---

## 许可证
[MIT License](./LICENSE)
