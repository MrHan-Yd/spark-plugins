/* 时间转换 · engine 对拍测试(node 直跑,不进发布物)
 * 用例组:G1 位数路由 / G2 ISO / G3 RFC2822 / G4 中文紧凑时刻 / G5 相对
 *        G6 DST 自洽 / G7 精度与边界 / G8 Token / G9 随机对拍 / G10 错误契约
 * 约束:相对时间一律注入 nowMs 定值;本地时区断言只做自洽;DST 走 worldclock 行自洽。
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const T = require('../0.1.0/engine.js');

let n = 0;
let group = '';
function ok(cond, msg) { n++; if (!cond) throw new Error('[' + group + '] ' + msg); }
function eq(a, b, msg) { n++; assert.strictEqual(a, b, '[' + group + '] ' + msg); }

// 2025-06-15T15:06:40Z(年中,避开年末/月末边界)
const FIXED_NOW = 1750000000000;
const UTC = { nowMs: FIXED_NOW, zoneFallback: 'utc' };

/* ════════ G1 时间戳位数路由 ════════ */
group = 'G1';
let r = T.parseTime('1700000000');
ok(r.ok, '10 位秒戳可解析');
eq(r.point.source, 'unix-s', 'source 标记 unix-s');
eq(r.point.precision, 's', '10 位 → 精度秒');
eq(r.point.epochNs, 1700000000n * 1000000000n, '10 位 epochNs');
eq(T.formatBy(r.point, 'iso-utc'), '2023-11-14T22:13:20Z', '10 位 iso-utc');

eq(T.parseTime('1700000000123').point.precision, 'ms', '13 位 → 毫秒');
eq(T.formatBy(T.parseTime('1700000000123').point, 'iso-utc'), '2023-11-14T22:13:20.123Z', '13 位 iso');
eq(T.parseTime('1700000000123456').point.precision, 'us', '16 位 → 微秒');
eq(T.formatBy(T.parseTime('1700000000123456').point, 'iso-utc'), '2023-11-14T22:13:20.123456Z', '16 位 iso');
eq(T.parseTime('1700000000123456789').point.precision, 'ns', '19 位 → 纳秒');
eq(T.formatBy(T.parseTime('1700000000123456789').point, 'iso-utc'), '2023-11-14T22:13:20.123456789Z', '19 位 iso');

eq(T.formatBy(T.parseTime('0').point, 'iso-utc'), '1970-01-01T00:00:00Z', '0 → 纪元');
r = T.parseTime('-1700000000');
ok(r.ok, '负秒戳可解析');
eq(T.formatBy(r.point, 'iso-utc'), '1916-02-18T01:46:40Z', '负秒戳 iso');
r = T.parseTime('+1700000000');
ok(r.ok, '显式 + 可解析');

r = T.parseTime('17000000001');
ok(!r.ok && r.error.code === 'AMBIGUOUS', '11 位 → AMBIGUOUS');
r = T.parseTime('170000000012');
ok(!r.ok && r.error.code === 'AMBIGUOUS', '12 位 → AMBIGUOUS');
ok(/10 或 13/.test(r.error.message), '11-12 位错误文案');

r = T.parseTime('1700000000.123456');
ok(r.ok && r.point.precision === 'ns', '带小数秒 → 纳秒精度');
eq(T.formatBy(r.point, 'iso-utc'), '2023-11-14T22:13:20.123456000Z', '小数秒 iso(纳秒精度 9 位)');
r = T.parseTime('1700000000.1234567890');
ok(!r.ok, '超过 9 位小数拒绝');

r = T.parseTime('１７００００００００');
ok(r.ok && r.point.epochNs === 1700000000n * 1000000000n, '全角数字归一化');

r = T.parseTime('170000000');  // 9 位
ok(!r.ok && r.error.code === 'UNRECOGNIZED', '9 位不猜');
r = T.parseTime('170000000012345');  // 15 位
ok(!r.ok && r.error.code === 'UNRECOGNIZED', '15 位不猜');
r = T.parseTime('1.7e9');
ok(!r.ok, '科学计数法拒绝');

/* ════════ G2 ISO 8601 / RFC 3339 ════════ */
group = 'G2';
r = T.parseTime('2024-01-01T12:30:45Z');
ok(r.ok, 'ISO Z 形态');
eq(r.point.epochNs, 1704112245000000000n, 'ISO Z epochNs');
eq(r.point.source, 'iso8601', 'ISO source');

eq(T.formatBy(T.parseTime('2024-01-01 12:30:45+08:00').point, 'iso-utc'), '2024-01-01T04:30:45Z', '空格分隔 +08:00');
eq(T.formatBy(T.parseTime('2024-01-01T12:30:45+0800').point, 'iso-utc'), '2024-01-01T04:30:45Z', '+0800');
eq(T.formatBy(T.parseTime('2024-01-01T12:30:45+08').point, 'iso-utc'), '2024-01-01T04:30:45Z', '+08');
eq(T.formatBy(T.parseTime('2024-1-1T9:05:07Z').point, 'iso-utc'), '2024-01-01T09:05:07Z', '单位数字段');
eq(T.formatBy(T.parseTime('2024-01-01', UTC).point, 'iso-utc'), '2024-01-01T00:00:00Z', '仅日期 → 零点');
eq(T.formatBy(T.parseTime('2024-01', UTC).point, 'iso-utc'), '2024-01-01T00:00:00Z', '年-月 → 1 日零点');
eq(T.parseTime('2024-01-01t12:30:45z').point.epochNs, 1704112245000000000n, '小写 t/z');
eq(T.parseTime('2024-01-01T12:30:45,5Z').point.epochNs, 1704112245500000000n, '逗号小数');

eq(T.parseTime('2024-02-29T00:00:00Z').point.epochNs, 1709164800000000000n, '闰日 2024 合法');
r = T.parseTime('2023-02-29T00:00:00Z');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '2023-02-29 拒');
r = T.parseTime('2024-02-30T00:00:00Z');
ok(!r.ok && /2 月只有 29 天/.test(r.error.message), '2024-02-30 文案');
r = T.parseTime('2024-13-01T00:00:00Z');
ok(!r.ok && /1-12/.test(r.error.message), '13 月拒');
r = T.parseTime('2024-01-01T25:00:00Z');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '25 时拒');
r = T.parseTime('2024-01-01T12:60:00Z');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '60 分拒');
r = T.parseTime('2024-01-01T12:30:45+14:30');
ok(!r.ok, '+14:30 拒');

r = T.parseTime('2024-01-01T12:30:45.123456789Z');
eq(r.point.precision, 'ns', '9 位小数 → 纳秒');
r = T.parseTime('2024-01-01T12:30:45.5Z');
eq(r.point.precision, 'ms', '1 位小数 → 毫秒精度');
eq(T.formatBy(r.point, 'iso-utc'), '2024-01-01T12:30:45.500Z', '补零 3 位');

// zoneFallback 两分支
r = T.parseTime('2024-01-01 12:30:45', UTC);
eq(r.point.epochNs, 1704112245000000000n, '无时区按 UTC 解释');
r = T.parseTime('2024-01-01 12:30:45', { nowMs: FIXED_NOW, zoneFallback: 'local' });
let lf = T.wallClock(r.point, { kind: 'system' });
eq(lf.year + '-' + lf.month + '-' + lf.day + ' ' + lf.hour + ':' + lf.minute + ':' + lf.second,
  '2024-1-1 12:30:45', '无时区按本地解释(回读自洽)');

/* ════════ G3 RFC 2822 ════════ */
group = 'G3';
r = T.parseTime('Mon, 15 Sep 2026 16:30:00 +0800');
ok(r.ok && r.point.source === 'rfc2822', 'RFC 2822 全形态');
eq(r.point.epochNs, 1789461000000000000n, 'RFC 2822 epochNs');
eq(T.parseTime('15 Sep 2026 16:30:00 +0800').point.epochNs, 1789461000000000000n, '省略星期');
eq(T.parseTime('15 Sep 26 16:30:00 +0800', UTC).point.epochNs, 1789461000000000000n, '两位年份 pivot 68');
eq(T.parseTime('15 sep 2026 16:30:00 +0800').point.epochNs, 1789461000000000000n, '小写月份');
eq(T.parseTime('Mon, 15 Sep 2026 16:30:00 GMT').point.epochNs, 1789489800000000000n, 'GMT');
eq(T.parseTime('15 Sep 2026 16:30:00 GMT').point.epochNs, 1789489800000000000n, 'GMT 无星期');
// 老时区名固定偏移表
eq(T.parseTime('1 Jan 2024 00:00:00 PST').point.epochNs, 1704096000000000000n, 'PST -08:00');
eq(T.parseTime('1 Jan 2024 00:00:00 CST').point.epochNs, 1704088800000000000n, 'CST 按美中 -06:00');
eq(T.parseTime('1 Jan 2024 00:00:00 EDT').point.epochNs, 1704081600000000000n, 'EDT -04:00');
r = T.parseTime('15 Sep 2026 16:30:00 XYZ');
ok(!r.ok, '未知时区名拒');
r = T.parseTime('15 Sep 2026 16:30');
ok(r.ok, '无秒可解析');
r = T.parseTime('25 Sep 2026 99:00 +0800');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '99 时拒');

/* ════════ G4 中文 / 紧凑 / 时刻 ════════ */
group = 'G4';
r = T.parseTime('2024年1月1日', UTC);
ok(r.ok && r.point.source === 'chinese', '中文日期');
eq(r.point.epochNs, 1704067200000000000n, '中文日期零点(UTC)');
eq(T.parseTime('2024年01月01日 12时30分25秒', UTC).point.epochNs, 1704112225000000000n, '中文日期时间');
eq(T.parseTime('2024年1月', UTC).point.epochNs, 1704067200000000000n, '年月 → 1 日');
eq(T.parseTime('2024年', UTC).point.epochNs, 1704067200000000000n, '年仅 → 1 月 1 日');

const LOC = { nowMs: FIXED_NOW, zoneFallback: 'local' };
r = T.parseTime('1月1日', LOC);
lf = T.wallClock(r.point, { kind: 'system' });
eq(r.point.source, 'chinese', '1月1日 source');
eq(lf.month + '/' + lf.day, '1/1', '1月1日 当年补全(本地年)');
eq(lf.hour, 0, '1月1日 零点(本地解释)');

r = T.parseTime('12时30分', LOC);
lf = T.wallClock(r.point, { kind: 'system' });
eq(lf.hour + ':' + lf.minute, '12:30', '12时30分 今天补全(本地解释)');
eq(r.point.source, 'chinese', '中文时刻 source');

eq(T.parseTime('20240101', UTC).point.epochNs, 1704067200000000000n, '紧凑 8 位');
eq(T.parseTime('20240101123025', UTC).point.epochNs, 1704112225000000000n, '紧凑 14 位');
r = T.parseTime('010203');
ok(!r.ok && r.error.code === 'AMBIGUOUS', '6 位以内拒绝');
ok(/20250103/.test(r.error.message), '紧凑过短提示');
r = T.parseTime('20240230');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '紧凑无效日期');

eq(T.parseTime('12:30', UTC).point.source, 'time-only', '时刻解析器');
r = T.parseTime('12:30:45.123', UTC);
eq(r.point.precision, 'ms', '时刻毫秒精度');
lf = T.wallClock(r.point, { kind: 'system' });
eq(lf.hour + ':' + lf.minute + ':' + lf.second, '12:30:45', '时刻字段');
r = T.parseTime('2024年13月1日');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '中文 13 月拒');
r = T.parseTime('2024年1月32日');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '中文 32 日拒');
r = T.parseTime('2024年1月1日 25时');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '中文 25 时拒');

/* ════════ G5 相对表达 ════════ */
group = 'G5';
r = T.parseTime('now', UTC);
eq(r.point.epochNs, 1750000000000n * 1000000n, 'now = nowMs');
eq(r.point.source, 'relative', 'relative source');
r = T.parseTime('现在', UTC);
eq(r.point.epochNs, 1750000000000n * 1000000n, '现在 = now');
r = T.parseTime('刚刚', UTC);
eq(r.point.epochNs, 1750000000000n * 1000000n, '刚刚 = now');

eq(T.parseTime('+1d', UTC).point.epochNs, (BigInt(FIXED_NOW + 86400000) * 1000000n), '+1d');
eq(T.parseTime('-3h', UTC).point.epochNs, (BigInt(FIXED_NOW - 10800000) * 1000000n), '-3h');
eq(T.parseTime('+30m', UTC).point.epochNs, (BigInt(FIXED_NOW + 1800000) * 1000000n), '+30m');
eq(T.parseTime('+10s', UTC).point.epochNs, (BigInt(FIXED_NOW + 10000) * 1000000n), '+10s');
eq(T.parseTime('+2w', UTC).point.epochNs, (BigInt(FIXED_NOW + 14 * 86400000) * 1000000n), '+2w');
eq(T.parseTime('+1d -3h', UTC).point.epochNs, (BigInt(FIXED_NOW + 86400000 - 10800000) * 1000000n), '+1d -3h 链');
eq(T.parseTime('now+1d-3h', UTC).point.epochNs, (BigInt(FIXED_NOW + 86400000 - 10800000) * 1000000n), 'now+1d-3h 连写');
eq(T.parseTime('+6mo', UTC).point.epochNs, 1765811200000000000n, '+6mo UTC 日历进位'); // 2025-12-15T15:06:40Z
eq(T.parseTime('+1y', UTC).point.epochNs, T.parseTime('2026-06-15T15:06:40Z').point.epochNs, '+1y');

// 日历进位 + 月末钳制(直接构造 base,确定性)
const jan31 = T.parseAs('iso8601', '2024-01-31T12:00:00Z');
const feb29 = T.addTerms(jan31, [{ op: '+', n: 1, unit: 'mo' }]);
let wcf = T.wallClock(feb29, { kind: 'utc' });
eq(wcf.year + '-' + wcf.month + '-' + wcf.day, '2024-2-29', '1月31日+1mo → 2月29');
const jan31b = T.addTerms(T.parseAs('iso8601', '2023-01-31T00:00:00Z'), [{ op: '+', n: 1, unit: 'mo' }]);
wcf = T.wallClock(jan31b, { kind: 'utc' });
eq(wcf.year + '-' + wcf.month + '-' + wcf.day, '2023-2-28', '平年钳制 2-28');
const dec31 = T.addTerms(T.parseAs('iso8601', '2024-12-31T12:00:00Z'), [{ op: '+', n: 1, unit: 'y' }]);
wcf = T.wallClock(dec31, { kind: 'utc' });
eq(wcf.year + '-' + wcf.month + '-' + wcf.day, '2025-12-31', '跨年钳制');

// 英文长式 / 中文前后
eq(T.parseTime('in 2 hours', UTC).point.epochNs, (BigInt(FIXED_NOW + 7200000) * 1000000n), 'in 2 hours');
eq(T.parseTime('2 hours ago', UTC).point.epochNs, (BigInt(FIXED_NOW - 7200000) * 1000000n), '2 hours ago');
eq(T.parseTime('1d ago', UTC).point.epochNs, (BigInt(FIXED_NOW - 86400000) * 1000000n), '1d ago');
eq(T.parseTime('3天前', UTC).point.epochNs, (BigInt(FIXED_NOW - 3 * 86400000) * 1000000n), '3天前');
eq(T.parseTime('2小时后', UTC).point.epochNs, (BigInt(FIXED_NOW + 7200000) * 1000000n), '2小时后');

// 关键词日期词:与独立构造的"本地零点"互证(TZ 无关)
const basePt = T.parseTime('now', UTC).point;
const bf = T.wallClock(basePt, { kind: 'system' });
function localMidnight(y, m, d) {
  return T.fromWallClock({ y: y, m: m, d: d, h: 0, mi: 0, s: 0, ns: 0 }, { kind: 'system' });
}
const todayMid = localMidnight(bf.year, bf.month, bf.day);
r = T.parseTime('明天', UTC);
ok(r.ok, '明天可解析');
eq(r.point.epochNs, todayMid.epochNs + 86400000000000n, '明天 = 本地今天 00:00 + 1 天');
lf = T.wallClock(r.point, { kind: 'system' });
eq(lf.hour * 3600 + lf.minute * 60 + lf.second, 0, '明天取 00:00');
r = T.parseTime('昨天', UTC);
eq(r.point.epochNs, todayMid.epochNs - 86400000000000n, '昨天 = -1 天 00:00');
r = T.parseTime('上周', UTC);
eq(r.point.epochNs, todayMid.epochNs - 7n * 86400000000000n, '上周 = -7 天 00:00');
r = T.parseTime('上个月', UTC);
lf = T.wallClock(r.point, { kind: 'system' });
eq(lf.year + '/' + lf.month, '2025/5', '上个月 = 5 月(6-1)');
eq(lf.hour, 0, '上个月取 00:00');
r = T.parseTime('明年', UTC);
lf = T.wallClock(r.point, { kind: 'system' });
eq(lf.year, bf.year + 1, '明年 = +1 年');

/* ════════ G6 DST 自洽(仅断言 IANA 行,不依赖机器本地时区) ════════ */
group = 'G6';
function nyRow(iso) {
  const pt = T.parseTime(iso).point;
  const card = T.formatAll(pt, { worldZones: ['America/New_York'] }).find(c => c.id === 'worldclock');
  return card.rows[0].value;
}
eq(nyRow('2024-03-10T06:30:00Z'), '2024-03-10 01:30:00 -05:00', '春季 gap 前 EST');
eq(nyRow('2024-03-10T07:30:00Z'), '2024-03-10 03:30:00 -04:00', '春季 gap 跳过 02:30');
eq(nyRow('2024-11-03T05:30:00Z'), '2024-11-03 01:30:00 -04:00', '秋季重叠第一次 EDT');
eq(nyRow('2024-11-03T06:30:00Z'), '2024-11-03 01:30:00 -05:00', '秋季重叠第二次 EST');
ok(nyRow('2024-06-15T12:00:00Z').endsWith('-04:00'), '夏季 EDT');
ok(nyRow('2024-01-15T12:00:00Z').endsWith('-05:00'), '冬季 EST');
function utcRow(iso) {
  const pt = T.parseTime(iso).point;
  return T.formatAll(pt).find(c => c.id === 'worldclock').rows.find(x => x.label === 'UTC').value;
}
ok(utcRow('2024-03-10T06:30:00Z').endsWith('+00:00'), 'UTC 行偏移');

/* ════════ G7 精度与 BigInt 边界 ════════ */
group = 'G7';
r = T.parseTime('1700000000123456789');
eq(T.parseTime(T.formatBy(r.point, 'iso-utc')).point.epochNs, r.point.epochNs, '19 位纳秒 iso 往返恒等');
eq(T.formatBy(r.point, 'unix'), '1700000000', 'unix 主行 = 秒');
const cards = T.formatAll(r.point);
eq(cards.find(c => c.id === 'unix').rows[3].value, '1700000000123456789', '纳秒行逐位一致');
eq(cards.length, 10, '输出 10 张卡');
eq(cards.map(c => c.id).join(','), T.FORMAT_IDS.join(','), '卡片顺序与 FORMAT_IDS 一致');
ok(cards.find(c => c.id === 'unix').rows.some(x => x.origin), '原始精度行打标');

eq(T.formatBy(T.parseTime('0001-01-01T00:00:00Z').point, 'iso-utc'), '0001-01-01T00:00:00Z', '年 1 下界');
eq(T.formatBy(T.parseTime('9999-12-31T23:59:59.999999999Z').point, 'iso-utc'), '9999-12-31T23:59:59.999999999Z', '年 9999 上界');
r = T.parseTime('0000-01-01T00:00:00Z');
ok(!r.ok, '年 0 拒绝');
// 超界 → OUT_OF_RANGE(addTerms 溢出)
{
  // +1s 推出年 10000 → 越界
  const near = T.parseAs('iso8601', '9999-12-31T23:59:59.999999999Z');
  let threw = false;
  try { T.addTerms(near, [{ op: '+', n: 1, unit: 's' }]); } catch (e) { threw = e.code === 'OUT_OF_RANGE'; }
  ok(threw, '超出年 9999 → OUT_OF_RANGE');
}
// 单卡兜错:本地不可显示时仅该卡报错,UTC 卡正常
{
  const cards2 = T.formatAll(T.parseTime('0001-01-01T00:00:00Z').point);
  ok(cards2.find(c => c.id === 'iso-utc') && !cards2.find(c => c.id === 'iso-utc').error, '年 1 UTC 卡正常');
  const loc = cards2.find(c => c.id === 'local');
  ok(loc && (loc.error || loc.value), '年 1 本地卡兜错不炸');
}

/* ════════ G8 Token 渲染 ════════ */
group = 'G8';
const f2024 = T.wallClock(T.parseTime('2024-03-05T07:08:09.123456789Z').point, { kind: 'utc' });
eq(T.renderTokens('YYYY-MM-DD HH:mm:ss', f2024), '2024-03-05 07:08:09', '基础模板');
eq(T.renderTokens('YY|M|D|H|m|s', f2024), '24|3|5|7|8|9', '单字符 token');
eq(T.renderTokens('hh A a', f2024), '07 上午 am', '12 时制');
eq(T.renderTokens('SSS', f2024), '123', 'S3');
eq(T.renderTokens('SSSSSS', f2024), '123456', 'S6');
eq(T.renderTokens('SSSSSSSSS', f2024), '123456789', 'S9');
eq(T.renderTokens('S', f2024), '1', 'S1');
eq(T.renderTokens('dddd dd d E', f2024), '星期二 周二 2 2', '星期组');
eq(T.renderTokens('DDD DDDD', f2024), '65 0065', '年内天');
eq(T.renderTokens('w ww', f2024), '10 10', 'ISO 周');
eq(T.renderTokens('Q QQ', f2024), '1 Q1', '季度');
let f08 = Object.assign({}, f2024, { offsetMin: 480, zoneLabel: 'Asia/Shanghai' });
eq(T.renderTokens('Z|ZZ|z', f08), '+08:00|+0800|Asia/Shanghai', '时区组');
f08 = Object.assign({}, f2024, { offsetMin: 0, zoneLabel: 'UTC' });
eq(T.renderTokens('Z|ZZ|z', f08), '+00:00|+0000|UTC', 'UTC 时区组');
eq(T.renderTokens('[HH:mm] YYYY', f2024), 'HH:mm 2024', '方括号转义');
assert.throws(() => T.renderTokens('YYYY-X', f2024), e => e.code === 'BAD_TOKEN', '未知 token 抛 BAD_TOKEN');
let be;
try { T.renderTokens('V', f2024); } catch (e) { be = e; }
ok(be && be.code === 'BAD_TOKEN' && be.token === 'V', 'BAD_TOKEN 带 token 字段');
// token 表完整(帮助面板数据源)
ok(Array.isArray(T.TOKENS) && T.TOKENS.length >= 30, 'token 表 ≥30 项');
ok(T.TOKENS.every(t => t.token && t.sample && t.desc), 'token 表字段齐全');

/* ════════ G9 随机对拍(300 × 2) ════════ */
group = 'G9';
let seed = 20260915;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483647; }
for (let i = 0; i < 300; i++) {
  const mag = 1000000000000 + Math.floor(rnd() * 9000000000000); // 13 位毫秒域
  const ms = (i % 4 === 3 ? -1 : 1) * mag; // 含负值戳
  const rp = T.parseTime(String(ms));
  ok(rp.ok && rp.point.epochNs === BigInt(ms) * 1000000n, '随机 ms 戳解析恒等 #' + i);
  const iso = T.formatBy(rp.point, 'iso-utc');
  const rp2 = T.parseTime(iso);
  ok(rp2.ok && rp2.point.epochNs === rp.point.epochNs, 'iso 往返恒等 #' + i);
}

/* ════════ G10 错误契约 ════════ */
group = 'G10';
r = T.parseTime('');
ok(!r.ok && r.error.code === 'EMPTY', 'EMPTY');
r = T.parseTime('   ');
ok(!r.ok && r.error.code === 'EMPTY', '空白 → EMPTY');
r = T.parseTime('hello');
ok(!r.ok && r.error.code === 'UNRECOGNIZED' && r.error.hint, 'UNRECOGNIZED 带 hint');
r = T.parseTime('17000000001');
ok(!r.ok && r.error.code === 'AMBIGUOUS', 'AMBIGUOUS(11 位)');
r = T.parseTime('2024-02-30');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', 'INVALID_FIELDS');
r = T.parseTime('2100-02-29');
ok(!r.ok && r.error.code === 'INVALID_FIELDS', '2100-02-29 拒(百年不闰)');
r = T.parseTime('2024-02-29T23:59:60Z');
ok(!r.ok, '闰秒 23:59:60 拒');
r = T.parseTime('2024-01-01T12:00:00+15:00');
ok(!r.ok, '+15:00 偏移拒');
// OUT_OF_RANGE(相对溢出)
r = T.parseTime('now+999999y', UTC);
ok(!r.ok && r.error.code === 'OUT_OF_RANGE', '相对溢出 → OUT_OF_RANGE');
// parseAs 定向解析
eq(T.parseAs('iso8601', '2024-01-01T00:00:00Z').epochNs, 1704067200000000000n, 'parseAs 定向');
ok(T.parseAs('iso8601', 'hello') === null, 'parseAs 失败 → null');
ok(T.parseAs('bogus-id', '2024-01-01') === null, 'parseAs 未知 id → null');
// humanize(注入 now)
eq(T.humanize(T.parseTime('now', UTC).point, FIXED_NOW), '刚刚', 'humanize 刚刚');
eq(T.humanize(T.addTerms(T.parseTime('now', UTC).point, [{ op: '-', n: 3, unit: 'd' }]), FIXED_NOW), '3 天前', 'humanize 3 天前');
eq(T.humanize(T.addTerms(T.parseTime('now', UTC).point, [{ op: '+', n: 2, unit: 'h' }]), FIXED_NOW), '2 小时后', 'humanize 2 小时后');
// 常量导出完整
ok(T.PARSE_IDS.length === 8 && T.FORMAT_IDS.length === 10, '解析器/格式数量');
ok(T.SOURCE_LABELS['unix-ms'] === 'Unix 毫秒', 'SOURCE_LABELS');
ok(T.RFC2822_ZONES.CST === -360, 'CST = 美中 -360 钉死');
ok(T.EPOCH_LIMITS.minNs === -62135596800000000000n && T.EPOCH_LIMITS.maxNs === 253402300799999999999n, 'EPOCH_LIMITS');
ok(typeof T.version === 'string', 'version');

console.log('✅ 全部 ' + n + ' 断言通过(G1-G10)');