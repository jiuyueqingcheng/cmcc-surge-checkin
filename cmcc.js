// 中国移动 App「签到有礼」自动签到（Surge / Loon / Quantumult X / BoxJS）
// 目标站：中国移动 App 内嵌活动页 wx.10086.cn（qwhdhub mark31 活动）。
// 接口链路（实测参考：jian1098/cmcc_auto_checkin，2026-11）：
//   1. GET  /qwhdsso/login?dlwmh=true&actUrl=<活动页>   取得内嵌一次性 sid 的登录中转页
//   2. POST /qwhdsso/appTokenLogin?sid=...             用 App 票据（或缓存 jwt）换活动页跳转 URL
//   3. GET  <活动页?token=...>                         服务端 Set-Cookie: QWHD_SESSION_TOKEN
//   4. POST /qwhdhub/api/mark/mark31/markstatus        查询签到状态（幂等保护）
//   5. POST /qwhdhub/api/mark/mark31/domark            执行签到 {"date":"YYYYMMDD"}
//   6. POST /qwhdhub/api/mark/mark31/taskAward/<id>    领取累计/连签奖励
// 凭证：抓包 appTokenLogin 请求体原文（token / userCheckId / provinceCode / cityCode ...）。
//   一次抓包后由脚本自动缓存 jwt 并续期；app_token 服务端约 2 小时过期，模块内置每小时保活
//   （appTokenLogin 可重置计时）。App 退出登录/被踢下线后须重新抓包更新凭证。
// Surge 部署方式：
//   cmcc.js（本文件）            定时任务：每天签到 + 每小时保活
//   cmcc-capture.js              http-request：打开 App 签到页时自动抓取 appTokenLogin 请求体
//   cmcc.sgmodule                模块（含两种定时任务 + 抓包脚本 + MITM）
// 注意：App 可能做证书 pinning，抓包脚本抓不到时请用 Stream/Proxyman 手动抓包，
//   把 appTokenLogin 请求体 JSON 粘贴到 BoxJS（键 cmcc_account）。
// 出站策略：iPhone 上 $httpClient 默认直连，wx.10086.cn 直连挂起时，
//   把模块参数 policy 设为你的代理策略组名，请求改走代理（已验证 VPS 能直通该站）。
// 单个请求超时 30s（$httpClient 默认 5s 太短），避免挂起拖到脚本超时。

const SCRIPT_VERSION = "2026-11-26.r2";
const ENV_NAME = "中国移动";
const STATUS_KEY = "cmcc_status";
const REGISTRY_KEY = "checkin_registry";
const BASE = "https://wx.10086.cn";
const SSO_LOGIN = BASE + "/qwhdsso/login";
const API_MARK = BASE + "/qwhdhub/api/mark";
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview " +
  "leadeon/12.5.2/CMCCIT";
const DEFAULT_ACTIVITY_ID = "1021122301";
const DEFAULT_CHANNEL_ID = "P00000109876";
// 单个 HTTP 请求超时（秒）。$httpClient 默认 5s，wx.10086.cn 直连经常超过 5s
// 或直接挂起，设 30s 让它有足够时间完成，挂起时也能快速失败而不是拖到脚本超时。
var HTTP_TIMEOUT = 30;
// $httpClient 出站策略：空 = 默认（iPhone 上为直连）。直连到 wx.10086.cn 挂起时，
// 把模块参数 policy 设为你的代理策略组名（如 VPS 节点组），请求改走代理。
var HTTP_POLICY = "";

// ------------------------------------------------------------ Env 兼容层
function Env(name) {
  this.name = name;
  this.isSurge = typeof $httpClient !== "undefined" && typeof $persistentStore !== "undefined";
  this.isLoon = typeof $httpClient !== "undefined" && typeof $persistentStore !== "undefined" && typeof $notification !== "undefined" && typeof $loon !== "undefined";
  this.isQX = typeof $task !== "undefined";
  this.isNode = typeof module !== "undefined" && !!module.exports;
  this.data = {};
  this.logs = [];
}
Env.prototype.log = function () {
  var msg = Array.prototype.map.call(arguments, function (v) {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  }).join(" ");
  this.logs.push(msg);
  if (typeof console !== "undefined") console.log("[" + this.name + "] " + msg);
};
Env.prototype.getdata = function (key) {
  if (this.isSurge || this.isLoon) return $persistentStore.read(key);
  if (this.isQX) return $prefs.valueForKey(key);
  if (this.isNode) return this.data[key];
  return null;
};
Env.prototype.setdata = function (value, key) {
  if (this.isSurge || this.isLoon) return $persistentStore.write(value, key);
  if (this.isQX) return $prefs.setValueForKey(value, key);
  if (this.isNode) { this.data[key] = value; return true; }
  return false;
};
Env.prototype.msg = function (title, subtitle, body) {
  if (this.isSurge || this.isLoon) { try { $notification.post(title, subtitle || "", body || ""); } catch (e) {} }
  else if (this.isQX) { try { $notify(title, subtitle || "", body || ""); } catch (e) {} }
  else this.log(title, subtitle, body);
};
Env.prototype.get = function (url, opts) {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (self.isSurge || self.isLoon) {
      var o = Object.assign({ timeout: HTTP_TIMEOUT }, opts || {});
      if (HTTP_POLICY) o.policy = HTTP_POLICY;
      $httpClient.get(url, o, function (error, response, data) {
        if (error) reject(error);
        else resolve({ status: response.status, headers: response.headers || {}, body: data });
      });
    } else if (self.isQX) {
      $task.fetch(Object.assign({ url: url, method: "GET" }, opts || {})).then(function (resp) {
        resolve({ status: resp.statusCode, headers: resp.headers || {}, body: resp.body });
      }).catch(reject);
    } else if (self.isNode) {
      var u = require("url").parse(url);
      var lib = u.protocol === "https:" ? require("https") : require("http");
      var req = lib.request({ hostname: u.hostname, path: u.path, method: "GET", headers: (opts && opts.headers) || {} }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers || {}, body: Buffer.concat(chunks).toString() }); });
      });
      req.on("error", reject);
      req.end();
    } else reject(new Error("unsupported runtime"));
  });
};
Env.prototype.post = function (url, body, opts) {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (self.isSurge || self.isLoon) {
      var o = Object.assign({ headers: { "Content-Type": "application/json;charset=UTF-8" }, body: body, timeout: HTTP_TIMEOUT }, opts || {});
      if (HTTP_POLICY) o.policy = HTTP_POLICY;
      $httpClient.post(url, o, function (error, response, data) {
        if (error) reject(error);
        else resolve({ status: response.status, headers: response.headers || {}, body: data });
      });
    } else if (self.isQX) {
      $task.fetch(Object.assign({ url: url, method: "POST", body: body, headers: { "Content-Type": "application/json;charset=UTF-8" } }, opts || {})).then(function (resp) {
        resolve({ status: resp.statusCode, headers: resp.headers || {}, body: resp.body });
      }).catch(reject);
    } else if (self.isNode) {
      var u = require("url").parse(url);
      var lib = u.protocol === "https:" ? require("https") : require("http");
      var req = lib.request({ hostname: u.hostname, path: u.path, method: "POST", headers: Object.assign({ "Content-Type": "application/json;charset=UTF-8", "Content-Length": Buffer.byteLength(body) }, (opts && opts.headers) || {}) }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers || {}, body: Buffer.concat(chunks).toString() }); });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    } else reject(new Error("unsupported runtime"));
  });
};
Env.prototype.done = function () {
  if (typeof $done !== "undefined") $done();
};
var $ = new Env(ENV_NAME);

// ------------------------------------------------------------ 参数与账号
function parseArgument() {
  var raw = "";
  try {
    if (typeof $argument !== "undefined") {
      if (typeof $argument === "string") raw = $argument;
      else if ($argument && typeof $argument === "object") return $argument;
    }
  } catch (e) {}
  var obj = {};
  if (raw) {
    raw = raw.trim();
    if (raw.charAt(0) === "{") {
      try { obj = JSON.parse(raw); } catch (e) {}
    } else {
      raw.split("&").forEach(function (pair) {
        var i = pair.indexOf("=");
        if (i > 0) obj[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      });
    }
  }
  return obj;
}

function normalizeAccount(raw) {
  var n = {};
  if (!raw || typeof raw !== "object") return n;
  // 抓包 appTokenLogin 请求体原文（驼峰）-> 内部字段
  n.app_token = raw.app_token || raw.token || "";
  n.phone = raw.phone || "";
  if (!n.phone && raw.userCheckId) {
    try { n.phone = String(parseInt(String(raw.userCheckId), 16)); } catch (e) {}
  }
  n.province_code = raw.province_code || raw.provinceCode || "731";
  n.city_code = raw.city_code || raw.cityCode || "0731";
  n.carrier_operator = raw.carrier_operator || raw.carrierOperator || "002";
  n.app_version_code = raw.app_version_code || raw.appVersionCode || "12.5.2";
  n.activity_id = raw.activity_id || raw.activityId || DEFAULT_ACTIVITY_ID;
  n.channel_id = raw.channel_id || raw.channelId || DEFAULT_CHANNEL_ID;
  n.name = raw.name || "";
  return n;
}

function readAccounts(arg) {
  var list = [];
  function pushRaw(raw) {
    if (!raw) return;
    if (Array.isArray(raw)) { raw.forEach(pushRaw); return; }
    if (typeof raw === "object" && Array.isArray(raw.accounts)) { raw.accounts.forEach(pushRaw); return; }
    if (typeof raw === "object") list.push(normalizeAccount(raw));
  }
  // 1) 模块参数 / 脚本参数 account（JSON 字符串或对象）
  var argAccount = arg.account || arg.cmcc_account || arg.cmcc || "";
  if (argAccount) {
    if (typeof argAccount === "string") {
      try { pushRaw(JSON.parse(argAccount)); } catch (e) { /* 不是 JSON 则忽略 */ }
    } else pushRaw(argAccount);
  }
  // 2) BoxJS / 抓包脚本写入的 $persistentStore
  var storeKeys = ["cmcc_account", "cmcc_accounts"];
  storeKeys.forEach(function (k) {
    var v = $.getdata(k);
    if (v) {
      try { pushRaw(JSON.parse(v)); } catch (e) { /* 忽略损坏的存储 */ }
    }
  });
  // 3) BoxJS 兼容键
  ["cmcc", "cmcc_json"].forEach(function (k) {
    var v = $.getdata(k);
    if (v) { try { pushRaw(JSON.parse(v)); } catch (e) {} }
  });
  return list;
}

function phoneTag(phone) {
  return phone ? ("手机尾号 " + String(phone).slice(-4)) : "未知账号";
}

// jwt 缓存：按手机尾号隔离，30 天内可用
function jwtCacheKey(phone) {
  return "cmcc_jwt_" + String(phone).slice(-4);
}
function loadJwtCache(phone) {
  try {
    var raw = $.getdata(jwtCacheKey(phone));
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (d.phone !== phone) return null;
    if (Date.now() - (d.saved_at || 0) < 30 * 86400 * 1000 && d.jwt) {
      return { jwt: d.jwt, first_seen: d.first_seen || d.saved_at || Date.now() };
    }
  } catch (e) {}
  return null;
}
function saveJwtCache(phone, jwt) {
  if (!jwt) return;
  try {
    var first_seen = Date.now();
    try {
      var old = JSON.parse($.getdata(jwtCacheKey(phone)) || "{}");
      if (old.phone === phone && old.first_seen) first_seen = old.first_seen;
    } catch (e) {}
    $.setdata(JSON.stringify({ jwt: jwt, phone: phone, first_seen: first_seen, saved_at: Date.now() }), jwtCacheKey(phone));
  } catch (e) {}
}

// ------------------------------------------------------------ 工具
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
function todayStr() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return "" + y + m + day;
}
function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}
function getSetCookie(headers) {
  if (!headers) return [];
  var v = headers["set-cookie"] || headers["Set-Cookie"] || headers["SET-COOKIE"] || "";
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}
function extractSessionToken(headers) {
  // 活动页 Set-Cookie 里找以 SESSION_TOKEN 结尾的令牌（qwhdhub -> QWHD_SESSION_TOKEN）
  var cookies = getSetCookie(headers);
  for (var i = 0; i < cookies.length; i++) {
    var parts = String(cookies[i]).split(";");
    for (var j = 0; j < parts.length; j++) {
      var kv = parts[j].trim();
      var eq = kv.indexOf("=");
      if (eq > 0) {
        var name = kv.slice(0, eq).trim();
        var val = kv.slice(eq + 1).trim();
        if (/SESSION_TOKEN$/i.test(name) && val) return { name: name, value: val };
      }
    }
  }
  // 某些运行时把多个 Set-Cookie 合并成一个以逗号分隔的字符串
  var joined = cookies.join(", ");
  var m = joined.match(/([A-Za-z0-9_]*SESSION_TOKEN)=([^;,\s]+)/i);
  if (m) return { name: m[1], value: m[2] };
  return null;
}
function apiHeaders(referer, sessionCookie) {
  var h = {
    "accept": "*/*",
    "content-type": "application/json;charset=UTF-8",
    "origin": BASE,
    "referer": referer,
    "login-check": "1",
    "x-requested-with": "XMLHttpRequest",
    "user-agent": USER_AGENT,
    "accept-language": "zh-CN,zh-Hans;q=0.9"
  };
  if (sessionCookie) h["cookie"] = sessionCookie.name + "=" + sessionCookie.value;
  return h;
}

// ------------------------------------------------------------ SSO 换会话
async function exchangeSession(acc) {
  var actUrl = BASE + "/qwhdhub/qwhdmark/" + acc.activity_id + "?channelId=" + acc.channel_id;
  $.log("[" + phoneTag(acc.phone) + "] 请求登录页（超时 " + HTTP_TIMEOUT + "s，策略 " + (HTTP_POLICY || "默认直连") + "）");
  // ① 登录中转页，提取一次性 sid
  var loginResp = await $.get(SSO_LOGIN + "?dlwmh=true&actUrl=" + encodeURIComponent(actUrl), {
    headers: { "user-agent": USER_AGENT, "accept-language": "zh-CN,zh-Hans;q=0.9" }
  });
  if (loginResp.status < 200 || loginResp.status >= 400) {
    throw new Error("登录页请求失败（HTTP " + loginResp.status + "），SSO 入口可能已变更");
  }
  var m = String(loginResp.body || "").match(/loginPath\s*=\s*'([^']+)'/);
  if (!m) throw new Error("登录页未返回 sid，SSO 入口可能已变更");
  var loginPath = m[1];
  var loginUrl = loginPath.indexOf("/qwhdsso") === 0 ? BASE + loginPath : BASE + "/qwhdsso" + loginPath;

  var baseBody = {
    provinceCode: acc.province_code,
    cityCode: acc.city_code,
    userCheckId: parseInt(acc.phone, 10).toString(16),
    carrierOperator: acc.carrier_operator,
    appVersionCode: acc.app_version_code,
    took: 120 + Math.floor(Math.random() * 781)
  };

  // ② 优先用缓存 jwt 续期（jwtToken 必须与 token 同时携带）
  var resp = null;
  var cached = loadJwtCache(acc.phone);
  if (cached) {
    try {
      var r = await $.post(loginUrl, JSON.stringify(Object.assign({}, baseBody, { jwtToken: cached.jwt, token: acc.app_token })), {
        headers: { "user-agent": USER_AGENT, "content-type": "application/json;charset=UTF-8" }
      });
      var cand = parseJsonSafe(r.body) || {};
      if (cand.code === "SUCCESS") {
        resp = cand;
        $.log("[" + phoneTag(acc.phone) + "] jwt 续期成功（凭证链已 " + ((Date.now() - cached.first_seen) / 86400000).toFixed(1) + " 天）");
      } else {
        $.log("[" + phoneTag(acc.phone) + "] jwt 续期失败(" + (cand.msg || cand.code) + ")，回落 appTokenLogin 引导");
      }
    } catch (e) {
      $.log("[" + phoneTag(acc.phone) + "] jwt 续期异常(" + e.message + ")，回落 appTokenLogin 引导");
    }
  }

  // ③ 回落：app_token 引导登录（首次配置或 jwt 失效后）
  if (!resp) {
    var r2 = await $.post(loginUrl, JSON.stringify(Object.assign({}, baseBody, { jwtToken: null, token: acc.app_token })), {
      headers: { "user-agent": USER_AGENT, "content-type": "application/json;charset=UTF-8" }
    });
    resp = parseJsonSafe(r2.body) || {};
    if (resp.code !== "SUCCESS") {
      throw new Error("appTokenLogin 失败: " + (resp.code || "?") + " " + (resp.msg || "") + " —— 通常是 app_token 过期，请重新抓包更新凭证");
    }
  }

  var data = resp.data || {};
  if (data.jwt) saveJwtCache(acc.phone, data.jwt);
  if (!data.url) throw new Error("appTokenLogin 未返回活动页 URL");

  // ④ 访问带 token 的活动页，服务器 Set-Cookie: QWHD_SESSION_TOKEN
  if (data.url.indexOf("https://wx.10086.cn") !== 0) throw new Error("活动页 URL 不在 wx.10086.cn 域内，已拒绝");
  var pageResp = await $.get(data.url, {
    headers: { "user-agent": USER_AGENT, "accept-language": "zh-CN,zh-Hans;q=0.9" }
  });
  if (pageResp.status < 200 || pageResp.status >= 400) {
    throw new Error("活动页请求失败（HTTP " + pageResp.status + "）");
  }
  var sessionCookie = extractSessionToken(pageResp.headers);
  if (!sessionCookie) throw new Error("未取得活动会话令牌，会话兑换失败");
  $.log("[" + phoneTag(acc.phone) + "] 活动会话建立成功（" + sessionCookie.name + "=" + sessionCookie.value.slice(0, 12) + "...）");
  return { sessionCookie: sessionCookie, referer: data.url };
}

// ------------------------------------------------------------ 业务接口
async function queryMarkstatus(session) {
  var r = await $.post(API_MARK + "/mark31/markstatus", "{}", {
    headers: apiHeaders(session.referer, session.sessionCookie)
  });
  var resp = parseJsonSafe(r.body) || {};
  if (resp.code !== "SUCCESS") throw new Error("markstatus 失败: " + (resp.code || "?") + " " + (resp.msg || ""));
  return resp.data || {};
}

async function doMark(session, date) {
  var r = await $.post(API_MARK + "/mark31/domark", JSON.stringify({ date: date }), {
    headers: apiHeaders(session.referer, session.sessionCookie)
  });
  return parseJsonSafe(r.body) || {};
}

function parsePrize(markResult) {
  var prize = ((markResult.data || {}).markPrize) || null;
  if (!prize) return "";
  var parts = [prize.name || ""];
  if (prize.prizeValue) parts.push(prize.prizeValue + (prize.prizeCategory === "FLOW" ? "MB" : "元"));
  return parts.filter(Boolean).join(" ");
}

async function claimTaskAwards(session, statusData) {
  var results = [];
  var names = {};
  var pools = [statusData.taskAwardChance || [], statusData.accumulateTaskInfo || [], statusData.myTaskInfo || []];
  pools.forEach(function (pool) {
    (pool || []).forEach(function (t) {
      var tid = t && t.id;
      if (!tid || names[tid]) return;
      var nm = ((t.prize || {}).name) || t.lotteryText || t.prizeAlertText || "";
      if (nm) names[tid] = nm;
    });
  });
  var chances = statusData.taskAwardChance || [];
  for (var i = 0; i < chances.length; i++) {
    var task = chances[i];
    var tid = task && task.id;
    if (!tid) continue;
    var label = "任务" + tid;
    var bits = [];
    if (task.taskType === "accumulate" && task.num) bits.push("累计" + task.num + "签");
    if (names[tid]) bits.push(names[tid]);
    if (bits.length) label += "（" + bits.join("·") + "）";
    try {
      var r = await $.post(API_MARK + "/mark31/taskAward/" + tid, "{}", {
        headers: apiHeaders(session.referer, session.sessionCookie)
      });
      var resp = parseJsonSafe(r.body) || {};
      var d = resp.data || {};
      if (d && typeof d === "object" && d.prizeName) {
        var unit = { FLOW: "MB", FEE: "元" }[d.prizeCategory] || "";
        var amount = d.prizeValue ? ("" + d.prizeValue + unit) : "";
        results.push(label + " 领到: " + d.prizeName + (amount ? "（" + amount + "）" : ""));
      } else {
        results.push(label + ": " + (resp.status || resp.code || "?") + " " + (resp.msg || ""));
      }
    } catch (e) {
      results.push(label + " 领取失败: " + e.message);
    }
    await sleep(1000 + Math.random() * 1000);
  }
  return results;
}

// ------------------------------------------------------------ 单账号执行
async function runCheckin(acc) {
  var lines = [];
  var today = todayStr();
  var session = null;
  var statusData = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      session = await exchangeSession(acc);
      statusData = await queryMarkstatus(session);
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      $.log("[" + phoneTag(acc.phone) + "] 会话异常(" + e.message + ")，重建后重试");
    }
  }
  var userinfo = statusData.userinfo || {};
  var accDays = userinfo.accumulateTimes != null ? userinfo.accumulateTimes : "?";
  var signedToday = (statusData.markstatus || []).some(function (d) {
    return d.date === today && d.status === "1";
  });
  $.log("[" + phoneTag(acc.phone) + "] 当前累计签到 " + accDays + " 天，今日" + (signedToday ? "已签" : "未签"));

  var ok = true;
  if (signedToday) {
    lines.push("今日已签到（累计 " + accDays + " 天），无需操作");
  } else {
    var result = await doMark(session, today);
    var code = result.code, msg = result.msg || "", status = result.status || "";
    $.log("[" + phoneTag(acc.phone) + "] domark 响应: code=" + code + " status=" + status + " msg=" + msg);
    if (code === "SUCCESS" || msg.indexOf("已签") >= 0 || status === "HAVE_MARKED") {
      var prize = parsePrize(result);
      try {
        var nd = await queryMarkstatus(session);
        accDays = ((nd.userinfo || {}).accumulateTimes != null) ? nd.userinfo.accumulateTimes : accDays;
        statusData = nd;
      } catch (e) {}
      if (status === "HAVE_MARKED") {
        lines.push("今日已签到过（服务端幂等），累计 " + accDays + " 天");
      } else {
        lines.push("签到成功！累计 " + accDays + " 天");
        if (prize) lines.push("获得奖品: " + prize);
        else if (status === "PRIZE_NO_CONFIG") lines.push("今日无单日奖品（累计/连签奖励见下方领奖结果）");
      }
    } else {
      lines.push("签到失败: " + code + " / " + status + " / " + msg);
      ok = false;
    }
  }

  // 领奖：门槛达标的累计/连签奖励不会自动发放，默认代领
  if (statusData) {
    try {
      var latest = signedToday ? statusData : await queryMarkstatus(session);
      var chances = latest.taskAwardChance || [];
      if (!chances.length) {
        $.log("[" + phoneTag(acc.phone) + "] 当前无可领取的累计/连签奖励");
      } else {
        var claims = await claimTaskAwards(session, latest);
        claims.forEach(function (c) { lines.push("[领奖] " + c); });
      }
    } catch (e) {
      lines.push("[领奖] 尝试失败: " + e.message);
    }
  }
  return { ok: ok, lines: lines, accDays: accDays };
}

async function runKeepalive(acc) {
  var session = await exchangeSession(acc);
  var tok = session.sessionCookie.value || "";
  return { ok: true, lines: ["会话保活成功（" + session.sessionCookie.name + "=" + tok.slice(0, 12) + "...）"] };
}

// ------------------------------------------------------------ 主流程
function saveStatus(today, ok, detail) {
  try {
    var prev = {};
    try { prev = JSON.parse($.getdata(STATUS_KEY) || "{}"); } catch (e) {}
    prev.last_run = new Date().toISOString();
    prev.last_ok = !!ok;
    prev.detail = detail;
    $.setdata(JSON.stringify(prev), STATUS_KEY);
    var reg = {};
    try { reg = JSON.parse($.getdata(REGISTRY_KEY) || "{}"); } catch (e) {}
    reg[ENV_NAME] = prev.last_run;
    $.setdata(JSON.stringify(reg), REGISTRY_KEY);
  } catch (e) {}
}

async function main() {
  var arg = parseArgument();
  // 出站策略：模块参数 policy（策略组名）。留空 = 默认直连；直连到 wx.10086.cn 挂起时
  // 填你的代理策略组名（如 VPS 节点组），请求改走代理。
  if (arg.policy && String(arg.policy).trim()) HTTP_POLICY = String(arg.policy).trim();
  if (arg.timeout && Number(arg.timeout) > 0) HTTP_TIMEOUT = Number(arg.timeout);
  var mode = String(arg.mode || arg.run || "checkin").toLowerCase();
  if (mode !== "keepalive" && mode !== "checkin") mode = "checkin";
  // 保活开关：模块参数 keepalive=false 时，每小时的保活任务直接跳过
  if (mode === "keepalive") {
    var ka = String(arg.keepalive == null ? "true" : arg.keepalive).toLowerCase();
    if (ka === "false" || ka === "0" || ka === "off" || ka === "no") {
      $.log("保活开关已关闭，跳过");
      $.done();
      return;
    }
  }
  var accounts = readAccounts(arg);
  if (!accounts.length) {
    var tip = "🚫 未配置凭证\n\n请先抓取 appTokenLogin 请求体：\n1. 确保模块已安装且抓包开关 capture 开启；\n2. 打开中国移动 App → 我的 → 签到有礼，等页面加载完；\n3. 收到「✅ 中国移动凭证已更新」通知后再运行签到。\n\n抓不到时请用 Stream/Proxyman 手动抓包，把 appTokenLogin 请求体 JSON 粘贴到模块参数 account 里。";
    $.msg("中国移动 ❌ 未配置凭证", "", tip);
    $.log(tip);
    saveStatus(todayStr(), false, "未配置凭证");
    $.done();
    return;
  }
  var allOk = true;
  var sections = [];
  for (var i = 0; i < accounts.length; i++) {
    var acc = accounts[i];
    var tag = phoneTag(acc.phone);
    if (!acc.app_token) {
      sections.push("👤 " + tag + "\n缺少 token/app_token（抓包 appTokenLogin 请求体的 token 字段）");
      allOk = false;
      continue;
    }
    if (!acc.phone || !/^1\d{10}$/.test(acc.phone)) {
      sections.push("👤 " + tag + "\n缺少合法手机号（抓包 JSON 需含 userCheckId 或 phone 字段）");
      allOk = false;
      continue;
    }
    try {
      var res = mode === "keepalive" ? await runKeepalive(acc) : await runCheckin(acc);
      if (!res.ok) allOk = false;
      sections.push("👤 " + tag + "\n" + res.lines.join("\n"));
    } catch (e) {
      allOk = false;
      var isCred = /APP登录状态已过期|appTokenLogin 失败/.test(String(e.message || ""));
      var hint = isCred ? "\n凭证已失效（App 会话过期），请重新抓包更新凭证" : "";
      sections.push("👤 " + tag + "\n❌ " + (mode === "keepalive" ? "保活失败" : "签到失败") + ": " + (e.message || e) + hint);
      $.log("[" + tag + "] 失败: " + (e.message || e));
    }
  }
  var title = mode === "keepalive" ? "中国移动 保活" : "中国移动";
  var okMark = allOk ? "✅" : "❌";
  var head = mode === "keepalive" ? (allOk ? "会话保活成功" : "会话保活失败") : (allOk ? "签到完成" : "签到失败");
  $.msg(title + " " + okMark + " " + head, "", sections.join("\n\n"));
  saveStatus(todayStr(), allOk, sections.join(" | "));
  $.done();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { main: main, normalizeAccount: normalizeAccount, todayStr: todayStr, parsePrize: parsePrize, extractSessionToken: extractSessionToken };
} else {
  main();
}
