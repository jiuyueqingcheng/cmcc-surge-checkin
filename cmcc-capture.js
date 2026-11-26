// 中国移动 App 凭证自动抓取（Surge http-request）
// 触发：打开中国移动 App → 我的 → 签到有礼，进入签到页时，App 会请求
//   POST https://wx.10086.cn/qwhdsso/appTokenLogin
// 本脚本保存该请求的完整 JSON 请求体到 $persistentStore（cmcc_account），
// 签到脚本下次运行时用它换会话。只在凭证变化时通知一次。
// 开关：模块参数 capture（默认 true）。关闭后不抓取、不覆盖。
// 注意：App 若做证书 pinning，MITM 抓不到，此时请用 Stream/Proxyman 手动抓包，
//   把 appTokenLogin 请求体 JSON 粘贴到模块参数 account 里。

const ENV_NAME = "中国移动";
const STORE_KEY = "cmcc_account";

function Env(name) {
  this.name = name;
  this.isSurge = typeof $httpClient !== "undefined" && typeof $persistentStore !== "undefined";
  this.isLoon = typeof $loon !== "undefined";
  this.isQX = typeof $task !== "undefined";
  this.isNode = typeof module !== "undefined" && !!module.exports;
  this.data = {};
}
Env.prototype.log = function () {
  var msg = Array.prototype.map.call(arguments, function (v) {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  }).join(" ");
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
Env.prototype.done = function () {
  if (typeof $done !== "undefined") $done();
};
var $ = new Env(ENV_NAME);

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

function phoneTag(phone) {
  return phone ? ("手机尾号 " + String(phone).slice(-4)) : "";
}

function main() {
  var arg = parseArgument();
  var capture = String(arg.capture == null ? "true" : arg.capture).toLowerCase();
  if (capture === "false" || capture === "0" || capture === "off" || capture === "no") {
    $.log("抓包开关已关闭，跳过");
    $.done();
    return;
  }
  var body = "";
  try {
    if (typeof $request !== "undefined" && $request.body) body = $request.body;
  } catch (e) {}
  if (!body) {
    $.log("appTokenLogin 请求无 body，跳过");
    $.done();
    return;
  }
  var obj = null;
  try { obj = JSON.parse(body); } catch (e) {}
  if (!obj || typeof obj !== "object" || !obj.token) {
    $.log("appTokenLogin 请求体不是预期的 JSON（无 token 字段），跳过");
    $.done();
    return;
  }
  // 只保留签到需要的字段，存为规范 JSON
  var keep = {};
  ["token", "userCheckId", "provinceCode", "cityCode", "carrierOperator", "appVersionCode"].forEach(function (k) {
    if (obj[k] != null) keep[k] = obj[k];
  });
  var phone = "";
  try { if (obj.userCheckId) phone = String(parseInt(String(obj.userCheckId), 16)); } catch (e) {}
  var text = JSON.stringify(keep);
  var prev = $.getdata(STORE_KEY) || "";
  if (prev === text) {
    $.log("凭证未变化，跳过通知");
    $.done();
    return;
  }
  $.setdata(text, STORE_KEY);
  var tag = phoneTag(phone);
  $.msg("✅ 中国移动凭证已更新", tag ? ("👤 " + tag) : "", "凭证已保存，签到脚本下次运行将使用新凭证。");
  $.log("中国移动凭证已更新" + (tag ? ("（" + tag + "）") : ""));
  $.done();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { main: main };
} else {
  main();
}
