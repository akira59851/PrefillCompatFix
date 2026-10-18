# 预填充兼容修复（PrefillCompatFix）

修复 SillyTavern 中因模型不支持预填充导致的 `error 400: Requests ending with a model turn are not supported.`，让请求能够正常发送。

支持 ST 原生请求与第三方插件的请求（插件不保证 100% 覆盖）。

## 工作原理

在请求发送前自动检查请求内容。如果**使用的模型在名单内**，且**最后一条消息不为 `user`**，就在请求末尾静默追加一条只包含一个空格的用户消息。

只处理模型在名单内且符合条件的请求，其余请求不进行修改。

修复未成功时按原请求继续发送，插件不会阻断请求。如果遇到使用后仍返回报错的少数情况，请手动排查末尾角色。

## 安装与使用

使用下方链接安装并刷新 ST 页面：

`https://github.com/akira59851/PrefillCompatFix`

### 自定义生效模型名单

打开 ST 的 **API 连接面板**（插头），在最底部找到「预填充兼容修复」（「查看隐藏的 API 密钥」右侧，移动端可能在下一行），点击打开设置面板。

- 可自行添加或删除型号。保存后即时生效，无需刷新页面。
- 每行填写一个模型名，名称注意与实际型号一致。
- 插件更新内置模型名单时，列表会同步更新；用户手动删除的型号不会自动恢复。

### 调试模式

将 `index.js` 顶部的 `DEBUG_LOGS` 设置为 `true`，即可开启调试模式。控制台会输出更详细的调试信息。

## 内置模型名单

### Google Gemini

- `gemini-3.5-flash-lite`
- `gemini-3.6-flash`
- `gemini-3.7-flash`
- `gemini-3.8-flash`
- `gemini-4-argon`

### Anthropic Claude

- `claude-opus-4-6`
- `claude-opus-4-7`
- `claude-opus-4-8`
- `claude-opus-5`
- `claude-opus-5-5`
- `claude-sonnet-4-6`
- `claude-sonnet-5`
- `claude-sonnet-5-5`
- `claude-haiku-5-5`
- `claude-fable-5`
- `claude-fable-5-1`

## 更新日志

### [v1.2.0] - 2026-10-18

- 新增模型清单设置入口，可直接在 ST 中自定义生效模型。

### [v1.1.0] - 2026-10-14

- 内置模型名单新增 `gemini-4-argon`。

### [v1.0.0] - 2026-10-11

- 首次发布。
- 支持在符合条件的请求末尾自动追加空格用户消息，修复部分模型的请求结尾兼容问题。
- 支持主页面及同源 iframe 中的请求，包括通过 `fetch`、XHR 及 jQuery `$.ajax` 等方式发出的请求。
- 内置 Gemini 与 Claude 系列模型名单。
