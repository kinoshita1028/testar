// Small LCS diff: character-level for Japanese, word-level for Latin text.

const TOKEN_RE = /[A-Za-z0-9_'’-]+|\s+|[\s\S]/gu;

function tokenize(s) {
  return s.match(TOKEN_RE) || [];
}

function push(ops, type, text) {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/** @returns {{type: 'equal'|'delete'|'insert', text: string}[]} */
export function diffTokens(a = '', b = '') {
  const A = tokenize(a);
  const B = tokenize(b);

  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (
    suf < A.length - pre &&
    suf < B.length - pre &&
    A[A.length - 1 - suf] === B[B.length - 1 - suf]
  ) suf++;

  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const raw = [];
  push(raw, 'equal', A.slice(0, pre).join(''));

  const n = a2.length;
  const m = b2.length;
  if (n * m > 2_000_000) {
    push(raw, 'delete', a2.join(''));
    push(raw, 'insert', b2.join(''));
  } else {
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a2[i] === b2[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) {
        push(raw, 'equal', a2[i]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        push(raw, 'delete', a2[i++]);
      } else {
        push(raw, 'insert', b2[j++]);
      }
    }
    while (i < n) push(raw, 'delete', a2[i++]);
    while (j < m) push(raw, 'insert', b2[j++]);
  }
  push(raw, 'equal', A.slice(A.length - suf).join(''));

  return normalize(raw);
}

// Group each run of changes as "delete then insert", and fold one-character
// equal islands between two changes into the change (easier to read).
function normalize(ops) {
  const out = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out.push({ type: 'delete', text: del });
    if (ins) out.push({ type: 'insert', text: ins });
    del = '';
    ins = '';
  };
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'delete') del += op.text;
    else if (op.type === 'insert') ins += op.text;
    else {
      const island = [...op.text].length <= 1;
      const between = (del || ins) && k + 1 < ops.length && k > 0;
      if (island && between) {
        del += op.text;
        ins += op.text;
      } else {
        flush();
        out.push({ type: 'equal', text: op.text });
      }
    }
  }
  flush();
  return out;
}

export function countHunks(ops) {
  let count = 0;
  let inHunk = false;
  for (const op of ops) {
    if (op.type === 'equal') inHunk = false;
    else if (!inHunk) {
      count++;
      inHunk = true;
    }
  }
  return count;
}
