# 中国移动 App「签到有礼」Surge 自动签到模块

每天自动完成中国移动 App「签到有礼」签到，并自动领取累计/连签奖励（心愿金、话费、流量）。

## 安装（Surge）

在 Surge 里「模块 → 安装模块」，粘贴：

```
https://cdn.jsdelivr.net/gh/JiuYueQingCheng/cmcc-surge-checkin@main/cmcc.sgmodule
```

安装后模块包含三个脚本：

| 脚本 | 类型 | 说明 |
|---|---|---|
| 中国移动签到 | 定时任务 | 每天设定时间签到并领奖（默认 09:00） |
| 中国移动保活 | 定时任务 | 每小时保活一次，重置凭证的 2 小时过期计时 |
| 中国移动凭证抓取 | http-request | 打开 App 签到页时自动抓取凭证 |

## 获取凭证（只需一次）

凭证是中国移动 App 的登录会话票据（`appTokenLogin` 请求体），**不能用账号密码登录**，必须抓包获取。

### 方式一：自动抓取（推荐）

1. 安装模块后，确保模块参数里 `capture` 是开着的（默认开）。
2. 打开中国移动 App → 我的 → 右上角「签到有礼」，等页面加载完。
3. 收到通知「✅ 中国移动凭证已更新」即完成。之后每天自动签到。

### 方式二：手动抓包（自动抓取失败时）

App 若做证书 pinning，Surge 的 MITM 抓不到请求体。此时：

1. 手机装抓包工具（iOS 用 Stream，电脑用 Proxyman / Charles），对 App 开启 HTTPS 抓包。
2. 打开中国移动 App → 我的 → 「签到有礼」，进入签到页。
3. 在抓包记录中找到 `wx.10086.cn/qwhdsso/appTokenLogin` 这条 POST 请求。
4. 复制请求体里的完整 JSON，粘贴到 BoxJS（键 `cmcc_account`）。

请求体示例（仅作格式参考，不要用这份）：

```json
{
  "provinceCode": "200",
  "cityCode": "0759",
  "appVersionCode": "12.5.7",
  "userCheckId": "44385a489",
  "carrierOperator": "002",
  "jwtToken": null,
  "token": "JSESSIONID=...; UID=...; ticketID=SuZhou; Secure",
  "took": 251
}
```

其中 `token` 是 App 票据，`userCheckId` 是手机号的十六进制。`jwtToken` / `took` 不用管（脚本自己处理）。

## 凭证有效期（重要）

- `app_token` 本质是 App 的 `JSESSIONID` 会话票据，**服务端强制约 2 小时过期**。
- 模块每小时自动调用 `appTokenLogin` 保活一次，可重置计时；实测每小时保活可长期维持。
- 首次用 `app_token` 引导后，脚本会自动缓存并续期一个账号级长期 `jwt`，减少对 `app_token` 的依赖。
- **App 退出登录或被踢下线后，凭证彻底失效**，保活也会失败。此时须重新抓包更新凭证（方式一或方式二任选）。

## 模块参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `checkin_hour` | 9 | 每天签到小时（0-23） |
| `checkin_minute` | 0 | 每天签到分钟（0-59） |
| `keepalive` | true | 每小时保活开关。关闭后 app_token 会在 2 小时后过期，次日签到将失败 |
| `capture` | true | 自动抓包开关 |
| `policy` | DIRECT | 请求出站策略。iPhone 上脚本请求默认直连；直连到 wx.10086.cn 超时/挂起时，把它改成你的代理策略组名（如 VPS 节点组），请求改走代理 |

凭证不放在模块参数里（Surge 不接受空默认值的参数声明）：自动抓取成功时不用填；手动抓包后粘贴到 BoxJS（键 `cmcc_account`）。

## 多账号

BoxJS 里填 `cmcc_accounts`，值为 JSON 数组（每个元素是一份 appTokenLogin 请求体 JSON）。多个账号依次签到，通知里按手机尾号区分。

## 接口说明

对接中国移动 App「签到有礼」接口（`wx.10086.cn` / `qwhdhub` mark31 活动），接口链路参考开源实现 [jian1098/cmcc_auto_checkin](https://github.com/jian1098/cmcc_auto_checkin)：

1. `GET /qwhdsso/login?actUrl=<活动页>` — 取得内嵌一次性 sid 的登录中转页
2. `POST /qwhdsso/appTokenLogin?sid=...` — 用 App 票据（或缓存 jwt）换活动页跳转 URL
3. `GET <活动页?token=...>` — 服务端下发 `QWHD_SESSION_TOKEN` 会话
4. `POST /qwhdhub/api/mark/mark31/markstatus` — 查询签到状态（幂等保护）
5. `POST /qwhdhub/api/mark/mark31/domark` — 执行签到 `{"date":"YYYYMMDD"}`
6. `POST /qwhdhub/api/mark/mark31/taskAward/<id>` — 领取累计/连签奖励

签到与领奖均幂等：今日已签只会提示「今日已签到」，重复运行不会重复领奖。

## 常见问题

- **通知「未配置凭证」**：还没抓到凭证。按「获取凭证」走一遍；自动抓取没反应时检查 MITM 是否开启、Surge 证书是否信任，或改用手动抓包。
- **通知「APP登录状态已过期」**：凭证已失效（App 退出登录/被踢下线）。重新抓包更新凭证。
- **通知「登录页未返回 sid」**：中国移动改了 SSO 入口，脚本需更新。
- **签到成功但没奖品**：当日无单日奖品属正常（`PRIZE_NO_CONFIG`）；累计/连签奖励在门槛达标时由脚本自动领。

## 免责声明

本项目仅供个人学习研究与自用自动化，请勿用于商业用途或违反平台服务条款的行为。脚本只与 `wx.10086.cn` 通信，凭证只保存在你自己的设备上，不上传、不收集任何数据。
