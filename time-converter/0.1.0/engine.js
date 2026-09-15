var TimeEngine = (function () {
'use strict';
/* ═══════════════════════════════════════════════════════════════════
 * 时间转换 · 纯函数引擎(无 DOM)
 *
 * 中间表示:TimePoint = UTC epoch 纳秒(BigInt) + 精度/时区来源/命中解析器元数据。
 * 四精度(秒/毫秒/微秒/纳秒)全保真;墙钟域限定公历年 1-9999。
 *
 * 解析管线:normalize → 责任链(8 个解析器按优先级) → 首个命中即裁决。
 * 禁用 new Date(字符串) 兜底;输入侧只接受显式偏移/Z/系统本地时区。
 * 同一文件双出口:浏览器全局 TimeEngine + node require(module.exports)。
 * ═══════════════════════════════════════════════════════════════════ */

/* ── 常量 ── */

var version = '0.1.0';

// 公历年 1-9999 对应的 epochNs 上下界(UTC 墙钟)
var EPOCH_LIMITS = {
  minNs: -62135596800000000000n,      // 0001-01-01T00:00:00.000000000Z
  maxNs: 253402300799999999999n       // 9999-12-31T23:59:59.999999999Z
};
var SEC_NS = 1000000000n;
var DAY_NS = 86400000000000n;
var DATE_MAX_MS = 8640000000000000;   // JS Date 可表示的毫秒上界(绝对值)

var PARSE_IDS = ['unix', 'compact', 'iso8601', 'rfc2822', 'slash', 'chinese', 'time-only', 'relative'];
var FORMAT_IDS = ['unix', 'iso-utc', 'iso-local', 'local', 'rfc2822', 'chinese', 'human', 'calendar', 'worldclock', 'template'];

var SOURCE_LABELS = {
  'unix-s': 'Unix 秒', 'unix-ms': 'Unix 毫秒', 'unix-us': 'Unix 微秒', 'unix-ns': 'Unix 纳秒',
  'compact': '紧凑日期', 'iso8601': 'ISO 8601', 'rfc2822': 'RFC 2822',
  'slash': '斜杠/点分隔日期', 'chinese': '中文日期', 'time-only': '时刻(今天补全)', 'relative': '相对时间'
};

var WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];            // 周日=0
var WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // 周日=0
var MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// RFC 2822 老时区名 → 固定偏移(分钟,东正)。注意 CST 按 RFC 语义 = 美中 -0600,非中国标准时间。
var RFC2822_ZONES = {
  'GMT': 0, 'UT': 0, 'UTC': 0, 'Z': 0,
  'EST': -300, 'EDT': -240,
  'CST': -360, 'CDT': -300,
  'MST': -420, 'MDT': -360,
  'PST': -480, 'PDT': -420
};

// 相对单位表(中英别名,帮助面板数据源)
var REL_UNITS = [
  { unit: 's', label: '秒', aliases: ['s', 'sec', 'secs', 'second', 'seconds', '秒'] },
  { unit: 'm', label: '分钟', aliases: ['m', 'min', 'mins', 'minute', 'minutes', '分', '分钟'] },
  { unit: 'h', label: '小时', aliases: ['h', 'hr', 'hrs', 'hour', 'hours', '小时'] },
  { unit: 'd', label: '天', aliases: ['d', 'day', 'days', '天'] },
  { unit: 'w', label: '周', aliases: ['w', 'week', 'weeks', '周', '星期'] },
  { unit: 'mo', label: '个月(日历月,月末钳制)', aliases: ['mo', 'month', 'months', '个月'] },
  { unit: 'y', label: '年(日历年)', aliases: ['y', 'year', 'years', '年'] }
];

// 世界时钟默认时区行(ADR-6 精简版;ctx.worldZones 可覆盖)
var WORLD_ZONES = ['UTC', '本地', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

var TEMPLATE_DEFAULT = 'YYYY-MM-DD HH:mm:ss';

// token 表(帮助面板直接渲染;renderTokens 同源)
var TOKENS = [
  { token: 'YYYY', sample: '2026', desc: '四位年份' },
  { token: 'YY', sample: '26', desc: '两位年份(取末两位)' },
  { token: 'MM', sample: '09', desc: '两位月份' },
  { token: 'M', sample: '9', desc: '月份(不补零)' },
  { token: 'DD', sample: '05', desc: '两位日期' },
  { token: 'D', sample: '5', desc: '日期(不补零)' },
  { token: 'HH', sample: '16', desc: '小时 00-23' },
  { token: 'H', sample: '16', desc: '小时(不补零)' },
  { token: 'hh', sample: '04', desc: '小时 01-12(12 时制)' },
  { token: 'h', sample: '4', desc: '12 时制小时(不补零)' },
  { token: 'mm', sample: '30', desc: '两位分钟' },
  { token: 'm', sample: '30', desc: '分钟(不补零)' },
  { token: 'ss', sample: '00', desc: '两位秒' },
  { token: 's', sample: '0', desc: '秒(不补零)' },
  { token: 'S', sample: '1', desc: '亚秒 1 位(分秒)' },
  { token: 'SSS', sample: '123', desc: '亚秒 3 位(毫秒)' },
  { token: 'SSSSSS', sample: '123456', desc: '亚秒 6 位(微秒)' },
  { token: 'SSSSSSSSS', sample: '123456789', desc: '亚秒 9 位(纳秒)' },
  { token: 'A', sample: '下午', desc: '上午/下午' },
  { token: 'a', sample: 'pm', desc: 'am/pm' },
  { token: 'd', sample: '2', desc: '星期数字(周日=0)' },
  { token: 'dd', sample: '周二', desc: '星期短名' },
  { token: 'dddd', sample: '星期二', desc: '星期全名' },
  { token: 'E', sample: '2', desc: 'ISO 星期 1-7(周一=1)' },
  { token: 'DDD', sample: '258', desc: '年内第几天' },
  { token: 'DDDD', sample: '0258', desc: '年内第几天(补零 4 位)' },
  { token: 'w', sample: '38', desc: 'ISO 周号' },
  { token: 'ww', sample: '38', desc: 'ISO 周号(补零)' },
  { token: 'Q', sample: '3', desc: '季度 1-4' },
  { token: 'QQ', sample: 'Q3', desc: '季度 Q1-Q4' },
  { token: 'Z', sample: '+08:00', desc: '时区偏移 ±HH:MM' },
  { token: 'ZZ', sample: '+0800', desc: '时区偏移 ±HHMM' },
  { token: 'z', sample: 'Asia/Shanghai', desc: '时区名/标签' },
  { token: '[字面]', sample: '原样', desc: '方括号内容原样输出,不解析' }
];

/* ── 小工具 ── */

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

function floorDiv(a, b) { var q = a / b; if ((a % b) !== 0n && ((a < 0n) !== (b < 0n))) q -= 1n; return q; }
function floorMod(a, b) { return a - floorDiv(a, b) * b; }

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysInMonth(y, m) { return m === 2 ? (isLeap(y) ? 29 : 28) : DAYS_IN_MONTH[m - 1]; }
function daysInYear(y) { return isLeap(y) ? 366 : 365; }

/* Hinnant 民用历算法(负值安全) */
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  var era = Math.floor(y / 400);
  var yoe = y - era * 400;
  var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z) {
  z += 719468;
  var era = Math.floor(z / 146097);
  var doe = z - era * 146097;
  var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  var y = yoe + era * 400;
  var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  var mp = Math.floor((5 * doy + 2) / 153);
  var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  var m = mp < 10 ? mp + 3 : mp - 9;
  return { y: y + (m <= 2 ? 1 : 0), m: m, d: d };
}

/* ISO 8601 周号(含周年) */
function isoWeeksInYear(y) {
  function p(x) { return (x + Math.floor(x / 4) - Math.floor(x / 100) + Math.floor(x / 400)) % 7; }
  return p(y) === 4 || p(y - 1) === 3 ? 53 : 52;
}
function isoWeekInfo(y, m, d) {
  var days = daysFromCivil(y, m, d);
  var ord = days - daysFromCivil(y, 1, 1) + 1;
  var wds = (((days % 7) + 7) % 7 + 4) % 7;      // 周日=0(纯 Number,负值安全)
  var wd = (wds + 6) % 7 + 1;                     // ISO 周一=1…周日=7
  var w = Math.floor((ord - wd + 10) / 7);
  if (w < 1) { var py = y - 1; return { week: isoWeeksInYear(py), year: py }; }
  if (w > isoWeeksInYear(y)) return { week: 1, year: y + 1 };
  return { week: w, year: y };
}

/* 错误对象 */
function err(code, message, hint) { return { code: code, message: message, hint: hint || undefined }; }
function errAt(res, code, message, hint) { return { ok: false, error: err(code, message, hint) }; }

/* ════════════════ 内核:epochNs ⇄ 墙钟 ═══════════════════════════ */

/**
 * 墙钟分解:绝对时刻 → 指定时区的日历字段(纯函数,输出侧唯一投影入口)。
 * zone: {kind:'system'|'utc'|'offset'|'iana', offsetMin?, name?}
 * @returns {WallFields} { year,month(1-12),day,hour(0-23),minute,second,
 *   milli,micro,nano(亚秒纳秒 0-999999999),weekday(0-6 周日=0),isoWeekday(1-7),
 *   isoWeek,isoWeekYear,dayOfYear,quarter,offsetMin,zoneLabel,epochMs }
 * @throws {EngineError} OUT_OF_RANGE(墙钟年 1-9999 之外)
 */
function wallClock(point, zone) {
  var ns = point.epochNs;
  var kind = (zone && zone.kind) || 'system';
  var f;
  if (kind === 'system') {
    var msAbs = Number(ns / 1000000n);
    if (msAbsOutOfRange(ns)) throw err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)');
    var dt = new Date(msAbs);
    f = {
      year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate(),
      hour: dt.getHours(), minute: dt.getMinutes(), second: dt.getSeconds(),
      offsetMin: -dt.getTimezoneOffset(),
      zoneLabel: systemZoneLabel()
    };
  } else if (kind === 'iana') {
    var tz = zone.name;
    if (msAbsOutOfRange(ns)) throw err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)');
    var ms = Number(ns / 1000000n);
    var parts = ianaParts(tz, ms);
    if (!parts) throw err('OUT_OF_RANGE', '未知时区 ' + tz);
    var asUTC = utcMsFromFields(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    f = {
      year: parts.year, month: parts.month, day: parts.day,
      hour: parts.hour, minute: parts.minute, second: parts.second,
      offsetMin: Math.round((asUTC - ms) / 60000),
      zoneLabel: tz
    };
  } else {
    // 'utc' / 'offset':纯 BigInt 直算,支持年 1-9999 全域
    var offMin = kind === 'offset' ? (zone.offsetMin || 0) : 0;
    var shifted = ns + BigInt(offMin) * 60000000000n;
    var totalSec = floorDiv(shifted, SEC_NS);
    var days = floorDiv(totalSec, 86400n);
    var sod = totalSec - days * 86400n;
    var civ = civilFromDays(Number(days));
    var h = Number(sod / 3600n);
    var mi = Number((sod % 3600n) / 60n);
    var se = Number(sod % 60n);
    f = {
      year: civ.y, month: civ.m, day: civ.d, hour: h, minute: mi, second: se,
      offsetMin: offMin,
      zoneLabel: kind === 'utc' ? 'UTC' : 'UTC' + fmtOffset(offMin)
    };
  }
  // 统一墙钟年域检查(公历年 1-9999,四条路径一致)
  if (f.year < 1 || f.year > 9999) throw err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)');
  var sub = Number(floorMod(ns, SEC_NS));   // 亚秒纳秒(0-999999999),与偏移对齐无关(偏移恒为整分钟)
  f.milli = Math.floor(sub / 1e6);
  f.micro = Math.floor(sub / 1e3);
  f.nano = sub;
  f.epochMs = Number(ns / 1000000n);
  f.weekday = Number(floorMod(floorDiv(ns + BigInt(f.offsetMin) * 60000000000n, DAY_NS) + 4n, 7n));
  f.isoWeekday = (f.weekday + 6) % 7 + 1;
  f.dayOfYear = daysFromCivil(f.year, f.month, f.day) - daysFromCivil(f.year, 1, 1) + 1;
  f.quarter = Math.floor((f.month - 1) / 3) + 1;
  var wk = isoWeekInfo(f.year, f.month, f.day);
  f.isoWeek = wk.week;
  f.isoWeekYear = wk.year;
  return f;
}

/* system zone 下 Date 可表示范围(墙钟年 1-9999 恒在 Date 域内) */
function msAbsOutOfRange(ns) { var a = ns < 0n ? -ns : ns; return a > BigInt(DATE_MAX_MS) * 1000000n; }

var _sysZoneLabel = null;
function systemZoneLabel() {
  if (_sysZoneLabel === null) {
    try { _sysZoneLabel = (new Intl.DateTimeFormat()).resolvedOptions().timeZone || '本地'; }
    catch (e) { _sysZoneLabel = '本地'; }
  }
  return _sysZoneLabel;
}

/* Intl 拆解指定 IANA 时区的墙钟字段(h23 避免 24 时制歧义) */
var _ianaFmtCache = {};
function ianaParts(tz, ms) {
  try {
    var fmt = _ianaFmtCache[tz] || (_ianaFmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
    var o = {};
    fmt.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = p.value; });
    var y = Number(o.year), m = Number(o.month), d = Number(o.day);
    var h = Number(o.hour), mi = Number(o.minute), s = Number(o.second);
    if (isNaN(y) || isNaN(m) || isNaN(d) || isNaN(h) || isNaN(mi) || isNaN(s)) return null;
    return { year: y, month: m, day: d, hour: h, minute: mi, second: s };
  } catch (e) { return null; }
}

/* 由墙钟字段构造"视作 UTC"的毫秒(规避 Date.UTC 两位年份陷阱) */
function utcMsFromFields(y, m, d, h, mi, s) {
  var dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(h, mi, s, 0);
  return dt.getTime();
}

/* fmtOffset:分钟 → ±HH:MM */
function fmtOffset(min) {
  var sign = min < 0 ? '-' : '+';
  var a = Math.abs(min);
  return sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}
function fmtOffsetCompact(min) {
  var sign = min < 0 ? '-' : '+';
  var a = Math.abs(min);
  return sign + pad2(Math.floor(a / 60)) + pad2(a % 60);
}

/**
 * 墙钟字段 → TimePoint(输入侧唯一合成入口;'iana' 不支持,见设计 DST 边界)。
 * @param {{y,m,d,h,mi,s,ns}} f
 * @param {ZoneRef} zone {kind:'system'|'utc'|'offset', offsetMin?}
 * @param {TimePoint} [base] 字段缺省值载体(1月1日→当年, 12:30→今天)
 * @returns {TimePoint|null} null=字段无效(回读校验失败)
 */
function fromWallClock(f, zone, base) {
  if (f.y < 1 || f.y > 9999) return null;
  if (validateFields(f)) return null;
  var kind = (zone && zone.kind) || 'system';
  var bf = null;
  if (base) bf = wallClock(base, { kind: kind === 'offset' ? 'offset' : kind, offsetMin: zone && zone.offsetMin });
  var y = f.y !== undefined ? f.y : (bf ? bf.year : 1970);
  var m = f.m !== undefined ? f.m : (bf ? bf.month : 1);
  var d = f.d !== undefined ? f.d : (bf ? bf.day : 1);
  var h = f.h !== undefined ? f.h : 0;
  var mi = f.mi !== undefined ? f.mi : 0;
  var s = f.s !== undefined ? f.s : 0;
  var ns = f.ns !== undefined ? f.ns : 0;
  // 重新校验补全后的完整字段(缺省填充后再查)
  var full = { y: y, m: m, d: d, h: h, mi: mi, s: s, ns: ns };
  if (validateFields(full)) return null;
  var days = daysFromCivil(y, m, d);
  var wallNs = (BigInt(days) * 86400n + BigInt(h * 3600 + mi * 60 + s)) * SEC_NS + BigInt(ns);
  var point;
  if (kind === 'system') {
    var probe = new Date(0);
    probe.setFullYear(y, m - 1, d);
    probe.setHours(h, mi, s, 0);
    var offMin = -probe.getTimezoneOffset();
    var epochNs = wallNs - BigInt(offMin) * 60000000000n;
    point = makePoint(epochNs, inferPrecision(ns), { kind: 'local' });
  } else if (kind === 'offset') {
    var off = zone.offsetMin || 0;
    point = makePoint(wallNs - BigInt(off) * 60000000000n, inferPrecision(ns),
      { kind: 'explicit', offsetMin: off });
  } else if (kind === 'utc') {
    point = makePoint(wallNs, inferPrecision(ns), { kind: 'explicit', offsetMin: 0 });
  } else {
    return null; // 'iana' 输入侧不支持
  }
  if (epochAbsOutOfRange(point.epochNs)) return null;
  return point;
}

function epochAbsOutOfRange(ns) {
  var a = ns < 0n ? -ns : ns;
  return a > BigInt(DATE_MAX_MS) * 1000000n;
}

/* 字段合法性:返回 null 或 {field,value,max} */
function validateFields(f) {
  var y = f.y !== undefined ? f.y : 1, m = f.m !== undefined ? f.m : 1, d = f.d !== undefined ? f.d : 1;
  if (f.m !== undefined && (f.m < 1 || f.m > 12))
    return { field: 'month', value: f.m, max: 12 };
  if (f.d !== undefined && (f.d < 1 || f.d > daysInMonth(y, m)))
    return { field: 'day', value: f.d, max: daysInMonth(y, m), year: y, month: m };
  if (f.h !== undefined && (f.h < 0 || f.h > 23)) return { field: 'hour', value: f.h, max: 23 };
  if (f.mi !== undefined && (f.mi < 0 || f.mi > 59)) return { field: 'minute', value: f.mi, max: 59 };
  if (f.s !== undefined && (f.s < 0 || f.s > 59)) return { field: 'second', value: f.s, max: 59 };
  if (f.ns !== undefined && (f.ns < 0 || f.ns > 999999999)) return { field: 'ns', value: f.ns, max: 999999999 };
  return null;
}

/* 结构化字段错误 → 中文文案 */
function fieldsError(f, bad) {
  var y = f.y !== undefined ? f.y : null, m = f.m !== undefined ? f.m : null;
  var head = y !== null && m !== null ? y + '-' + pad2(m) + '-' + pad2(f.d !== undefined ? f.d : 1) : '';
  if (bad.field === 'month') return err('INVALID_FIELDS', '月份必须是 1-12,收到 ' + f.m);
  if (bad.field === 'day') return err('INVALID_FIELDS',
    head + ' 不存在——' + m + ' 月只有 ' + bad.max + ' 天');
  if (bad.field === 'hour') return err('INVALID_FIELDS', '小时必须是 0-23,收到 ' + f.h);
  if (bad.field === 'minute') return err('INVALID_FIELDS', '分钟必须是 0-59,收到 ' + f.mi);
  if (bad.field === 'second') return err('INVALID_FIELDS', '秒必须是 0-59,收到 ' + f.s);
  return err('INVALID_FIELDS', '字段超出范围');
}

function makePoint(epochNs, precision, zone, source) {
  return { epochNs: epochNs, precision: precision, zone: zone, source: source || '' };
}
function inferPrecision(ns) {
  if (ns === 0) return 's';
  if (ns % 1000000 === 0) return 'ms';
  if (ns % 1000 === 0) return 'us';
  return 'ns';
}
/* 输入小数位数 → 精度(≤3 位 ms,≤6 位 us,更多 ns) */
function fracPrecision(nd) { return nd <= 3 ? 'ms' : nd <= 6 ? 'us' : 'ns'; }
/* 小数秒字符串 → 亚秒纳秒(右移补零:'5' → 5e8,'123456' → 123456000) */
function fracToNs(frac) { return Number((frac + '000000000').slice(0, 9)); }

/* ════════════════ 解析层 ═════════════════════════════════════════ */

/* 归一化:trim + 全角字符转半角 + 折叠连续空白 */
var FW_RE = /[\uFF01-\uFF5E\u3000]/g;
function normalizeInput(raw) {
  return String(raw == null ? '' : raw).replace(FW_RE, function (ch) {
    if (ch === '　') return ' ';
    var code = ch.charCodeAt(0) - 0xFEE0;  // 全角区 → 半角
    return String.fromCharCode(code);
  }).replace(/\s+/g, ' ').trim();
}

/**
 * 解析入口:任意文本 → TimePoint 或结构化错误。
 * @param {string} raw
 * @param {ParseOptions} [opts] { nowMs, zoneFallback:'local'|'utc', twoDigitPivot:number=68 }
 * @returns {{ok:true, point:TimePoint, consumed:string}|{ok:false, error:{code,message,hint?}}}
 */
function parseTime(raw, opts) {
  opts = opts || {};
  var nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  var fb = opts.zoneFallback === 'utc' ? 'utc' : 'local';
  var ctx = { nowMs: nowMs, fb: fb, pivot: opts.twoDigitPivot === undefined ? 68 : opts.twoDigitPivot };
  var s = normalizeInput(raw);
  if (!s) return { ok: false, error: err('EMPTY', '输入为空') };
  for (var i = 0; i < PARSERS.length; i++) {
    var r = PARSERS[i].fn(s, ctx);
    if (r === null) continue;          // 形状不符,继续责任链
    if (r.err) return { ok: false, error: r.err };
    return { ok: true, point: r.point, consumed: s };
  }
  return {
    ok: false,
    error: err('UNRECOGNIZED', '无法识别的时间格式「' + trunc(s, 40) + '」',
      '支持:时间戳(10/13/16/19 位)、ISO 8601、RFC 2822、2024/1/1、2024年1月1日、12:30、now、+3d 等——点右上角「帮助」查看全部')
  };
}

function trunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

/** 定向解析(反向回填/单测) @returns {TimePoint|null} */
function parseAs(id, raw, opts) {
  opts = opts || {};
  var nowMs = opts.nowMs === undefined ? Date.now() : opts.nowMs;
  var fb = opts.zoneFallback === 'utc' ? 'utc' : 'local';
  var ctx = { nowMs: nowMs, fb: fb, pivot: opts.twoDigitPivot === undefined ? 68 : opts.twoDigitPivot };
  var s = normalizeInput(raw);
  if (!s) return null;
  var fn = PARSER_MAP[id];
  if (!fn) return null;
  var r = fn(s, ctx);
  return (r && r.point) ? r.point : null;
}

/* ── 解析器 1:unix 时间戳(位数路由) ── */

function parseUnix(s, ctx) {
  if (!/^[+-]?\d+$/.test(s)) return null;
  var neg = s[0] === '-';
  var digits = s.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
  var len = digits === '' ? 1 : digits.length;
  if (digits === '0')   // 零值戳按秒解释(0/000/0000000000 同一刻)
    return { point: makePoint(0n, 's', { kind: ctx.fb === 'utc' ? 'utc' : 'local' }, 'unix-s') };
  if (len === 11 || len === 12)
    return { err: err('AMBIGUOUS', '无法判断秒/毫秒——11~12 位数字请补全为 10 或 13 位') };
  if (len !== 10 && len !== 13 && len !== 16 && len !== 19) return null;
  var v = BigInt((neg ? '-' : '') + digits);
  var prec = len === 10 ? 's' : len === 13 ? 'ms' : len === 16 ? 'us' : 'ns';
  var ns = prec === 's' ? v * SEC_NS : prec === 'ms' ? v * 1000000n : prec === 'us' ? v * 1000n : v;
  return { point: makePoint(ns, prec, { kind: ctx.fb === 'utc' ? 'utc' : 'local' },
    'unix-' + prec) };
}

/* 带小数秒形式:`1700000000.123456`(整数部 ≤10 位 → 秒 + 纳秒精度) */
function parseUnixDecimal(s, ctx) {
  var m = /^[+-]?(\d{1,10})\.(\d+)$/.exec(s);
  if (!m) return null;
  var frac = m[2];
  if (frac.length > 9)
    return { err: err('AMBIGUOUS', '亚秒最多 9 位纳秒——「' + trunc(s, 24) + '」的小数位过长') };
  var secStr = m[1].replace(/^0+(?=\d)/, '');
  var secs = BigInt(secStr === '' ? '0' : secStr);
  var v = secs * SEC_NS + BigInt(fracToNs(m[2]));
  return { point: makePoint(v, 'ns', { kind: ctx.fb === 'utc' ? 'utc' : 'local' }, 'unix-ns') };
}

/* ── 解析器 2:紧凑数字(YYYYMMDD / YYYYMMDDHHmmss) ── */

function parseCompact(s, ctx) {
  if (!/^\d+$/.test(s)) return null;
  if (s.length <= 6)
    return { err: err('AMBIGUOUS', '太短无法判断(可补全年份,如 20250103)') };
  var y, m, d, h, mi, se, f;
  if (s.length === 8) {
    y = Number(s.slice(0, 4)); m = Number(s.slice(4, 6)); d = Number(s.slice(6, 8));
    h = 0; mi = 0; se = 0;
  } else if (s.length === 14) {
    y = Number(s.slice(0, 4)); m = Number(s.slice(4, 6)); d = Number(s.slice(6, 8));
    h = Number(s.slice(8, 10)); mi = Number(s.slice(10, 12)); se = Number(s.slice(12, 14));
  } else {
    return null; // 其余位数不猜(9/10/11/12/13…由 unix/其它解析器裁决)
  }
  var bad = validateFields({ y: y, m: m, d: d, h: h, mi: mi, s: se });
  if (bad) return { err: fieldsError({ y: y, m: m, d: d, h: h, mi: mi, s: se }, bad) };
  var p = synth({ y: y, m: m, d: d, h: h, mi: mi, s: se, ns: 0 }, ctx.fb);
  if (!p) return { err: err('INVALID_FIELDS', '字段超出范围') };
  p.source = 'compact';
  return { point: p };
}

/* 合成:按 zoneFallback 解释墙钟 */
function synth(f, fb) {
  var z = fb === 'utc' ? { kind: 'utc' } : { kind: 'system' };
  return fromWallClock(f, z, null);
}

/* ── 解析器 3:ISO 8601 / RFC 3339 ── */

var ISO_RE = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[Tt ](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:[.,](\d{1,9}))?)?(?:\s?(Z|z|[+-](?:\d{2}(?::?\d{2})?|\d{1}:\d{2})))?$/;

function parseOffset(tok) {
  // 'Z' → 0;'+08' / '+0830' / '+08:30' / '+8:30' → 分钟
  if (tok === 'Z' || tok === 'z') return { min: 0, label: 'Z' };
  var m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tok);
  if (!m) return null;
  var h = Number(m[2]), mi = m[3] ? Number(m[3]) : 0;
  if (h > 14 || (h === 14 && mi > 0) || mi > 59) return null;
  var min = h * 60 + mi;
  return { min: m[1] === '-' ? -min : min, label: tok.toUpperCase() };
}

function parseIso(s, ctx) {
  var m = ISO_RE.exec(s);
  if (!m) return null;
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = m[3] !== undefined ? Number(m[3]) : 1;
  var h = m[4] !== undefined ? Number(m[4]) : 0;
  var mi = m[5] !== undefined ? Number(m[5]) : 0;
  var se = m[6] !== undefined ? Number(m[6]) : 0;
  var frac = m[7] || '';
  var ztok = m[8];
  var bad = validateFields({ y: y, m: mo, d: d, h: h, mi: mi, s: se });
  if (bad) return { err: fieldsError({ y: y, m: mo, d: d, h: h, mi: mi, s: se }, bad) };
  var ns = frac ? fracToNs(frac) : 0;
  var prec = frac ? fracPrecision(frac.length) : 's';
  if (ztok) {
    var off = parseOffset(ztok);
    if (!off) return { err: err('INVALID_FIELDS', '时区偏移超出范围(' + ztok + ')') };
    if (y < 1 || y > 9999) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
    var days = daysFromCivil(y, mo, d);
    var wallNs = (BigInt(days) * 86400n + BigInt(h * 3600 + mi * 60 + se)) * SEC_NS + BigInt(ns);
    var p = makePoint(wallNs - BigInt(off.min) * 60000000000n, prec,
      { kind: 'explicit', offsetMin: off.min }, 'iso8601');
    if (epochAbsOutOfRange(p.epochNs)) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
    return { point: p };
  }
  p = synth({ y: y, m: mo, d: d, h: h, mi: mi, s: se, ns: ns }, ctx.fb);
  if (!p) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
  p.source = 'iso8601';
  p.precision = prec;
  return { point: p };
}

/* ── 解析器 4:RFC 2822 ── */

var RFC2822_RE = /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,)?\s*(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{2}:?\d{2}|-0000|[a-z]{1,5}))?$/i;
var MONTH_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseRfc2822(s, ctx) {
  var m = RFC2822_RE.exec(s);
  if (!m) return null;
  var y = m[4].length === 2 ? pivot(Number(m[4]), ctx.pivot) : Number(m[4]);
  var mo = MONTH_IDX[m[3].toLowerCase()];
  var d = Number(m[2]);
  var h = Number(m[5]), mi = Number(m[6]);
  var se = m[7] !== undefined ? Number(m[7]) : 0;
  var bad = validateFields({ y: y, m: mo, d: d, h: h, mi: mi, s: se });
  if (bad) return { err: fieldsError({ y: y, m: mo, d: d, h: h, mi: mi, s: se }, bad) };
  var ztok = m[8];
  var offMin = null;
  if (ztok) {
    if (/^[+-]\d{2}:?\d{2}$/.test(ztok)) {
      var digits = ztok.replace(':', '');
      var hh = Number(digits.slice(1, 3)), mm = Number(digits.slice(3, 5));
      if (hh > 23 || mm > 59) return { err: err('INVALID_FIELDS', '时区偏移超出范围(' + ztok + ')') };
      offMin = (ztok[0] === '-' ? -1 : 1) * (hh * 60 + mm);
    } else {
      var name = ztok.toUpperCase();
      if (!(name in RFC2822_ZONES))
        return { err: err('UNRECOGNIZED', '无法识别时区名「' + ztok + '」') };
      offMin = RFC2822_ZONES[name];
    }
  }
  var p;
  if (offMin !== null) {
    if (y < 1 || y > 9999) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
    var days = daysFromCivil(y, mo, d);
    var wallNs = (BigInt(days) * 86400n + BigInt(h * 3600 + mi * 60 + se)) * SEC_NS;
    p = makePoint(wallNs - BigInt(offMin) * 60000000000n, 's',
      { kind: 'explicit', offsetMin: offMin }, 'rfc2822');
    if (epochAbsOutOfRange(p.epochNs)) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
    return { point: p };
  }
  p = synth({ y: y, m: mo, d: d, h: h, mi: mi, s: se, ns: 0 }, ctx.fb);
  if (!p) return { err: err('INVALID_FIELDS', '字段超出范围') };
  p.source = 'rfc2822';
  return { point: p };
}

/* 两位年份 → pivot(默认 68:00-68→20xx,69-99→19xx) */
function pivot(yy, p) { return yy <= p ? 2000 + yy : 1900 + yy; }

/* ── 解析器 5:斜杠/点分隔 ── */

var SLASH_RE = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?)?$/;

function parseSlash(s, ctx) {
  var m = SLASH_RE.exec(s);
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var h = m[4] !== undefined ? Number(m[4]) : 0;
  var mi = m[5] !== undefined ? Number(m[5]) : 0;
  var se = m[6] !== undefined ? Number(m[6]) : 0;
  var frac = m[7] || '';
  var bad = validateFields({ y: y, m: mo, d: d, h: h, mi: mi, s: se });
  if (bad) return { err: fieldsError({ y: y, m: mo, d: d, h: h, mi: mi, s: se }, bad) };
  var p = synth({ y: y, m: mo, d: d, h: h, mi: mi, s: se, ns: frac ? fracToNs(frac) : 0 }, ctx.fb);
  if (!p) return { err: err('INVALID_FIELDS', '字段超出范围') };
  p.source = 'slash';
  p.precision = frac ? fracPrecision(frac.length) : 's';
  return { point: p };
}

/* ── 解析器 6:中文日期 ── */

var CN_TIME_ZH_RE = /^(\d{1,2})时(?:(\d{1,2})分(?:(\d{1,2})秒)?)?$/;
var CN_TIME_COLON_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?$/;

/* 时间片段:中文时式或冒号式 → {h,mi,s,ns,prec} 或 null(不匹配) 或 {err} */
function cnTimePart(t) {
  var m = CN_TIME_ZH_RE.exec(t);
  if (m) {
    var h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0, se = m[3] ? Number(m[3]) : 0;
    var bad = validateFields({ h: h, mi: mi, s: se });
    if (bad) return { err: fieldsError({ h: h, mi: mi, s: se }, bad) };
    return { h: h, mi: mi, s: se, ns: 0, prec: 's' };
  }
  m = CN_TIME_COLON_RE.exec(t);
  if (m) {
    h = Number(m[1]); mi = Number(m[2]); se = m[3] ? Number(m[3]) : 0;
    var frac = m[4] || '';
    bad = validateFields({ h: h, mi: mi, s: se });
    if (bad) return { err: fieldsError({ h: h, mi: mi, s: se }, bad) };
    return { h: h, mi: mi, s: se, ns: frac ? fracToNs(frac) : 0, prec: frac ? fracPrecision(frac.length) : 's' };
  }
  return null;
}

function parseChinese(s, ctx) {
  // 形态 A:[YYYY年][M月][D日][ 时间]
  var m = /^(\d{1,4})年(?:\s?(\d{1,2})月(?:\s?(\d{1,2})日)?)?(?:\s+(\S+))?$/.exec(s);
  if (m) {
    var yy = m[1].length <= 2 ? pivot(Number(m[1]), ctx.pivot) : Number(m[1]);
    var hasMonth = m[2] !== undefined;
    var mo = m[2] ? Number(m[2]) : 1;
    var d = m[3] ? Number(m[3]) : 1;
    var tp = m[4] ? cnTimePart(m[4]) : null;
    if (tp && tp.err) return { err: tp.err };
    if (m[4] && !tp) return null; // 时间部分不像时间 → 交给责任链
    var h = tp ? tp.h : 0, mi = tp ? tp.mi : 0, se = tp ? tp.s : 0, ns = tp ? tp.ns : 0;
    var bad = validateFields({ y: yy, m: hasMonth ? mo : 1, d: d, h: h, mi: mi, s: se });
    if (bad) return { err: fieldsError({ y: yy, m: mo, d: d, h: h, mi: mi, s: se }, bad) };
    var p = synth({ y: yy, m: hasMonth ? mo : 1, d: d, h: h, mi: mi, s: se, ns: ns }, ctx.fb);
    if (!p) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
    p.source = 'chinese';
    p.precision = tp ? tp.prec : 's';
    return { point: p };
  }
  // 形态 B:M月D日 [时间](当年补全)
  m = /^(\d{1,2})月(\d{1,2})日(?:\s+(\S+))?$/.exec(s);
  if (m) {
    var mo2 = Number(m[1]), d2 = Number(m[2]);
    tp = m[3] ? cnTimePart(m[3]) : null;
    if (tp && tp.err) return { err: tp.err };
    if (m[3] && !tp) return null;
    var bw = todayWall(ctx.nowMs);
    bad = validateFields({ y: bw.year, m: mo2, d: d2 });
    if (bad) return { err: fieldsError({ y: bw.year, m: mo2, d: d2 }, bad) };
    var p = fromWallClock({ y: bw.year, m: mo2, d: d2, h: tp ? tp.h : 0, mi: tp ? tp.mi : 0, s: tp ? tp.s : 0, ns: tp ? tp.ns : 0 },
      ctx.fb === 'utc' ? { kind: 'utc' } : { kind: 'system' }, null);
    if (!p) return { err: err('INVALID_FIELDS', '字段超出范围') };
    p.source = 'chinese';
    p.precision = tp ? tp.prec : 's';
    return { point: p };
  }
  // 形态 C:纯中文时刻(12时30分[25秒] → 今天)
  if (/^\d{1,2}时/.test(s)) {
    var tp2 = cnTimePart(s);
    if (!tp2) return null;
    if (tp2.err) return { err: tp2.err };
    var bw2 = todayWall(ctx.nowMs);
    var p2 = fromWallClock({ y: bw2.year, m: bw2.month, d: bw2.day, h: tp2.h, mi: tp2.mi, s: tp2.s, ns: tp2.ns },
      ctx.fb === 'utc' ? { kind: 'utc' } : { kind: 'system' }, null);
    if (!p2) return { err: err('INVALID_FIELDS', '字段超出范围') };
    p2.source = 'chinese';
    p2.precision = tp2.prec;
    return { point: p2 };
  }
  return null;
}

/* 今天(本地墙钟)的日历字段 */
function todayWall(nowMs) {
  return wallClock({ epochNs: BigInt(Math.round(nowMs)) * 1000000n, precision: 'ms', zone: { kind: 'local' } }, { kind: 'system' });
}

/* ── 解析器 7:时刻(12:30 → 今天) ── */

function parseTimeOnly(s, ctx) {
  var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?$/.exec(s);
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2]);
  var se = m[3] !== undefined ? Number(m[3]) : 0;
  var frac = m[4] || '';
  var bad = validateFields({ h: h, mi: mi, s: se });
  if (bad) return { err: fieldsError({ h: h, mi: mi, s: se }, bad) };
  var bw = todayWall(ctx.nowMs);
  var p = fromWallClock({ y: bw.year, m: bw.month, d: bw.day, h: h, mi: mi, s: se, ns: frac ? fracToNs(frac) : 0 },
    { kind: 'system' }, null);
  if (!p) return { err: err('INVALID_FIELDS', '字段超出范围') };
  p.source = 'time-only';
  p.precision = frac ? fracPrecision(frac.length) : 's';
  return { point: p };
}

/* ── 解析器 8:相对表达 ── */

var UNIT_MAP = { s: 's', sec: 's', secs: 's', second: 's', seconds: 's', 秒: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm', 分: 'm', 分钟: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', 小时: 'h',
  d: 'd', day: 'd', days: 'd', 天: 'd',
  w: 'w', week: 'w', weeks: 'w', 周: 'w', 星期: 'w',
  mo: 'mo', month: 'mo', months: 'mo', 个月: 'mo',
  y: 'y', year: 'y', years: 'y', 年: 'y' };

/* 相对关键词:基准墙钟(本地)上取整到 00:00 后施加天数/日历项 */
var REL_KEYWORDS = {
  'now': null, '现在': null, '刚刚': null,
  'today': { months: 0, days: 0, mid: true }, '今天': { months: 0, days: 0, mid: true },
  'yesterday': { months: 0, days: -1, mid: true }, '昨天': { months: 0, days: -1, mid: true },
  'tomorrow': { months: 0, days: 1, mid: true }, '明天': { months: 0, days: 1, mid: true },
  '前天': { months: 0, days: -2, mid: true }, '后天': { months: 0, days: 2, mid: true },
  'last week': { months: 0, days: -7, mid: true }, '上周': { months: 0, days: -7, mid: true },
  'next week': { months: 0, days: 7, mid: true }, '下周': { months: 0, days: 7, mid: true },
  'last month': { months: -1, days: 0, mid: true }, '上个月': { months: -1, days: 0, mid: true },
  'next month': { months: 1, days: 0, mid: true }, '下个月': { months: 1, days: 0, mid: true },
  'last year': { months: 0, years: -1, mid: true }, '去年': { months: 0, years: -1, mid: true },
  'next year': { months: 0, years: 1, mid: true }, '明年': { months: 0, years: 1, mid: true }
};

function parseRelative(s, ctx) {
  var low = s.toLowerCase();
  if (low === 'now' || s === '现在' || s === '刚刚')
    return { point: makePoint(BigInt(Math.round(ctx.nowMs)) * 1000000n, 'ms', { kind: 'local' }, 'relative') };

  // 关键词日期词(本地墙钟 00:00)
  var kw = REL_KEYWORDS[s] !== undefined ? REL_KEYWORDS[s] : REL_KEYWORDS[low];
  if (kw !== undefined && kw !== null) {
    var bw = todayWall(ctx.nowMs);
    var f = { y: bw.year + (kw.years || 0), m: bw.month, d: bw.day, h: 0, mi: 0, s: 0, ns: 0 };
    if (kw.months) {
      var t = (f.m - 1) + kw.months;
      f.y += Math.floor(t / 12);
      f.m = ((t % 12) + 12) % 12 + 1;
      f.d = Math.min(f.d, daysInMonth(f.y, f.m));
    }
    if (kw.days) {
      var dn = daysFromCivil(f.y, f.m, f.d) + kw.days;
      var civ = civilFromDays(dn);
      f.y = civ.y; f.m = civ.m; f.d = civ.d;
    }
    var bad = validateFields(f);
    if (bad) return { err: fieldsError(f, bad) };
    var p = fromWallClock(f, { kind: 'system' }, null);
    if (!p) return { err: err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
    p.source = 'relative';
    p.precision = 's';
    return { point: p };
  }

  // 英文长式:`in 2 hours` / `2 hours ago` / `1d ago`(裸时长无方向 → 不收)
  var m = /^(in\s+)?(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|s|m|h|d|w|mo|y)\s*(ago)?$/.exec(low);
  if (m) {
    var ago = !!m[4];
    if (!m[1] && !ago) return null;
    var term = { op: ago ? '-' : '+', n: Number(m[2]), unit: enUnit(m[3]) };
    return relFromTerms(ctx, [term]);
  }
  // 中文:`3天前` / `2小时后`
  m = /^(\d+)\s*(天|小时|分钟|分|秒|周|星期|个月|年)(前|后)$/.exec(s);
  if (m) {
    term = { op: m[3] === '后' ? '+' : '-', n: Number(m[1]), unit: cnUnit(m[2]) };
    return relFromTerms(ctx, [term]);
  }
  // 短式链:`+1d -3h` / `+1d-3h` / `now +1d`
  var body = s.replace(/^(now|现在)\s*/, '');
  if (!body) return null;
  var flat = body.replace(/\s+/g, '');
  if (!/^([+-]\d+(?:mo|y|w|d|h|m|s))+$/.test(flat)) return null;
  var terms = [];
  var re = /[+-]\d+(?:mo|y|w|d|h|m|s)/g;
  var tm;
  while ((tm = re.exec(flat)) !== null) {
    var sign2 = tm[0][0] === '-' ? -1 : 1;
    var mm = /^[+-](\d+)(mo|y|w|d|h|m|s)$/.exec(tm[0]);
    terms.push({ op: sign2 > 0 ? '+' : '-', n: Number(mm[1]), unit: mm[2] });
  }
  if (!terms.length) return null;
  return relFromTerms(ctx, terms);
}

function enUnit(w) {
  if (/^sec|^s$/.test(w)) return 's';
  if (/^min|^m$/.test(w)) return 'm';
  if (/^h/.test(w)) return 'h';
  if (/^d/.test(w)) return 'd';
  if (/^w/.test(w)) return 'w';
  if (/^mo/.test(w)) return 'mo';
  return 'y';
}
function cnUnit(w) {
  if (w === '天') return 'd';
  if (w === '小时') return 'h';
  if (w === '分钟' || w === '分') return 'm';
  if (w === '秒') return 's';
  if (w === '周' || w === '星期') return 'w';
  if (w === '个月') return 'mo';
  return 'y';
}

/* 相对项求值:固定单位走 epoch 纳秒直算(确定性);日历月/年在 UTC 墙钟上进位并钳制月末 */
function relFromTerms(ctx, terms) {
  var p = makePoint(BigInt(Math.round(ctx.nowMs)) * 1000000n, 'ms', { kind: 'local' }, 'relative');
  try {
    return { point: addTerms(p, terms) };
  } catch (e) {
    return { err: (e && e.code) ? e : err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)') };
  }
}

/**
 * 相对表达求值:terms = [{op:'+'|'-', n:number, unit:'s'|'m'|'h'|'d'|'w'|'mo'|'y'}]
 * 固定单位按纳秒直算;月/年按日历进位(UTC 墙钟)并钳制月末(1月31日+1mo→2月29)。
 * @returns {TimePoint}
 */
function addTerms(base, terms) {
  var ns = base.epochNs;
  for (var i = 0; i < terms.length; i++) {
    var t = terms[i];
    var mul = t.op === '-' ? -1n : 1n;
    var n = BigInt(t.n);
    if (t.unit === 's') ns += mul * n * SEC_NS;
    else if (t.unit === 'm') ns += mul * n * 60n * SEC_NS;
    else if (t.unit === 'h') ns += mul * n * 3600n * SEC_NS;
    else if (t.unit === 'd') ns += mul * n * DAY_NS;
    else if (t.unit === 'w') ns += mul * n * 7n * DAY_NS;
    else {
      // 日历月/年:UTC 墙钟进位 + 月末钳制
      var wf = wallClock({ epochNs: ns, precision: base.precision, zone: base.zone }, { kind: 'utc' });
      var total = BigInt(wf.year * 12 + (wf.month - 1)) + mul * n * (t.unit === 'mo' ? 1n : 12n);
      var ny = Number(floorDiv(total, 12n));
      var nm = Number(floorMod(total, 12n)) + 1;
      var nd = Math.min(wf.day, daysInMonth(ny, nm));
      var wallNs2 = (BigInt(daysFromCivil(ny, nm, nd)) * 86400n
        + BigInt(wf.hour * 3600 + wf.minute * 60 + wf.second)) * SEC_NS
        + BigInt(wf.nano);
      ns = wallNs2; // UTC 墙钟即绝对时刻(偏移 0)
    }
  }
  if (ns > EPOCH_LIMITS.maxNs || ns < EPOCH_LIMITS.minNs) throw err('OUT_OF_RANGE', '超出可显示范围(年 1-9999)');
  return makePoint(ns, base.precision, base.zone, base.source || 'relative');
}

/* ── 责任链(优先级序) ── */

var PARSERS = [
  { id: 'unix', fn: function (s, ctx) { return parseUnixDecimal(s, ctx) || parseUnix(s, ctx); } },
  { id: 'compact', fn: parseCompact },
  { id: 'iso8601', fn: parseIso },
  { id: 'rfc2822', fn: parseRfc2822 },
  { id: 'slash', fn: parseSlash },
  { id: 'chinese', fn: parseChinese },
  { id: 'time-only', fn: parseTimeOnly },
  { id: 'relative', fn: parseRelative }
];

var PARSER_MAP = {};
PARSERS.forEach(function (p) { PARSER_MAP[p.id] = p.fn; });

/* ════════════════ 格式化层 ═══════════════════════════════════════ */

/* 精度 → ISO 小数位 */
function fracDigitsOf(prec) { return prec === 's' ? 0 : prec === 'ms' ? 3 : prec === 'us' ? 6 : 9; }
function fracStr(fields, prec) {
  var n = fracDigitsOf(prec);
  if (!n) return '';
  return '.' + pad(fields.nano, 9).slice(0, n);
}

function isoOf(fields, prec) {
  var base = pad4(fields.year) + '-' + pad2(fields.month) + '-' + pad2(fields.day)
    + 'T' + pad2(fields.hour) + ':' + pad2(fields.minute) + ':' + pad2(fields.second) + fracStr(fields, prec);
  return base;
}
function pad4(y) { return y < 1000 ? pad(y, 4) : String(y); }

/**
 * 全卡片渲染(UI 一次调用拿全部)。
 * @param {TimePoint} point
 * @param {FormatContext} [ctx] { template?:string, worldZones?:string[], humanNowMs?:number }
 * @returns {Array<FormatCard>} { id, title, value, mono, note?, rows?, error? }
 *   value 即 copyText,复制零加工;rows 用于多行卡(unix/世界时钟),行级独立复制。
 */
function formatAll(point, ctx) {
  ctx = ctx || {};
  var cards = [];
  // 1. Unix 时间戳(四行)
  var rows = [
    { label: '秒', value: (floorDiv(point.epochNs, SEC_NS)).toString() },
    { label: '毫秒', value: (floorDiv(point.epochNs, 1000000n)).toString() },
    { label: '微秒', value: (floorDiv(point.epochNs, 1000n)).toString() },
    { label: '纳秒', value: point.epochNs.toString() }
  ];
  var originIdx = { s: 0, ms: 1, us: 2, ns: 3 }[point.precision];
  rows[originIdx].origin = true;
  cards.push({ id: 'unix', title: 'Unix 时间戳', value: rows[0].value, mono: true, rows: rows,
    note: '输入精度:' + ({ s: '秒', ms: '毫秒', us: '微秒', ns: '纳秒' })[point.precision] });
  // 2/3. ISO(UTC / 本地)+ 4/5/6. 本地派生卡(每卡独立兜错,单卡越界不影响其余)
  var fu = safeWall(point, { kind: 'utc' });
  cards.push(fu
    ? { id: 'iso-utc', title: 'ISO 8601 (UTC)', value: isoOf(fu, point.precision) + 'Z', mono: true }
    : errCard('iso-utc', 'ISO 8601 (UTC)', true));
  var fl = safeWall(point, { kind: 'system' });
  cards.push(fl
    ? { id: 'iso-local', title: 'ISO 8601 (本地)', value: isoOf(fl, point.precision) + fmtOffset(fl.offsetMin), mono: true, note: fl.zoneLabel }
    : errCard('iso-local', 'ISO 8601 (本地)', true));
  cards.push(fl
    ? { id: 'local', title: '本地时间', mono: true, value: pad4(fl.year) + '-' + pad2(fl.month) + '-' + pad2(fl.day)
      + ' ' + pad2(fl.hour) + ':' + pad2(fl.minute) + ':' + pad2(fl.second) + fracStr(fl, point.precision) }
    : errCard('local', '本地时间', true));
  cards.push(fl
    ? { id: 'rfc2822', title: 'RFC 2822', mono: true, value: WEEKDAY_EN[fl.weekday] + ', ' + pad2(fl.day) + ' '
      + MONTH_EN[fl.month - 1] + ' ' + pad4(fl.year) + ' ' + pad2(fl.hour) + ':' + pad2(fl.minute) + ':' + pad2(fl.second)
      + ' ' + fmtOffsetCompact(fl.offsetMin) }
    : errCard('rfc2822', 'RFC 2822', true));
  var h12 = fl ? (fl.hour % 12 === 0 ? 12 : fl.hour % 12) : 0;
  cards.push(fl
    ? { id: 'chinese', title: '中文格式', mono: false, value: pad4(fl.year) + '年' + fl.month + '月' + fl.day + '日 星期'
      + WEEKDAY_CN[fl.weekday] + ' ' + (fl.hour < 12 ? '上午' : '下午') + ' ' + pad2(h12) + ':' + pad2(fl.minute) + ':' + pad2(fl.second) }
    : errCard('chinese', '中文格式', false));
  // 7. 相对时间
  var nowMs = ctx.humanNowMs === undefined ? Date.now() : ctx.humanNowMs;
  cards.push({ id: 'human', title: '相对时间', mono: false, value: humanize(point, nowMs) });
  // 8. 日历信息
  cards.push(fl
    ? { id: 'calendar', title: '日历信息', mono: false, value: '星期' + WEEKDAY_CN[fl.weekday] + ' · 年内第 ' + fl.dayOfYear
      + ' 天 · ISO 第 ' + fl.isoWeek + ' 周(' + fl.isoWeekYear + ' 年) · 第 ' + fl.quarter + ' 季度 · 距年底 '
      + (daysInYear(fl.year) - fl.dayOfYear) + ' 天' }
    : errCard('calendar', '日历信息', false));
  // 9. 世界时钟
  var zones = ctx.worldZones || WORLD_ZONES;
  var wrows = [];
  for (var i = 0; i < zones.length; i++) {
    var zname = zones[i];
    var zone = zname === 'UTC' ? { kind: 'utc' } : zname === '本地' ? { kind: 'system' } : { kind: 'iana', name: zname };
    var wz = safeWall(point, zone);
    if (wz) {
      wrows.push({ label: zname, value: pad4(wz.year) + '-' + pad2(wz.month) + '-' + pad2(wz.day) + ' '
        + pad2(wz.hour) + ':' + pad2(wz.minute) + ':' + pad2(wz.second) + ' ' + fmtOffset(wz.offsetMin) });
    }
  }
  cards.push({ id: 'worldclock', title: '世界时钟', mono: true, rows: wrows, value: wrows.length ? wrows[0].value : '' });
  // 10. 自定义模板
  var tpl = ctx.template === undefined || ctx.template === '' ? TEMPLATE_DEFAULT : ctx.template;
  var tplCard = { id: 'template', title: '自定义模板', mono: true, value: '', note: tpl };
  try {
    var ft = wallClock(point, { kind: 'system' });
    tplCard.value = renderTokens(tpl, ft);
  } catch (e) {
    tplCard.error = (e && e.code === 'BAD_TOKEN') ? e : err('BAD_TOKEN', '模板渲染失败');
  }
  cards.push(tplCard);
  return cards;
}

/* 单卡墙钟兜错:失败返回 null */
function safeWall(point, zone) {
  try { return wallClock(point, zone); } catch (e) { return null; }
}
function errCard(id, title, mono) {
  return { id: id, title: title, value: '', mono: mono, error: err('OUT_OF_RANGE', '该时刻在此时区不可显示(年 1-9999)') };
}

/** 单卡片渲染(formatAll 元素级访问;id 与 FORMAT_IDS 一致) @returns {string} */
function formatBy(point, id, ctx) {
  ctx = ctx || {};
  var cards = formatAll(point, {
    template: ctx.template !== undefined ? ctx.template : undefined,
    worldZones: ctx.worldZones || (id === 'worldclock' ? ['UTC'] : undefined),
    humanNowMs: ctx.humanNowMs
  });
  for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i].value;
  throw err('UNRECOGNIZED', '未知输出格式 ' + id);
}

/**
 * token 模板渲染(解释器)。
 * @param {string} template
 * @param {WallFields} fields
 * @throws {EngineError} BAD_TOKEN {token, position}
 */
function renderTokens(template, fields) {
  var out = '';
  var i = 0;
  var t = String(template);
  while (i < t.length) {
    var c = t[i];
    if (c === '[') {
      var end = t.indexOf(']', i);
      if (end < 0) { out += t.slice(i + 1); break; }
      out += t.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === 'S') {
      var j = i;
      while (j < t.length && t[j] === 'S') j++;
      var n = j - i;
      if (n > 9) throw badToken('S…(' + n + ' 位)', i, '亚秒最多 9 位 S');
      out += pad(fields.nano, 9).slice(0, n);
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      var tok = matchToken(t, i);
      if (!tok) throw (function () { var e = err('BAD_TOKEN', '未知 token「' + c + '」——点帮助查看 token 表'); e.token = c; e.position = i; return e; })();
      out += tokenValue(tok, fields);
      i += tok.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function badToken(tok, pos, msg) {
  var e = err('BAD_TOKEN', msg || ('未知 token「' + tok + '」——点帮助查看 token 表'));
  e.token = tok;
  e.position = pos;
  return e;
}

/* 最长优先匹配 token */
var TOKEN_SORTED = ['YYYY', 'DDDD', 'dddd', 'SSSSSSSSS', 'SSSSSSSS', 'SSSSSSS', 'SSSSSS', 'SSSSS', 'SSSS', 'SSS',
  'SS', 'DDD', 'ddd', 'ZZ', 'YY', 'QQ', 'ww', 'MM', 'DD', 'HH', 'hh', 'mm', 'ss', 'E', 'DD', 'dd', 'Z', 'Q', 'w',
  'M', 'D', 'H', 'h', 'm', 's', 'A', 'a', 'd', 'z'];

function matchToken(t, i) {
  for (var k = 0; k < TOKEN_SORTED.length; k++) {
    var tok = TOKEN_SORTED[k];
    if (t.startsWith(tok, i)) return tok;
  }
  return null;
}

function tokenValue(tok, f) {
  switch (tok) {
    case 'YYYY': return pad4(f.year);
    case 'YY': return pad2(f.year % 100);
    case 'MM': return pad2(f.month);
    case 'M': return String(f.month);
    case 'DD': return pad2(f.day);
    case 'D': return String(f.day);
    case 'HH': return pad2(f.hour);
    case 'H': return String(f.hour);
    case 'hh': return pad2(f.hour % 12 === 0 ? 12 : f.hour % 12);
    case 'h': return String(f.hour % 12 === 0 ? 12 : f.hour % 12);
    case 'mm': return pad2(f.minute);
    case 'm': return String(f.minute);
    case 'ss': return pad2(f.second);
    case 's': return String(f.second);
    case 'A': return f.hour < 12 ? '上午' : '下午';
    case 'a': return f.hour < 12 ? 'am' : 'pm';
    case 'd': return String(f.weekday);
    case 'dd': case 'ddd': return '周' + WEEKDAY_CN[f.weekday];
    case 'dddd': return '星期' + WEEKDAY_CN[f.weekday];
    case 'E': return String(f.isoWeekday);
    case 'DDD': return String(f.dayOfYear);
    case 'DDDD': return pad(f.dayOfYear, 4);
    case 'w': return String(f.isoWeek);
    case 'ww': return pad2(f.isoWeek);
    case 'Q': return String(f.quarter);
    case 'QQ': return 'Q' + f.quarter;
    case 'Z': return fmtOffset(f.offsetMin);
    case 'ZZ': return fmtOffsetCompact(f.offsetMin);
    case 'z': return f.zoneLabel;
    default: throw badToken(tok, 0);
  }
}

/** 人性化描述:'刚刚'/'3 天前'/'2 小时后' */
function humanize(point, nowMs) {
  var diffSec = Number(floorDiv(point.epochNs - BigInt(Math.round(nowMs)) * 1000000n, SEC_NS));
  var abs = Math.abs(diffSec);
  var suffix = diffSec >= 0 ? '后' : '前';
  if (abs < 10) return '刚刚';
  if (abs < 60) return Math.round(abs) + ' 秒' + suffix;
  if (abs < 3600) return Math.max(1, Math.round(abs / 60)) + ' 分钟' + suffix;
  if (abs < 86400) return Math.max(1, Math.round(abs / 3600)) + ' 小时' + suffix;
  if (abs < 86400 * 30) return Math.max(1, Math.round(abs / 86400)) + ' 天' + suffix;
  if (abs < 86400 * 365) return Math.max(1, Math.round(abs / (86400 * 30))) + ' 个月' + suffix;
  return Math.max(1, Math.round(abs / (86400 * 365))) + ' 年' + suffix;
}

/* ── API 汇出 ── */

var api = {
  version: version,
  PARSE_IDS: PARSE_IDS,
  FORMAT_IDS: FORMAT_IDS,
  SOURCE_LABELS: SOURCE_LABELS,
  TOKENS: TOKENS,
  REL_UNITS: REL_UNITS,
  RFC2822_ZONES: RFC2822_ZONES,
  WORLD_ZONES: WORLD_ZONES,
  EPOCH_LIMITS: EPOCH_LIMITS,
  TEMPLATE_DEFAULT: TEMPLATE_DEFAULT,
  parseTime: parseTime,
  parseAs: parseAs,
  addTerms: addTerms,
  formatAll: formatAll,
  formatBy: formatBy,
  renderTokens: renderTokens,
  humanize: humanize,
  wallClock: wallClock,
  fromWallClock: fromWallClock,
  validateFields: validateFields
};

return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TimeEngine;