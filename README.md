# 塔吉多自动签到

基于 TypeScript 和 GitHub Actions 的塔吉多自动签到项目。项目支持手动短信登录、自动保存账号 Secret、定时签到、失败重试、刷新 `refreshToken` 并写回 Secret。

默认会尝试签到全部已知游戏：`1256（幻塔）`、`1257（未知）`、`1289（异环）`。某个游戏没有绑定角色时会自动跳过。

## 功能

- 支持多账号
- 支持塔吉多 APP 签到
- 支持全部已知游戏签到
- 支持手动短信登录生成账号配置
- 支持定时执行和手动执行
- 支持将刷新后的 `refreshToken` 写回 GitHub Secret
- 支持通知推送

## 新用户从零开始

推荐按下面顺序配置。第一步先创建 PAT，因为登录工作流和签到工作流都需要用它更新 `TAYGEDO_ACCOUNTS`。

### 1. Fork 仓库

把本仓库 Fork 到自己的 GitHub 账号下。

### 2. 创建 GitHub PAT

`GH_SECRET_UPDATE_TOKEN` 用来让工作流执行下面的写回操作：

```bash
gh secret set TAYGEDO_ACCOUNTS < updated-accounts.json
```

创建方式：

1. 打开 GitHub `Settings` -> `Developer settings` -> `Personal access tokens`
2. 创建一个 fine-grained token
3. Repository access 选择你 Fork 后的这个仓库
4. Repository permissions 里给 `Secrets` / `Actions secrets` 写权限
5. 生成 token，并复制保存

### 3. 添加第一个 Secret

进入 Fork 后仓库的 `Settings` -> `Secrets and variables` -> `Actions`，添加：

```text
GH_SECRET_UPDATE_TOKEN=你的 GitHub PAT
```

这一步先做。`TAYGEDO_ACCOUNTS` 可以之后由登录工作流自动生成。

### 4. 启用 GitHub Actions

进入仓库 `Actions` 页面，按 GitHub 提示启用 Actions。

启用后你会看到两个工作流：

- `塔吉多登录`
- `塔吉多签到`

### 5. 发送验证码

进入 `Actions` -> `塔吉多登录` -> `Run workflow`。

填写：

```text
mode=send-code
phone=你的手机号
```

其他输入先留空。

工作流会自动生成 `deviceId`，并写入 `TAYGEDO_LOGIN_DEVICE_ID` Secret。第二步登录会直接读取这个 Secret，不需要手动复制。

### 6. 用验证码登录

收到短信验证码后，再运行一次 `塔吉多登录`。

填写：

```text
mode=login
phone=你的手机号
captcha=短信验证码
account_id=main
account_name=主账号
```

`account_id` 和 `account_name` 是你自己起的本地标识，不是塔吉多返回的字段：

- `account_id`：账号唯一标识，例如 `main`、`alt`
- `account_name`：日志和通知里显示的名字，例如 `主账号`、`小号`

登录成功后，工作流会自动创建或更新 `TAYGEDO_ACCOUNTS` Secret。

### 7. 运行签到

进入 `Actions` -> `塔吉多签到`。

你可以：

- 等每天定时执行
- 点 `Run workflow` 手动运行一次

运行日志会按账号显示结果，例如：

```text
塔吉多每日签到结果
总账号：1，成功：1，失败：0

主账号（main）：成功
- APP 签到：获得 20 金币，10 经验
- 游戏 1256 / 角色名：签到成功，本月第 1 天，奖励 奖励名 x1
```

如果至少一个账号刷新成功，工作流会把新的 `refreshToken` 写回 `TAYGEDO_ACCOUNTS`。

## 多账号

重复执行“发送验证码”和“用验证码登录”即可添加多个账号。

第二个账号可以这样填：

```text
account_id=alt
account_name=小号
```

如果 `account_id` 已存在，登录工作流会覆盖同一个账号；如果不存在，会追加新账号。

## Secrets 说明

| Secret 名称 | 说明 | 是否必填 |
|------------|------|---------|
| `GH_SECRET_UPDATE_TOKEN` | 用于写回 `TAYGEDO_ACCOUNTS` 的 GitHub PAT | 必填 |
| `TAYGEDO_ACCOUNTS` | 塔吉多账号 JSON，推荐用登录工作流自动生成 | 登录后自动生成 |
| `TAYGEDO_LOGIN_DEVICE_ID` | 登录验证码使用的 deviceId，由登录工作流自动写入 | 自动生成 |
| `TAYGEDO_NOTIFICATION_URLS` | 通知 URL，多个 URL 用英文逗号分隔 | 可选 |
| `TAYGEDO_SERVERCHAN_SENDKEY` | Server 酱 SendKey，配置后会推送签到结果 | 可选 |
| `TAYGEDO_MAX_RETRIES` | 单账号最大重试次数，默认 `3` | 可选 |

## TAYGEDO_ACCOUNTS 格式

正常情况下不需要手动写这个 Secret，使用 `塔吉多登录` 工作流即可自动生成。

如果你已经通过其他工具拿到了 `uid`、`deviceId`、`refreshToken`，也可以手动创建。推荐通过登录工作流生成完整字段，因为它会额外保存 `accessToken` 和老虎登录凭证，用于减少刷新登录态的次数：

```json
[
  {
    "id": "main",
    "name": "主账号",
    "uid": "123456",
    "deviceId": "abcdef1234567890",
    "accessToken": "your-access-token",
    "refreshToken": "your-refresh-token",
    "laohuToken": "your-laohu-token",
    "laohuUserId": "your-laohu-user-id",
    "tokenUpdatedAt": "2026-05-07T00:00:00.000Z",
    "roleId": "optional-role-id",
    "roleName": "optional-role-name"
  }
]
```

字段说明：

- `id`：账号唯一标识，自定义
- `name`：账号显示名，自定义
- `uid`：塔吉多用户 ID
- `deviceId`：登录设备 ID
- `accessToken`：可选，签到优先使用的访问凭证
- `refreshToken`：刷新凭证
- `laohuToken`：可选，老虎登录凭证，用于 `refreshToken` 被拒绝后重建塔吉多会话
- `laohuUserId`：可选，老虎账号 ID，和 `laohuToken` 配套使用
- `tokenUpdatedAt`：可选，凭证最近更新时间
- `roleId`：可选，兼容旧配置
- `roleName`：可选，兼容旧配置

`TAYGEDO_ACCOUNTS` 必须是合法 JSON 数组，不能写成 JavaScript 对象，末尾不要多逗号。

## 工作流说明

### 塔吉多登录

文件：`.github/workflows/login.yml`

手动触发，用于获取账号配置。

输入说明：

| 输入名 | 说明 |
|------|------|
| `mode` | `send-code` 或 `login` |
| `phone` | 手机号 |
| `captcha` | 短信验证码，仅 `login` 需要 |
| `account_id` | 账号唯一标识，仅 `login` 需要 |
| `account_name` | 账号显示名，仅 `login` 需要 |

### 塔吉多签到

文件：`.github/workflows/attendance.yml`

支持手动触发，也会每天定时执行。

签到流程：

1. 读取 `TAYGEDO_ACCOUNTS`
2. 如果账号已有 `accessToken`，优先直接签到，不主动刷新登录态
3. 只有 `accessToken` 明确失效时，才用 `refreshToken` 换取新的凭证
4. 如果 `refreshToken` 返回 402 且账号保存了 `laohuToken`/`laohuUserId`，尝试重建塔吉多会话
5. 执行塔吉多 APP 签到
6. 遍历全部已知游戏并获取绑定角色
7. 对已绑定角色的游戏执行签到
8. 只有凭证刷新或重建成功时，才将更新后的账号 JSON 写回 `TAYGEDO_ACCOUNTS`

## 通知

可选配置：

```text
TAYGEDO_NOTIFICATION_URLS=https://example.com/webhook
TAYGEDO_SERVERCHAN_SENDKEY=SCTxxxxxxxxxxxxxxxxxxxxxxxx
```

`TAYGEDO_SERVERCHAN_SENDKEY` 填 Server 酱的 SendKey 即可，不需要填写完整 URL。程序会自动请求 `https://sctapi.ftqq.com/<SENDKEY>.send`，并按 Server 酱要求发送 `title` 和 `desp` 表单字段。

`TAYGEDO_NOTIFICATION_URLS` 用于普通 webhook，多个地址用英文逗号分隔。两个配置可以同时使用，签到完成后会分别推送。

## 本地运行

安装依赖：

```bash
pnpm install
```

本地执行签到：

```bash
TAYGEDO_ACCOUNTS='[{"id":"main","name":"主账号","uid":"123456","deviceId":"device","refreshToken":"token"}]' pnpm action
```

运行后会生成 `updated-accounts.json`。

## 常见问题

### account_id 和 account_name 去哪里获取？

不用获取，是你自己填的。

例如：

```text
account_id=main
account_name=主账号
```

多账号时保证 `account_id` 不重复即可。

### 为什么要先创建 GH_SECRET_UPDATE_TOKEN？

登录成功后需要把账号写入 `TAYGEDO_ACCOUNTS`。签到时如果复用已有 `accessToken` 成功，就不会写回 Secret；只有刷新或重建凭证成功时才会写回。这两个写回动作都依赖 `GH_SECRET_UPDATE_TOKEN`。

### deviceId 是什么？

`deviceId` 是本次登录使用的设备标识。发送验证码和提交验证码必须使用同一个 `deviceId`。登录工作流会在发送验证码后自动保存到 `TAYGEDO_LOGIN_DEVICE_ID` Secret，提交验证码时自动读取。

### refreshToken 失效怎么办？

重新运行 `塔吉多登录`，用短信验证码登录一次。使用相同的 `account_id` 会覆盖旧账号配置。

如果日志里出现 `REFRESH_REJECTED_402`，说明服务端已经拒绝当前 `refreshToken`。这类失败不会覆盖 `TAYGEDO_ACCOUNTS`，需要重新运行登录工作流生成新的完整账号配置。

### 所有游戏都会签到吗？

会默认尝试全部已知游戏：`1256`、`1257`、`1289`。如果某个游戏没有绑定角色，会跳过。

## 开源协议

本项目采用 MIT License，见 [LICENSE](LICENSE)。
