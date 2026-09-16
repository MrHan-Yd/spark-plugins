// 宿主自算 Diff。
// ACP 没有 fs_patch —— 写盘是整文件的 fs/write_text_file，所以「看板里那个 Diff 面板」
// 不可能从协议里白拿，只能由宿主在写盘前后各留一份内容再逐行比对。这个模块就是那件事。
// @see [SPEC §5.4 Diff 必须由宿主计算](SPEC.md#54-diff-必须由宿主计算)

/** 按行切分（统一 CRLF，丢掉末尾空行，让行号与编辑器一致） */
export function splitLines(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countLines(text) {
  return splitLines(text).length;
}

/** LCS 编辑序列；超过规模上限时退化成「整文件替换」，避免 O(n*m) 爆内存 */
function editOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [
      ...a.map((text) => ({ type: '-', text })),
      ...b.map((text) => ({ type: '+', text })),
    ];
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ type: '-', text: a[i] });
      i++;
    } else {
      ops.push({ type: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: '-', text: a[i++] });
  while (j < m) ops.push({ type: '+', text: b[j++] });
  return ops;
}

function toHunks(ops, context, oldLabel, newLabel) {
  const oldNo = new Array(ops.length);
  const newNo = new Array(ops.length);
  let o = 1;
  let nn = 1;
  for (let k = 0; k < ops.length; k++) {
    oldNo[k] = o;
    newNo[k] = nn;
    if (ops[k].type === ' ') {
      o++;
      nn++;
    } else if (ops[k].type === '-') {
      o++;
    } else {
      nn++;
    }
  }

  const changed = [];
  for (let k = 0; k < ops.length; k++) if (ops[k].type !== ' ') changed.push(k);
  if (!changed.length) return [];

  const ranges = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    const s = Math.max(0, changed[k] - context);
    if (s <= end + 1) {
      end = Math.min(ops.length - 1, changed[k] + context);
    } else {
      ranges.push([start, end]);
      start = s;
      end = Math.min(ops.length - 1, changed[k] + context);
    }
  }
  ranges.push([start, end]);

  return ranges.map(([s, e]) => {
    const slice = ops.slice(s, e + 1);
    const oldCount = slice.filter((x) => x.type !== '+').length;
    const newCount = slice.filter((x) => x.type !== '-').length;
    const header = `@@ -${oldCount ? oldNo[s] : oldNo[s] - 1},${oldCount} +${newCount ? newNo[s] : newNo[s] - 1},${newCount} @@`;
    return {
      header,
      old_start: oldCount ? oldNo[s] : oldNo[s] - 1,
      old_count: oldCount,
      new_start: newCount ? newNo[s] : newNo[s] - 1,
      new_count: newCount,
      lines: slice,
    };
  });
}

/**
 * @returns {{added:number, removed:number, hunks:Array, text:string, unchanged:boolean}}
 */
export function unifiedDiff(oldText, newText, { context = 3, oldLabel = 'a', newLabel = 'b' } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = editOps(a, b);
  const hunks = toHunks(ops, context, oldLabel, newLabel);
  const added = ops.filter((x) => x.type === '+').length;
  const removed = ops.filter((x) => x.type === '-').length;

  const text = hunks.length
    ? [`--- ${oldLabel}`, `+++ ${newLabel}`, ...hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.type + l.text)])].join('\n')
    : '';

  return { added, removed, hunks, text, unchanged: added === 0 && removed === 0 };
}
