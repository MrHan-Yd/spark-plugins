// 校验 0.2.0/index.html：1) 全量 JS 语法检查 2) MD5 对拍 node:crypto 3) diff 引擎一致性
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const html = readFileSync(new URL("../compare/0.1.0/index.html", import.meta.url), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("no <script> found"); process.exit(1); }
const js = m[1];

// 1) 语法检查
try {
  new Function(js);
  console.log("[1] JS syntax OK, script length =", js.length);
} catch (e) {
  console.error("[1] SYNTAX ERROR:", e.message);
  const lineMatch = e.stack?.match(/<anonymous>:(\d+)/);
  if (lineMatch) {
    const ln = Number(lineMatch[1]);
    console.error("near line", ln, ":", js.split("\n").slice(ln - 3, ln + 2).join("\n"));
  }
  process.exit(1);
}

// 2) 提取 MD5 段并在 node 中对拍
const md5Src = js.split("/* __MD5_BEGIN__ */")[1].split("/* __MD5_END__ */")[0];
const md5Mod = new Function(md5Src + "; return { md5New, md5Update, md5Hex };")();
const { md5New, md5Update, md5Hex } = md5Mod;

function ref(u8) { return createHash("md5").update(u8).digest("hex"); }

let fail = 0;
const vectors = [
  [""],
  ["abc"],
  ["The quick brown fox jumps over the lazy dog"],
  ["a".repeat(63)], ["a".repeat(64)], ["a".repeat(65)], ["a".repeat(128)], ["a".repeat(1000)],
  [Buffer.from("中文内容测试🚀 emojis ✓")],
];
for (const [data] of vectors) {
  const u8 = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const st = md5New();
  // 随机分块喂入，验证增量正确性
  let off = 0;
  while (off < u8.length) {
    const step = Math.min(1 + (u8.length + off) % 37, u8.length - off);
    md5Update(st, u8.subarray(off, off + step));
    off += step;
  }
  const got = md5Hex(st);
  const want = ref(u8);
  if (got !== want) { console.error("[2] MD5 MISMATCH:", JSON.stringify(String(data).slice(0, 30)), "got", got, "want", want); fail++; }
}
// 大随机块
const big = Buffer.alloc(5 * 1024 * 1024 + 13);
for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 255;
{
  const st = md5New();
  for (let off = 0; off < big.length; off += 1024 * 1024) md5Update(st, big.subarray(off, Math.min(big.length, off + 1024 * 1024)));
  const got = md5Hex(st);
  if (got !== ref(big)) { console.error("[2] MD5 big-block mismatch"); fail++; }
}
console.log(fail === 0 ? "[2] MD5 vs node:crypto: ALL PASS (" + (vectors.length + 1) + " cases)" : "[2] MD5 FAILED x" + fail);

// 3) diff 引擎一致性：ops 可重建原文、状态数组全覆盖、blocks 与状态吻合
const engSrc = js.split("/* __ENGINE_BEGIN__ */")[1].split("/* __ENGINE_END__ */")[0];
const eng = new Function(engSrc + "; return { computeDiff, splitLines, myersOps, normalizeOps, wordDiff };")();
const performance = { now: () => Date.now() };
// WORD_BUDGET / WORD_MAX_LEN 已移入引擎段内（worker 只加载引擎段），无需再注入
const ctx = new Function("performance", engSrc + "; return computeDiff;")(performance);

function rndText(rng, maxLines) {
  const words = ["foo", "bar", "baz", "中文", "测试", "  x", "hello", "world", "123", "", "const a = 1;", "}"];
  const n = 1 + Math.floor(rng() * maxLines);
  const lines = [];
  for (let i = 0; i < n; i++) {
    let l = "";
    const w = Math.floor(rng() * 5);
    for (let j = 0; j < w; j++) l += (j ? " " : "") + words[Math.floor(rng() * words.length)];
    lines.push(l);
  }
  return lines.join("\n");
}
function mutate(rng, text) {
  const lines = text.split("\n");
  const ops = 1 + Math.floor(rng() * 6);
  for (let k = 0; k < ops; k++) {
    const t = rng();
    const i = Math.floor(rng() * lines.length);
    if (t < 0.35) lines.splice(i, 1);
    else if (t < 0.7) lines.splice(i, 0, "ins" + Math.floor(rng() * 100));
    else lines[i] = lines[i] + " edited" + Math.floor(rng() * 9);
  }
  return lines.join("\n");
}

let rngState = 42;
const rng = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };

let efail = 0;
for (let t = 0; t < 400; t++) {
  const aRaw = rndText(rng, 30);
  const bRaw = rng() < 0.2 ? aRaw : mutate(rng, aRaw);
  for (const opts of [{}, { ignoreWs: true }, { ignoreCase: true }]) {
    const d = ctx(aRaw, bRaw, opts);
    const A = aRaw === "" ? [] : d.a, B = bRaw === "" ? [] : d.b;
    if (A.length !== d.statusA.length || B.length !== d.statusB.length) { console.error("status len mismatch"); efail++; break; }
    // 从 status 重建两侧文本（mods 1:1 顺序配对；纯 ins 惰性冲刷）
    const ra = [], rb = [];
    let bi = 0;
    for (let i = 0; i < d.statusA.length; i++) {
      const st = d.statusA[i];
      if (st === "eq") {
        while (bi < d.statusB.length && d.statusB[bi] === "ins") { rb.push(B[bi]); bi++; }
        if (d.statusB[bi] !== "eq") throw new Error("eq not aligned t=" + t);
        ra.push(A[i]); rb.push(B[bi]); bi++;
      } else if (st === "mod") {
        if (d.statusB[bi] !== "mod") throw new Error("mod not aligned t=" + t);
        ra.push(A[i]); rb.push(B[bi]); bi++;
      } else if (st === "del") {
        while (bi < d.statusB.length && d.statusB[bi] === "ins") { rb.push(B[bi]); bi++; }
        ra.push(A[i]);
      }
    }
    while (bi < d.statusB.length) { rb.push(B[bi]); bi++; }
    if (ra.join("\n") !== A.join("\n")) { console.error("rebuild A mismatch at t=" + t); efail++; break; }
    if (rb.join("\n") !== B.join("\n")) { console.error("rebuild B mismatch at t=" + t); efail++; break; }
    // 计数校验
    const dels = d.statusA.filter((s) => s === "del").length;
    const mods = d.statusA.filter((s) => s === "mod").length;
    const ins = d.statusB.filter((s) => s === "ins").length;
    const modsB = d.statusB.filter((s) => s === "mod").length;
    if (mods !== modsB) { console.error("mod pairing mismatch"); efail++; break; }
    if (d.removed !== dels + mods || d.added !== ins + mods) { console.error("added/removed mismatch"); efail++; break; }
    // blocks 覆盖校验：每块指向的行都必须是非 eq，且所有非 eq 行被块覆盖
    let coverA = 0, coverB = 0, bad = false;
    for (const blk of d.blocks) {
      if (blk.aLine >= 0) {
        for (let j = 0; j < blk.aCount; j++) {
          const s = d.statusA[blk.aLine + j];
          if (!s || s === "eq") { bad = true; break; }
        }
        coverA += blk.aCount;
      }
      if (blk.bLine >= 0) {
        for (let j = 0; j < blk.bCount; j++) {
          const s = d.statusB[blk.bLine + j];
          if (!s || s === "eq") { bad = true; break; }
        }
        coverB += blk.bCount;
      }
      if (bad) break;
    }
    if (bad || coverA !== dels + mods || coverB !== ins + modsB) { console.error("block coverage mismatch"); efail++; break; }
    // 相同文本必须 0 差异
    if (aRaw === bRaw && d.blocks.length !== 0) { console.error("identical text has diffs!"); efail++; break; }
    // 相似度不变量：0..100，且无差异块时必为 100
    if (!(d.sim >= 0 && d.sim <= 100)) { console.error("sim out of range:", d.sim); efail++; break; }
    if (d.blocks.length === 0 && d.sim !== 100) { console.error("blocks 0 but sim:", d.sim); efail++; break; }
  }
}
console.log(efail === 0 ? "[3] diff engine invariants: ALL PASS (400 random pairs × 3 option sets)" : "[3] ENGINE FAILED x" + efail);

// 词级 segs 覆盖检查：mod 行两侧 segs 拼接应等于原行
let sfail = 0;
{
  const aRaw = "hello world foo\nbar baz\nkeep";
  const bRaw = "hello brave world\nbar baz x\nkeep";
  const d = ctx(aRaw, bRaw, {});
  const a = aRaw.split("\n"), b = bRaw.split("\n");
  for (let i = 0; i < a.length; i++) {
    if (d.segsA[i]) {
      const joined = d.segsA[i].map((s) => s.text).join("");
      if (joined !== a[i]) { console.error("segsA reconstruct fail line", i); sfail++; }
    }
  }
  for (let i = 0; i < b.length; i++) {
    if (d.segsB[i]) {
      const joined = d.segsB[i].map((s) => s.text).join("");
      if (joined !== b[i]) { console.error("segsB reconstruct fail line", i); sfail++; }
    }
  }
  console.log(sfail === 0 ? "[4] word-seg reconstruction: PASS" : "[4] WORD-SEG FAILED x" + sfail);
}

// 字符级细化精度：高亮应只落在真正不同的字符上
let pfail = 0;
{
  // aBC vs ABC：只应标出 "a" 与 "A"
  {
    const d = ctx("aBC", "ABC", {});
    const delT = (d.segsA[0] || []).filter((s) => s.kind === "del").map((s) => s.text).join("");
    const insT = (d.segsB[0] || []).filter((s) => s.kind === "ins").map((s) => s.text).join("");
    if (delT !== "a" || insT !== "A") { console.error("precision aBC/ABC fail:", JSON.stringify(delT), JSON.stringify(insT)); pfail++; }
  }
  // Hello World → Hello Worldx：左侧不应有删除标记，右侧只标 "x"
  {
    const d = ctx("Hello World", "Hello Worldx", {});
    const hasDel = (d.segsA[0] || []).some((s) => s.kind === "del");
    const insT = (d.segsB[0] || []).filter((s) => s.kind === "ins").map((s) => s.text).join("");
    if (hasDel || insT !== "x") { console.error("precision World/Worldx fail:", hasDel, JSON.stringify(insT)); pfail++; }
  }
  // 中文逐字：你好世界 → 你好世界啊，只标 "啊"
  {
    const d = ctx("你好世界", "你好世界啊", {});
    const hasDel = (d.segsA[0] || []).some((s) => s.kind === "del");
    const insT = (d.segsB[0] || []).filter((s) => s.kind === "ins").map((s) => s.text).join("");
    if (hasDel || insT !== "啊") { console.error("precision CJK fail:", hasDel, JSON.stringify(insT)); pfail++; }
  }
  // 词序重排仍需精确：abc def → def abc（整词移动，两侧标记拼起来应覆盖全部差异词）
  {
    const d = ctx("abc def", "def abc", {});
    const delT = (d.segsA[0] || []).filter((s) => s.kind === "del").map((s) => s.text).join("");
    const insT = (d.segsB[0] || []).filter((s) => s.kind === "ins").map((s) => s.text).join("");
    if (delT + insT === "" || delT.length > 8 || insT.length > 8) { console.error("precision reorder fail:", JSON.stringify(delT), JSON.stringify(insT)); pfail++; }
  }
  console.log(pfail === 0 ? "[5] char-level precision: PASS" : "[5] PRECISION FAILED x" + pfail);
}

// 等价脚本左滑归一化：存在多个等价最短编辑脚本时，del/ins 应标在最早（相邻）位置
let nfail = 0;
{
  const norm = (segs) => (segs || []).map((s) => s.kind + ":" + s.text).join("|");
  // 123 → 133：应标中间的 2 和中间的 3，而不是行尾的 3
  {
    const d = ctx("123", "133", {});
    if (norm(d.segsA[0]) !== "eq:1|del:2|eq:3" || norm(d.segsB[0]) !== "eq:1|ins:3|eq:3") {
      console.error("slide 123/133 fail:", norm(d.segsA[0]), "|", norm(d.segsB[0]));
      nfail++;
    }
  }
  // 行级：1,2,3 → 1,3,3：右侧应把第 2 行标为 mod，第 3 行保持 eq
  {
    const d = ctx("1\n2\n3", "1\n3\n3", {});
    if (d.statusB[1] !== "mod" || d.statusB[2] !== "eq" || d.statusA[1] !== "mod") {
      console.error("slide lines fail:", d.statusA.join(","), "|", d.statusB.join(","));
      nfail++;
    }
  }
  console.log(nfail === 0 ? "[6] slide-to-earliest normalization: PASS" : "[6] SLIDE FAILED x" + nfail);
}

// 相似度：difflib ratio 公式（2×匹配字符 / 两侧总字符）
let simfail = 0;
{
  const chk = (got, want, tag) => {
    if (Math.abs(got - want) > 0.051) { console.error("[7] sim " + tag + ": got", got, "want", want); simfail++; }
  };
  chk(ctx("123", "124", {}).sim, 66.7, "123/124");
  chk(ctx("123", "456", {}).sim, 0, "disjoint");
  chk(ctx("123", "123", {}).sim, 100, "identical");
  chk(ctx("", "", {}).sim, 100, "both empty");
  chk(ctx("", "123", {}).sim, 0, "empty vs text");
  chk(ctx("abc", "", {}).sim, 0, "text vs empty");
  chk(ctx("ABC", "abc", { ignoreCase: true }).sim, 100, "ignoreCase eq");
  chk(ctx("a  b", "a b", { ignoreWs: true }).sim, 100, "ignoreWs eq");
  chk(ctx("ABC", "abc", {}).sim, 0, "case-only raw");
  // 多行：两行完全相同 + mod 对公共字符 "b"/"z"
  chk(ctx("foo\nbar\nbaz", "foo\nbar\nbuz", {}).sim, 88.9, "3-line partial");
  // 显示格式：<10 一位小数，>=10 整数（computeDiff 已先舍入到一位小数）
  const fmt = (s) => (s <= 0 ? "0" : s >= 10 ? String(Math.round(s)) : s.toFixed(1));
  const cases = [[0, "0"], [66.7, "67"], [9.9, "9.9"], [10, "10"], [6.7, "6.7"], [99.9, "100"], [100, "100"]];
  for (const [v, want] of cases) {
    if (fmt(v) !== want) { console.error("[7] fmt fail:", v, "got", fmt(v), "want", want); simfail++; }
  }
  console.log(simfail === 0 ? "[7] similarity (difflib ratio): PASS" : "[7] SIMILARITY FAILED x" + simfail);
}

// 8) worker 引导模拟：按页面 buildDiffWorker 的方式切片引擎，在 VM 里跑通消息回路
let wfail = 0;
{
  const begin = js.indexOf("/* __ENGINE_BEGIN__ */");
  const end = js.indexOf("/* __ENGINE_END__ */");
  const workerSrc = js.slice(begin, end) +
    "self.onmessage=function(e){var d=e.data;try{self.postMessage({res:computeDiff(d.a,d.b,d.o)})}" +
    "catch(err){self.postMessage({err:String((err&&err.message)||err)})}};";
  const posted = [];
  const sandbox = { performance: { now: () => Date.now() }, postMessage: (m) => posted.push(m) };
  sandbox.self = sandbox;
  vm.runInNewContext(workerSrc, sandbox);
  const msg = { a: "line one\nline two\nline three", b: "line one\nline TWO\nline three", o: {} };
  sandbox.self.onmessage({ data: msg });
  if (posted.length !== 1 || !posted[0].res) { console.error("[8] worker loop no result, posted =", posted.length); wfail++; }
  else {
    const res = posted[0].res;
    const main = ctx(msg.a, msg.b, msg.o);
    if (res.statusA.join() !== main.statusA.join() || res.statusB.join() !== main.statusB.join() ||
        res.sim !== main.sim || res.unified !== main.unified || res.added !== main.added || res.removed !== main.removed) {
      console.error("[8] worker result mismatch vs main-thread compute");
      wfail++;
    }
  }
  // computeDiff 抛错时应回传 err 而不是让 worker 崩掉
  sandbox.self.onmessage({ data: { a: 123, b: null, o: {} } });
  if (posted.length !== 2 || !posted[1].err) { console.error("[8] worker error path fail"); wfail++; }
  console.log(wfail === 0 ? "[8] worker bootstrap simulation: PASS" : "[8] WORKER SIM FAILED x" + wfail);
}

process.exit(fail || efail || sfail || pfail || nfail || simfail || wfail ? 1 : 0);