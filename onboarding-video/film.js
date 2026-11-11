// 新人の初日 — 8 scenes x 8s, 16:9. Every frame is a pure function of time.
const W = 1280, H = 720, SCENE_LEN = 8, SCENES = 8;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const seg = (t, a, b) => ease((t - a) / (b - a));
const bump = (t, a, b, c) => seg(t, a, b) * (1 - seg(t, b, c));
const lerp = (a, b, k) => a + (b - a) * k;
const R = n => Math.round(n * 10) / 10;

const C = {
  skin: '#f0c8a4', skinD: '#dcab86', hair: '#1c1a1b', shoe: '#3a3632',
  beige: '#d9c9a6', beigeD: '#c2af86', pants: '#cbb992', pantsD: '#b9a67f',
  navy: '#34415d', navyD: '#283349'
};
const KIND = {
  new: { top: C.beige, topD: C.beigeD, pants: C.pants, fore: C.beige, hair: C.hair, style: 'bob' },
  trainer: { top: C.beige, topD: C.beigeD, pants: C.pants, fore: C.skin, hair: C.hair, style: 'short' },
  boss: { top: C.navy, topD: C.navyD, pants: '#62666d', fore: C.navy, hair: '#9d9d99', style: 'short' },
  worker: { top: C.beige, topD: C.beigeD, pants: C.pants, fore: C.beige, hair: '#2a2523', style: 'cap' }
};

// ---------- two-bone limb ----------
function ik(sx, sy, hx, hy, l1, l2, dir) {
  let dx = hx - sx, dy = hy - sy, d = Math.hypot(dx, dy) || 0.001;
  const max = l1 + l2 - 0.5;
  if (d > max) { dx *= max / d; dy *= max / d; d = max; hx = sx + dx; hy = sy + dy; }
  const a = Math.atan2(dy, dx);
  const b = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  return [sx + Math.cos(a + dir * b) * l1, sy + Math.sin(a + dir * b) * l1, hx, hy];
}
function limb(sx, sy, hx, hy, l1, l2, dir, w, c1, c2, hand) {
  const [ex, ey, x, y] = ik(sx, sy, hx, hy, l1, l2, dir);
  let s = `<path d="M${R(sx)} ${R(sy)}L${R(ex)} ${R(ey)}" stroke="${c1}" stroke-width="${w}" stroke-linecap="round" fill="none"/>` +
    `<path d="M${R(ex)} ${R(ey)}L${R(x)} ${R(y)}" stroke="${c2}" stroke-width="${w - 2}" stroke-linecap="round" fill="none"/>`;
  if (hand) s += `<circle cx="${R(x)}" cy="${R(y)}" r="${R(w * 0.5)}" fill="${C.skin}"/>`;
  return s;
}

function hairSide(k, y) {
  if (k.style === 'bob') return `<path transform="translate(0 ${y})" d="M25 -329 C24 -356 -33 -356 -31 -320 L-29 -296 Q-10 -287 5 -297 L7 -325 Q15 -331 25 -329Z" fill="${k.hair}"/>`;
  let s = `<path transform="translate(0 ${y})" d="M25 -329 C24 -353 -30 -353 -27 -320 L-21 -310 L-17 -326 Q2 -337 25 -329Z" fill="${k.hair}"/>`;
  if (k.style === 'cap') s += `<path transform="translate(0 ${y})" d="M-27 -327 C-28 -354 26 -355 27 -332 L43 -327 L43 -323 L-27 -323Z" fill="#8f9aa3"/>`;
  return s;
}
function helmetSide(y) {
  return `<g transform="translate(0 ${y})"><path d="M8 -320 L13 -297" stroke="#55585c" stroke-width="2.5" fill="none"/>` +
    `<path d="M-30 -324 C-31 -364 31 -364 31 -327 L42 -323 L42 -318 L-30 -318Z" fill="#f6f5ef" stroke="#c9c8c0" stroke-width="1.5"/>` +
    `<path d="M-4 -353 Q0 -356 4 -353 L4 -322 L-4 -322Z" fill="#e3e2da"/></g>`;
}

// person: origin = feet. view: side (faces +x; fx=-1 mirrors), front, back.
// hands: hA / hB = [x,y] local, or {w:[x,y]} in scene coordinates.
function person(o) {
  const k = KIND[o.kind], s = o.s || 1, fx = o.fx === undefined ? 1 : (Math.abs(o.fx) < 0.08 ? 0.08 : o.fx);
  const sit = o.sit || 0, hipY = -165 + sit, bow = o.bow || 0, nod = o.nod || 0, view = o.view || 'side';
  const toL = p => {
    if (!p) return null;
    if (!p.w) return p;
    let lx = (p.w[0] - o.x) / (s * fx), ly = (p.w[1] - o.y) / s;
    if (view === 'side' && bow) { // undo torso rotation about the hip
      const r = -bow * Math.PI / 180, dx = lx, dy = ly - hipY;
      lx = dx * Math.cos(r) - dy * Math.sin(r); ly = hipY + dx * Math.sin(r) + dy * Math.cos(r);
    }
    return [lx, ly];
  };
  let g = `<g transform="translate(${R(o.x)} ${R(o.y)}) scale(${R(s * fx * 100) / 100} ${s})">`;
  g += `<ellipse cx="6" cy="1" rx="58" ry="8" fill="rgba(40,30,20,.16)"/>`;
  const shY = -272 + sit;
  if (view === 'side') {
    const ph = o.walk;
    let fA = [10, -8], fB = [-8, -8], sw = 0;
    if (sit) { fA = [82, -8]; fB = [70, -8]; }
    else if (ph !== undefined) {
      fA = [Math.sin(ph) * 40, -8 - Math.max(0, Math.cos(ph)) * 15];
      fB = [-Math.sin(ph) * 40, -8 - Math.max(0, -Math.cos(ph)) * 15];
      sw = Math.sin(ph) * 24;
    }
    const leg = (f, c) => limb(0, hipY, f[0], f[1], 82, 79, -1, 27, c, c) +
      `<path d="M${R(f[0] - 14)} ${R(f[1] + 8)} q0 -15 14 -15 h10 q18 2 20 15z" fill="${C.shoe}"/>`;
    g += leg(fB, o.kind === 'boss' ? '#565a61' : C.pantsD) + leg(fA, k.pants);
    g += `<g transform="rotate(${R(bow)} 0 ${hipY})">`;
    const hB = toL(o.hB) || [-6 + sw, hipY + 4], hA = toL(o.hA) || [8 - sw, hipY + 4];
    g += limb(-2, shY + 2, hB[0], hB[1], 58, 56, 1, 21, k.topD, k.fore === C.skin ? C.skinD : k.topD, true);
    // torso
    const hem = o.kind === 'boss' ? 26 : 10;
    g += `<rect x="-27" y="${shY - 20}" width="55" height="${hipY + hem - shY + 20}" rx="17" fill="${k.top}"/>`;
    g += `<path d="M-27 ${hipY - 30} h55" stroke="${k.topD}" stroke-width="2" opacity=".6"/>`;
    if (o.kind === 'boss') g += `<path d="M24 ${shY - 12} L12 ${shY + 30} L22 ${hipY + 20}" stroke="${k.topD}" stroke-width="3" fill="none"/><path d="M20 ${shY - 16} l8 3 -6 20z" fill="#e8e6e0"/>`;
    else g += `<path d="M8 ${shY - 19} L28 ${shY - 12} L20 ${shY + 4}Z" fill="${k.topD}"/>`;
    if (o.kind === 'new') {
      g += `<rect x="7" y="${shY + 5}" width="13" height="16" fill="#fbfaf5"/><rect x="5" y="${shY + 10}" width="18" height="19" rx="2" fill="${k.top}" stroke="${k.topD}" stroke-width="1.5"/>`;
      g += `<rect x="6" y="${shY + 35}" width="17" height="10" rx="1.5" fill="#fff" stroke="#9aa3ad" stroke-width="1"/><rect x="6" y="${shY + 35}" width="17" height="3" fill="#6f8fb3"/>`;
    }
    // head
    g += `<rect x="-8" y="${shY - 30}" width="15" height="16" fill="${C.skinD}"/>`;
    g += `<g transform="rotate(${R(nod)} 0 ${shY - 24})"><g transform="translate(0 ${sit})">`;
    g += `<ellipse cx="3" cy="-320" rx="24" ry="27" fill="${C.skin}"/><path d="M25 -323 l7 9 -8 3z" fill="${C.skin}"/>`;
    g += `<ellipse cx="-4" cy="-317" rx="5" ry="7" fill="${C.skinD}"/>`;
    g += o.smile ? `<path d="M11 -322 q4 -4 8 0" stroke="#2a2422" stroke-width="2.2" fill="none" stroke-linecap="round"/>`
      : `<ellipse cx="15" cy="-322" rx="2.5" ry="3.3" fill="#2a2422"/>`;
    g += `<path d="M9 -330 q6 -3 12 -1" stroke="${k.hair === C.hair ? '#3a3230' : '#8a8a86'}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    g += `<path d="M14 -305 q5 ${o.smile ? 6 : 1.5} 11 ${o.smile ? -2 : 0}" stroke="#a8604f" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    if (o.kind === 'new') g += `<ellipse cx="10" cy="-311" rx="5" ry="3" fill="#f2a58f" opacity=".45"/>`;
    g += `</g>` + hairSide(k, sit) + (o.helmet ? helmetSide(sit) : '') + `</g>`;
    g += limb(2, shY + 2, hA[0], hA[1], 58, 56, 1, 22, k.top, k.fore, true);
    g += `</g>`;
  } else {
    const back = view === 'back', hd = bow * 0.5 + nod * 0.45;
    g += `<rect x="-27" y="${hipY - 4}" width="25" height="${-hipY - 4}" rx="6" fill="${k.pants}"/><rect x="2" y="${hipY - 4}" width="25" height="${-hipY - 4}" rx="6" fill="${k.pants}"/>`;
    g += `<path d="M-30 0 q0 -14 14 -14 q14 0 14 14z M2 0 q0 -14 14 -14 q14 0 14 14z" fill="${C.shoe}"/>`;
    const hL = toL(o.hB) || [-50, hipY + 6], hR = toL(o.hA) || [50, hipY + 6];
    g += `<g transform="translate(0 ${R(bow * 0.25)})">`;
    const hem = o.kind === 'boss' ? 26 : 10;
    g += `<rect x="-42" y="${shY - 20}" width="84" height="${hipY + hem - shY + 20}" rx="20" fill="${k.top}"/>`;
    if (!back) {
      g += o.kind === 'boss' ? `<path d="M-12 ${shY - 20} L0 ${shY + 22} L12 ${shY - 20}Z" fill="#e8e6e0"/><path d="M0 ${shY + 22} V${hipY + 24}" stroke="${k.topD}" stroke-width="2.5"/>`
        : `<path d="M-15 ${shY - 20} L0 ${shY + 6} L15 ${shY - 20}Z" fill="${C.skinD}"/><path d="M-17 ${shY - 21} L-2 ${shY + 8} M17 ${shY - 21} L2 ${shY + 8}" stroke="${k.topD}" stroke-width="5" stroke-linecap="round"/><path d="M0 ${shY + 8} V${hipY + 8}" stroke="${k.topD}" stroke-width="2"/>`;
      g += `<rect x="12" y="${shY + 16}" width="19" height="19" rx="2" fill="${k.top}" stroke="${k.topD}" stroke-width="1.5"/>`;
    }
    g += limb(-36, shY + 2, hL[0], hL[1], 58, 56, 1, 21, k.top, k.fore, true);
    g += limb(36, shY + 2, hR[0], hR[1], 58, 56, -1, 21, k.top, k.fore, true);
    g += `<g transform="translate(0 ${R(hd)})"><rect x="-8" y="${shY - 30}" width="16" height="16" fill="${C.skinD}"/>`;
    g += `<ellipse cx="0" cy="-320" rx="25" ry="28" fill="${C.skin}"/>`;
    if (back) {
      g += k.style === 'bob' ? `<path d="M-30 -322 C-32 -360 32 -360 30 -322 L30 -297 Q0 -287 -30 -297Z" fill="${k.hair}"/>`
        : `<path d="M-27 -316 C-30 -356 30 -356 27 -316 Q0 -298 -27 -316Z" fill="${k.hair}"/>`;
    } else {
      g += `<ellipse cx="-25" cy="-317" rx="4" ry="7" fill="${C.skinD}"/><ellipse cx="25" cy="-317" rx="4" ry="7" fill="${C.skinD}"/>`;
      g += o.smile ? `<path d="M-14 -321 q4 -4 8 0 M6 -321 q4 -4 8 0" stroke="#2a2422" stroke-width="2.2" fill="none" stroke-linecap="round"/>`
        : `<ellipse cx="-10" cy="-321" rx="2.6" ry="3.2" fill="#2a2422"/><ellipse cx="10" cy="-321" rx="2.6" ry="3.2" fill="#2a2422"/>`;
      g += `<path d="M-16 -330 q6 -3 11 -1 M5 -331 q6 -2 11 1" stroke="#3a3230" stroke-width="2" fill="none" stroke-linecap="round"/>`;
      g += `<path d="M-7 -306 Q0 ${o.smile ? -299 : -304} 7 -306" stroke="#a8604f" stroke-width="2" fill="none" stroke-linecap="round"/>`;
      g += k.style === 'bob' ? `<path d="M-30 -322 C-32 -361 32 -361 30 -322 L30 -298 Q24 -291 19 -298 L21 -327 Q0 -339 -21 -327 L-19 -298 Q-24 -291 -30 -298Z" fill="${k.hair}"/>`
        : `<path d="M-27 -321 C-30 -357 30 -357 27 -321 Q20 -338 0 -337 Q-20 -338 -27 -321Z" fill="${k.hair}"/>`;
      if (k.style === 'cap') g += `<path d="M-28 -330 C-28 -358 28 -358 28 -330 Q0 -322 -28 -330Z" fill="#8f9aa3"/><path d="M-24 -331 Q0 -318 24 -331 Q0 -326 -24 -331Z" fill="#7b868f"/>`;
    }
    g += `</g></g>`;
  }
  return g + `</g>`;
}

// ---------- shared set pieces ----------
const DEFS = `<defs>
<linearGradient id="gSkyAM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe2ee"/><stop offset="1" stop-color="#fbe9cf"/></linearGradient>
<linearGradient id="gSunL" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd596" stop-opacity=".5"/><stop offset=".7" stop-color="#ffd596" stop-opacity="0"/></linearGradient>
<linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b6257"/><stop offset=".72" stop-color="#8a8072"/><stop offset=".73" stop-color="#a59b8a"/><stop offset="1" stop-color="#b8ae9c"/></linearGradient>
<linearGradient id="gGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e4eff3"/><stop offset=".5" stop-color="#bcd2da"/><stop offset="1" stop-color="#d9e8ed"/></linearGradient>
<linearGradient id="gMetal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8f979d"/><stop offset=".35" stop-color="#eef1f3"/><stop offset="1" stop-color="#7d858b"/></linearGradient>
<linearGradient id="gFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b7beb9"/><stop offset="1" stop-color="#9aa29e"/></linearGradient>
<linearGradient id="gWood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d7bd94"/><stop offset="1" stop-color="#bfa278"/></linearGradient>
<linearGradient id="gEve" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3c9a0"/><stop offset=".6" stop-color="#f6a763"/><stop offset="1" stop-color="#ee8a4c"/></linearGradient>
<linearGradient id="gDay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dcebf2"/><stop offset="1" stop-color="#f4f7f3"/></linearGradient>
<radialGradient id="gVig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient>
<radialGradient id="gSun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff3d0"/><stop offset=".3" stop-color="#ffd58a" stop-opacity=".9"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient>
<radialGradient id="gLamp" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<clipPath id="frame"><rect width="${W}" height="${H}"/></clipPath>
</defs>`;
const cam = (inner, cx, cy, z) => `<g transform="translate(640 360) scale(${R(z * 1000) / 1000}) translate(${R(-cx)} ${R(-cy)})">${inner}</g>`;
const lamp = (x, y, w = 220) => `<ellipse cx="${x + w / 2}" cy="${y + 8}" rx="${w * 0.9}" ry="60" fill="url(#gLamp)"/><rect x="${x - 8}" y="${y - 8}" width="${w + 16}" height="10" fill="#c9cdcf"/><rect x="${x}" y="${y}" width="${w}" height="9" rx="4" fill="#fdfefb"/>`;
const win = (x, y, w, h, fill = 'url(#gDay)', n = 2) => {
  let s = `<rect x="${x - 6}" y="${y - 6}" width="${w + 12}" height="${h + 12}" fill="#8e9498"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  for (let i = 1; i < n; i++) s += `<rect x="${x + w * i / n - 3}" y="${y}" width="6" height="${h}" fill="#8e9498"/>`;
  return s;
};
const box = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#cda877"/><rect x="${x}" y="${y}" width="${w}" height="${h * 0.16}" fill="#b98f5c" opacity=".55"/><rect x="${x + w / 2 - 7}" y="${y}" width="14" height="${h}" fill="#e2c79b" opacity=".8"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#a9834f" stroke-width="1.5"/>`;
const partCyl = (x, y) => `<rect x="${R(x - 9)}" y="${R(y - 30)}" width="18" height="30" rx="2" fill="url(#gMetal)"/><rect x="${R(x - 12)}" y="${R(y - 8)}" width="24" height="8" rx="2" fill="url(#gMetal)"/><ellipse cx="${R(x)}" cy="${R(y - 30)}" rx="9" ry="3" fill="#f4f6f7" stroke="#8a9298" stroke-width="1"/>`;
const plant = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 -40 C-40 -90 -50 -120 -30 -150 C-20 -110 -8 -80 0 -40 C0 -100 10 -150 30 -170 C34 -120 20 -80 0 -40 C30 -80 50 -90 66 -120 C60 -80 30 -55 0 -40" fill="#5f8a5b"/><path d="M-26 -42 h52 l-7 42 h-38z" fill="#b9694a"/></g>`;
const helmet = (cx, by, s = 1) => `<g transform="translate(${R(cx)} ${R(by)}) scale(${s})"><path d="M-36 -8 C-38 -58 36 -58 36 -10 L46 -6 L46 0 L-36 0Z" fill="#f6f5ef" stroke="#c9c8c0" stroke-width="1.5"/><path d="M-5 -45 Q0 -48 5 -45 L5 -4 L-5 -4Z" fill="#e3e2da"/><rect x="-36" y="-6" width="82" height="3" fill="#dcdbd2"/></g>`;
const goggles = (cx, by) => `<g transform="translate(${cx} ${by})"><rect x="-38" y="-30" width="76" height="28" rx="12" fill="#d9eef4" fill-opacity=".75" stroke="#5c6a72" stroke-width="3"/><path d="M-4 -30 q4 8 8 0" stroke="#5c6a72" stroke-width="3" fill="none"/><path d="M-38 -18 h-12 M38 -18 h12" stroke="#3f474d" stroke-width="5" stroke-linecap="round"/><path d="M-28 -24 l10 0" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/></g>`;

// ================= SCENE 1 : ようこそ =================
function s1(t) {
  const doorX = lerp(760, 532, seg(t, 0.4, 1.7));
  let nx, walking = true;
  if (t < 3) nx = lerp(150, 600, t / 3); else if (t < 4.9) { nx = 600; walking = false; } else nx = lerp(600, 872, (t - 4.9) / 3.1);
  const bow = 27 * bump(t, 3.15, 3.9, 4.7);
  const tx = lerp(900, 992, seg(t, 4.6, 5.8));
  const wel = seg(t, 2.3, 3.1) * (1 - seg(t, 6.6, 7.4));
  const facade = (x0, x1) => {
    let s = `<rect x="${x0}" y="70" width="${x1 - x0}" height="540" fill="#ebe6da"/>`;
    for (let y = 98; y < 540; y += 28) s += `<rect x="${x0}" y="${y}" width="${x1 - x0}" height="1.5" fill="#d6d0c2"/>`;
    return s + `<rect x="${x0}" y="540" width="${x1 - x0}" height="70" fill="#b9b2a3"/><rect x="${x0}" y="40" width="${x1 - x0}" height="36" fill="#6f6a63"/>`;
  };
  let w = `<rect width="1500" height="720" x="-100" fill="url(#gSkyAM)"/>` + facade(-100, 1400);
  w += `<rect x="-100" y="610" width="1500" height="140" fill="#bdb7aa"/><rect x="-100" y="610" width="1500" height="5" fill="#a39d90"/>`;
  w += win(130, 270, 330, 170, 'url(#gGlass)', 3) + `<path d="M150 440 L250 270 h40 L190 440z" fill="#fff" opacity=".35"/>`;
  // doorway + interior
  w += `<rect x="760" y="240" width="240" height="370" fill="url(#gIn)"/><rect x="842" y="300" width="96" height="120" fill="#e9e2c9" opacity=".55"/><rect x="786" y="430" width="56" height="78" fill="#756b5e"/>`;
  w += `<rect x="748" y="228" width="264" height="14" fill="#5b5f63"/><rect x="700" y="196" width="360" height="16" fill="#7c7a75"/>`;
  // sliding door
  w += `<g transform="translate(${R(doorX)} 240)"><rect width="240" height="370" fill="url(#gGlass)" opacity=".92"/><rect width="240" height="370" fill="none" stroke="#5b5f63" stroke-width="10"/><rect x="0" y="230" width="240" height="8" fill="#5b5f63"/><rect x="214" y="170" width="8" height="70" rx="4" fill="#33373a"/><path d="M30 330 L150 20 h44 L74 330z" fill="#fff" opacity=".3"/></g>`;
  w += person({ kind: 'trainer', x: tx, y: 612, s: 1.15, fx: -1, smile: true, bow: 9 * bump(t, 3.4, 4.0, 4.8),
    hA: t < 1.9 ? { w: [clamp(doorX + 226, tx - 120, tx + 60), 430] } : (wel > 0.01 ? { w: [lerp(tx - 10, tx + 78, wel), lerp(520, 440, wel)] } : null) });
  w += `<rect x="760" y="240" width="240" height="370" fill="#2c261f" opacity=".1"/>`;
  w += person({ kind: 'new', x: nx, y: 616, s: 1.15, walk: walking ? nx / 25.5 : undefined, bow, smile: t > 4.4, nod: bow * 0.3 });
  if (nx > 800) w += `<rect x="760" y="240" width="240" height="370" fill="#2c261f" opacity="${R(0.12 * seg(nx, 800, 900))}"/>`;
  w += facade(1000, 1400) + `<rect x="1000" y="236" width="10" height="374" fill="#5b5f63"/>` + plant(1120, 612, 1.1);
  w += `<rect x="-100" y="0" width="1500" height="760" fill="url(#gSunL)"/>`;
  w += `<path d="M-100 250 L700 560 L700 700 L-100 520Z" fill="#fff0c8" opacity=".13"/>`;
  const k = seg(t, 0, 8);
  return cam(w, lerp(600, 790, k) + Math.sin(t * 1.1) * 3, lerp(385, 400, k) + Math.sin(t * 1.7) * 2, lerp(1.0, 1.28, k));
}

// ================= SCENE 2 : 私たちの仕事 =================
function s2(t) {
  let w = `<rect x="-200" y="0" width="2400" height="720" fill="#dfe4e1"/><rect x="-200" y="560" width="2400" height="200" fill="url(#gFloor)"/><rect x="-200" y="556" width="2400" height="6" fill="#c4cbc7"/>`;
  for (let i = 0; i < 6; i++) w += win(40 + i * 340, 70, 250, 120, 'url(#gDay)', 3) + lamp(110 + i * 340, 30, 200);
  w += `<path d="M40 190 h250 l160 370 h-250z M720 190 h250 l160 370 h-250z" fill="#fff" opacity=".12"/>`;
  // steel rack with cartons
  w += `<g>`;
  for (const y of [250, 400, 550]) {
    for (let i = 0; i < 5; i++) w += box(1178 + i * 132, y - 112, 118, 112);
    w += `<rect x="1150" y="${y}" width="700" height="12" fill="#7d868c"/>`;
  }
  for (const x of [1150, 1492, 1838]) w += `<rect x="${x}" y="110" width="12" height="455" fill="#6a7379"/>`;
  w += `<rect x="1890" y="470" width="220" height="16" fill="#b08b5a"/>` + box(1900, 360, 100, 110) + box(2004, 360, 100, 110) + `</g>`;
  // newcomer, watching from a distance
  w += person({ kind: 'new', x: 985, y: 600, s: 0.86, fx: -1, nod: 4 + Math.sin(t * 0.8) * 2, hA: [26, -205], hB: [20, -200] });
  // two packers behind the bench
  const cyc = (ph) => {
    const T = 2.5, u = ((t + ph) % T) / T, n = Math.floor((t + ph) / T);
    return { u, n };
  };
  const packer = (kind, x, dirn, ph, trayX, slot0) => {
    const { u, n } = cyc(ph);
    const P0 = [trayX, 402], P1 = [x + dirn * 18, 352], P2 = [slot0 - dirn * (n % 6) * 24, 400], P3 = [x + dirn * 60, 408];
    let p;
    if (u < 0.22) p = [lerp(P3[0], P0[0], ease(u / 0.22)), lerp(P3[1], P0[1], ease(u / 0.22))];
    else if (u < 0.45) { const k = ease((u - 0.22) / 0.23); p = [lerp(P0[0], P1[0], k), lerp(P0[1], P1[1], k)]; }
    else if (u < 0.65) p = [P1[0] + Math.sin(u * 40) * 2, P1[1]];
    else if (u < 0.88) { const k = ease((u - 0.65) / 0.23); p = [lerp(P1[0], P2[0], k), lerp(P1[1], P2[1], k) - Math.sin(k * Math.PI) * 14]; }
    else { const k = ease((u - 0.88) / 0.12); p = [lerp(P2[0], P3[0], k), lerp(P2[1], P3[1], k)]; }
    const carrying = u > 0.2 && u < 0.88;
    const still = { w: [x - dirn * 62, 404] };
    const body = person({ kind, view: 'front', x, y: 640, s: 1.3, nod: u > 0.4 && u < 0.7 ? 8 : 4,
      hA: dirn > 0 ? { w: p } : still, hB: dirn > 0 ? still : { w: p } });
    let placed = '';
    const cnt = 2 + n + (u >= 0.88 ? 1 : 0);
    for (let i = 0; i < Math.min(cnt, 6); i++) placed += partCyl(slot0 - dirn * i * 24, 424);
    return { body, part: carrying ? partCyl(p[0], p[1] + 20) : '', placed };
  };
  const a = packer('trainer', 330, 1, 0, 452, 396), b = packer('worker', 640, -1, 1.2, 508, 574);
  w += a.body + b.body;
  // bench
  w += `<rect x="60" y="430" width="860" height="22" fill="url(#gWood)"/><rect x="60" y="452" width="860" height="8" fill="#a48a63"/><rect x="80" y="460" width="820" height="230" fill="#8b949a"/><rect x="80" y="460" width="820" height="12" fill="#737c82"/>`;
  // parts tray (finished parts) between them
  for (let i = 0; i < 4; i++) w += partCyl(446 + i * 22, 426);
  w += `<rect x="426" y="412" width="108" height="18" rx="3" fill="#5f7f9a"/>`;
  // packing trays
  w += a.placed + `<rect x="262" y="408" width="150" height="22" rx="3" fill="#cda877" stroke="#a9834f" stroke-width="1.5"/>`;
  w += b.placed + `<rect x="558" y="408" width="150" height="22" rx="3" fill="#cda877" stroke="#a9834f" stroke-width="1.5"/>`;
  w += a.part + b.part;
  w += box(760, 340, 120, 90);
  const k = seg(t, 1.6, 7.4);
  return cam(w, lerp(470, 1330, k) + Math.sin(t * 1.0) * 3, lerp(385, 395, k) + Math.sin(t * 1.6) * 2, lerp(1.75, 1.14, k));
}

// ================= SCENE 3 : 1日の流れと勤務ルール =================
function s3(t) {
  if (t < 2.7) { // a) time recorder
    const k = seg(t, 0.25, 1.1) * (1 - seg(t, 1.9, 2.6)), lit = t > 1.15 && t < 2.3;
    const hx = lerp(1150, 742, k), hy = lerp(760, 452, k);
    let w = `<rect width="1280" height="720" fill="#ece8de"/><rect y="560" width="1280" height="160" fill="#dcd7cb"/><rect y="556" width="1280" height="5" fill="#c9c3b5"/>`;
    w += `<path d="M0 0 h420 L160 720 H0Z" fill="#fff6dd" opacity=".35"/>`;
    w += `<rect x="446" y="150" width="330" height="420" rx="22" fill="#00000022" transform="translate(10 12)"/><rect x="446" y="150" width="330" height="420" rx="22" fill="#4b5158"/><rect x="462" y="166" width="298" height="388" rx="14" fill="#5a6168"/>`;
    w += `<rect x="492" y="200" width="238" height="110" rx="8" fill="#c9d9cc"/><rect x="492" y="200" width="238" height="110" rx="8" fill="#fff" opacity=".18"/><rect x="512" y="226" width="90" height="14" rx="3" fill="#8fa596" opacity=".7"/><rect x="512" y="254" width="150" height="26" rx="4" fill="#8fa596" opacity=".7"/>`;
    w += `<circle cx="611" cy="440" r="62" fill="#3d4349"/><circle cx="611" cy="440" r="48" fill="none" stroke="${lit ? '#7be08f' : '#8b949b'}" stroke-width="5"/>`;
    if (lit) w += `<circle cx="611" cy="440" r="${R(48 + (t - 1.15) * 40)}" fill="none" stroke="#7be08f" stroke-width="3" opacity="${R(clamp(1 - (t - 1.15) * 1.6))}"/>`;
    w += `<circle cx="720" cy="350" r="8" fill="${lit ? '#6fe387' : '#7a8188'}"/>` + (lit ? `<circle cx="720" cy="350" r="18" fill="#6fe387" opacity=".3"/>` : '');
    for (let i = 0; i < 3; i++) w += `<rect x="${492 + i * 46}" y="340" width="34" height="20" rx="5" fill="#737b83"/>`;
    // card rack
    w += `<rect x="900" y="170" width="250" height="330" rx="8" fill="#b9b3a4"/>`;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) w += `<rect x="${918 + c * 76}" y="${186 + r * 62}" width="62" height="44" rx="3" fill="#f7f5ee"/><rect x="${918 + c * 76}" y="${216 + r * 62}" width="62" height="16" fill="#a39d8e"/>`;
    // hand + card
    w += `<g transform="translate(${R(hx)} ${R(hy)}) rotate(-28)"><rect x="-150" y="-28" width="130" height="80" rx="6" fill="#f9f9f6" stroke="#b9c3cc" stroke-width="2"/><rect x="-150" y="-28" width="130" height="20" rx="6" fill="#7d9cc0"/>` +
      `<rect x="40" y="-34" width="420" height="96" rx="40" fill="${C.beige}"/><rect x="40" y="-34" width="36" height="96" rx="8" fill="${C.beigeD}"/>` +
      `<path d="M-40 -8 Q-52 20 -30 44 L50 56 L50 -28 L-4 -30Z" fill="${C.skin}"/><path d="M-62 -20 q-14 8 -4 20 l40 2 q8 -12 -4 -20z" fill="${C.skin}" stroke="${C.skinD}" stroke-width="1.5"/></g>`;
    return cam(w, 640, 360, 1 + t * 0.012);
  }
  if (t < 5.35) { // b) wall clock, a little before 8:30
    const u = t - 2.7, sec = 38 + Math.floor(u), secA = sec * 6 + ease(clamp((u % 1) * 6)) * 6 - 6;
    const minA = (25 + sec / 60) * 6, hrA = (8 + 25 / 60) * 30;
    let w = `<rect width="1280" height="720" fill="#eeeae1"/><path d="M620 0 h360 L700 720 H340Z" fill="#fff7e2" opacity=".5"/>`;
    w += `<rect y="590" width="1280" height="130" fill="#9aa4a8"/><rect y="584" width="1280" height="8" fill="#838d91"/>`;
    for (let i = 0; i < 9; i++) w += `<rect x="${60 + i * 62}" y="${610}" width="48" height="110" fill="${['#6f8fb3', '#c8cdd0', '#8aa38b', '#c8cdd0'][i % 4]}"/><rect x="${72 + i * 62}" y="640" width="24" height="34" rx="3" fill="#fff" opacity=".7"/>`;
    w += plant(1060, 590, 1.3);
    w += `<circle cx="646" cy="316" r="182" fill="#00000018"/><circle cx="640" cy="308" r="182" fill="#3b4046"/><circle cx="640" cy="308" r="166" fill="#fbfaf6"/>`;
    for (let i = 0; i < 60; i++) { const big = i % 5 === 0; w += `<rect x="${640 - (big ? 3 : 1)}" y="${308 - 156}" width="${big ? 6 : 2}" height="${big ? (i % 15 === 0 ? 30 : 20) : 9}" fill="#3b4046" transform="rotate(${i * 6} 640 308)"/>`; }
    w += `<rect x="634" y="218" width="12" height="110" rx="5" fill="#2e3237" transform="rotate(${R(hrA)} 640 308)"/>`;
    w += `<rect x="636" y="170" width="8" height="158" rx="4" fill="#2e3237" transform="rotate(${R(minA)} 640 308)"/>`;
    w += `<rect x="638.5" y="162" width="3" height="180" fill="#c8483c" transform="rotate(${R(secA)} 640 308)"/><circle cx="640" cy="308" r="9" fill="#c8483c"/>`;
    return cam(w, 640, 360, 1.02);
  }
  // c) break room
  let w = `<rect width="1280" height="720" fill="#ebe7dc"/>` + win(210, 60, 860, 210, 'url(#gDay)', 4) + `<rect y="330" width="1280" height="390" fill="#cfc8b8"/><rect y="326" width="1280" height="6" fill="#bbb4a3"/>`;
  w += `<path d="M210 276 h860 l150 444 h-1160z" fill="#fff8e4" opacity=".28"/>`;
  for (const x of [250, 470, 690, 910]) w += `<rect x="${x}" y="300" width="120" height="16" rx="6" fill="#6f8296"/><rect x="${x + 8}" y="316" width="8" height="70" fill="#59626a"/><rect x="${x + 104}" y="316" width="8" height="70" fill="#59626a"/>`;
  w += `<path d="M300 372 H980 L1180 640 H100Z" fill="#e7d6b4"/><path d="M100 640 H1180 V664 H100Z" fill="#c7b38c"/><rect x="150" y="664" width="26" height="60" fill="#8a8f93"/><rect x="1104" y="664" width="26" height="60" fill="#8a8f93"/>`;
  const set = (x, y, s, ph) => {
    let g = `<g transform="translate(${x} ${y}) scale(${s})">`;
    g += `<rect x="-88" y="-2" width="150" height="74" rx="12" fill="#00000018" transform="translate(4 6)"/><rect x="-88" y="-2" width="150" height="74" rx="12" fill="#3c2f2a"/><rect x="-82" y="4" width="138" height="62" rx="8" fill="#7b2f2a"/>`;
    g += `<rect x="-78" y="8" width="66" height="54" rx="6" fill="#fbfaf4"/><circle cx="-45" cy="35" r="7" fill="#c7453a"/>`;
    g += `<rect x="-8" y="8" width="60" height="25" rx="5" fill="#f1cf5d"/><rect x="-8" y="37" width="28" height="25" rx="5" fill="#7fa866"/><rect x="24" y="37" width="28" height="25" rx="5" fill="#b9794a"/>`;
    g += `<rect x="-86" y="80" width="146" height="6" rx="3" fill="#b08b5a"/>`;
    g += `<ellipse cx="104" cy="64" rx="26" ry="9" fill="#00000018"/><path d="M80 22 v36 a24 9 0 0 0 48 0 v-36z" fill="#dfe5e2"/><ellipse cx="104" cy="22" rx="24" ry="9" fill="#f4f6f4"/><ellipse cx="104" cy="23" rx="19" ry="6.5" fill="#a9bd6f"/>`;
    for (let i = 0; i < 2; i++) { const q = (t * 0.5 + ph + i * 0.5) % 1; g += `<path d="M${96 + i * 14} ${14 - q * 46} q${8 * Math.sin(t * 2 + i + ph * 6)} -12 0 -24 q-8 -10 0 -22" stroke="#fff" stroke-width="5" stroke-linecap="round" fill="none" opacity="${R(0.55 * Math.sin(q * Math.PI))}"/>`; }
    return g + `</g>`;
  };
  [[390, 396, 0.62], [640, 396, 0.62], [880, 396, 0.62]].forEach((p, i) => w += set(p[0], p[1], p[2], i * 0.3));
  [[300, 520, 1], [620, 520, 1], [940, 520, 1]].forEach((p, i) => w += set(p[0], p[1], p[2], 0.15 + i * 0.3));
  w += `<g transform="translate(640 470)"><ellipse cx="0" cy="34" rx="50" ry="12" fill="#00000018"/><path d="M-40 -6 q0 40 40 40 q40 0 40 -40z" fill="#5d6a70"/><ellipse cx="0" cy="-6" rx="40" ry="10" fill="#748188"/><path d="M38 0 q26 -4 30 -22" stroke="#5d6a70" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M-28 -10 q28 -44 56 0" stroke="#3f474d" stroke-width="5" fill="none"/></g>`;
  return cam(w, 640, 360, 1.02);
}

// ================= SCENE 4 : 挨拶・身だしなみ・マナー =================
function s4(t) {
  const off = t * 105;
  let bg = `<rect x="-100" y="0" width="3400" height="720" fill="#e6e8e3"/><rect x="-100" y="610" width="3400" height="140" fill="url(#gFloor)"/><rect x="-100" y="606" width="3400" height="6" fill="#c2c8c3"/><rect x="-100" y="676" width="3400" height="9" fill="#e3c44f"/>`;
  for (let i = 0; i < 12; i++) bg += lamp(60 + i * 300, 44, 190);
  const locker = x => { let s = `<rect x="${x}" y="150" width="86" height="456" fill="#aebcc4" stroke="#8d9ba3" stroke-width="2"/><rect x="${x + 66}" y="360" width="7" height="34" rx="3" fill="#69757c"/>`; for (let j = 0; j < 3; j++) s += `<rect x="${x + 22}" y="${186 + j * 12}" width="42" height="4" rx="2" fill="#8d9ba3"/>`; return s + `<rect x="${x + 28}" y="236" width="30" height="18" rx="2" fill="#f4f4ee"/>`; };
  for (let i = 0; i < 9; i++) bg += locker(100 + i * 88);
  // tool wall
  bg += `<rect x="960" y="170" width="640" height="300" fill="#c9b48d" stroke="#a88f63" stroke-width="4"/>`;
  for (let i = 0; i < 7; i++) {
    const x = 1010 + i * 86;
    bg += `<rect x="${x - 5}" y="210" width="10" height="${90 + (i % 3) * 22}" rx="4" fill="#6b747a"/><circle cx="${x}" cy="208" r="13" fill="none" stroke="#6b747a" stroke-width="8"/>`;
    bg += `<rect x="${x - 6}" y="372" width="12" height="70" rx="5" fill="${i % 2 ? '#c8483c' : '#3d6fa3'}"/><rect x="${x - 3}" y="330" width="6" height="46" fill="#7d868c"/>`;
  }
  bg += `<rect x="960" y="500" width="640" height="14" fill="#7d868c"/>`;
  for (let i = 0; i < 7; i++) bg += `<rect x="${974 + i * 90}" y="520" width="78" height="84" rx="4" fill="${['#5f7f9a', '#d6a548', '#7f9a72'][i % 3]}"/><rect x="${984 + i * 90}" y="528" width="58" height="12" rx="2" fill="#00000022"/>`;
  bg += `<rect x="960" y="500" width="10" height="106" fill="#6a7379"/><rect x="1590" y="500" width="10" height="106" fill="#6a7379"/>`;
  for (let i = 0; i < 9; i++) bg += locker(1680 + i * 88);
  bg += win(2520, 200, 300, 220, 'url(#gDay)', 2);
  let w = `<g transform="translate(${R(-off)} 0)">${bg}</g>`;
  const meet = bump(t, 2.3, 3.2, 4.3);
  const wx = 1390 - t * 235;
  w += person({ kind: 'worker', x: wx, y: 634, s: 1.22, fx: -1, walk: t * 8.2, bow: 15 * bump(t, 2.5, 3.3, 4.3), nod: 6 * meet, smile: t > 2.6 && t < 5 });
  w += person({ kind: 'new', x: 520 + Math.sin(t * 0.7) * 6, y: 652, s: 1.3, walk: t * 8.6, bow: 16 * meet, nod: 6 * meet, smile: t > 2.4 });
  return cam(w, 600 + Math.sin(t * 1.2) * 4, 372 + Math.sin(t * 8.6) * 1.5, 1.1);
}

// ================= SCENE 5 : 報告・連絡・相談 =================
function s5(t) {
  let w = `<rect width="1280" height="720" fill="#e4e7e2"/>` + win(40, 40, 420, 150, 'url(#gDay)', 3) + win(560, 40, 420, 150, 'url(#gDay)', 3) + lamp(1040, 30, 200);
  w += `<path d="M40 196 h420 l220 524 h-420z" fill="#fff" opacity=".16"/>`;
  // background shelf + machine (soft)
  w += `<g opacity=".7"><rect x="70" y="330" width="170" height="390" rx="6" fill="#8fa29a"/><rect x="110" y="250" width="90" height="110" fill="#7c8f87"/><rect x="140" y="360" width="30" height="80" fill="#6a7379"/><rect x="60" y="440" width="190" height="18" fill="#6a7379"/>`;
  w += `<rect x="330" y="300" width="330" height="10" fill="#7d868c"/><rect x="330" y="430" width="330" height="10" fill="#7d868c"/>`;
  for (let i = 0; i < 4; i++) w += `<rect x="${342 + i * 80}" y="240" width="66" height="60" rx="4" fill="${['#5f7f9a', '#d6a548', '#7f9a72', '#5f7f9a'][i]}"/><rect x="${342 + i * 80}" y="370" width="66" height="60" rx="4" fill="${['#d6a548', '#7f9a72', '#5f7f9a', '#d6a548'][i]}"/>`;
  w += `</g>`;
  const nx = lerp(110, 520, seg(t, 0, 2.3)), walking = t < 2.3;
  const turn = Math.cos(Math.PI * seg(t, 2.1, 2.7)); // 1 -> -1
  const point = seg(t, 4.3, 5.0) * (1 - seg(t, 7.5, 8.2));
  const writing = seg(t, 3.6, 4.2);
  w += person({ kind: 'new', x: nx, y: 810, s: 1.7, walk: walking ? nx / 38 : undefined,
    bow: 10 * bump(t, 2.4, 2.9, 3.5), nod: 13 * writing * (1 - 0.8 * bump(t, 5.3, 5.8, 6.4)), smile: t > 6.6,
    hA: { w: [nx + 78 + (writing ? Math.sin(t * 17) * 5 * writing : 0), lerp(452, 436, writing) + (writing ? Math.sin(t * 23) * 2 : 0)] },
    hB: writing > 0.01 ? { w: [nx + 62, 448] } : null });
  // memo pad + pen (in front of her hands)
  const mx = nx + 66, my = lerp(452, 446, writing);
  let memo = `<g transform="translate(${R(mx)} ${R(my)}) rotate(-16)"><rect x="-6" y="-34" width="46" height="60" rx="3" fill="#fbfaf5" stroke="#c9c6bb" stroke-width="2"/><rect x="-6" y="-34" width="46" height="9" fill="#6f8fb3"/></g>`;
  // bench
  let bench = `<rect x="880" y="500" width="420" height="24" fill="url(#gWood)"/><rect x="880" y="524" width="420" height="10" fill="#a48a63"/><rect x="900" y="534" width="400" height="200" fill="#8b949a"/>`;
  bench += `<rect x="930" y="474" width="70" height="26" rx="4" fill="#5d666c"/><rect x="944" y="452" width="42" height="24" rx="3" fill="url(#gMetal)"/><rect x="1060" y="470" width="150" height="30" rx="4" fill="#5f7f9a"/>` + partCyl(1090, 474) + partCyl(1120, 474) + partCyl(1150, 474);
  const work = t < 2.1 ? 1 : 0;
  const tr = person({ kind: 'trainer', x: 800, y: 810, s: 1.7, fx: turn, smile: t > 2.8,
    nod: 9 * bump(t, 2.9, 3.3, 3.8) + 8 * bump(t, 6.5, 6.9, 7.4) + (work ? 8 : 0),
    hA: work ? { w: [930 + Math.sin(t * 9) * 8, 462] } : (point > 0.01 ? { w: [lerp(810, 948 + Math.sin(t * 5) * 6, point), lerp(560, 458, point)] } : null),
    hB: work ? { w: [968, 466] } : null });
  w += tr + bench + memo;
  if (writing > 0.5) w += `<path d="M${R(nx + 84 + Math.sin(t * 17) * 5)} ${R(430 + Math.sin(t * 23) * 2)} l10 -26" stroke="#2f5d8f" stroke-width="5" stroke-linecap="round"/>`;
  return cam(w, 640, 360, 1.0);
}

// ================= SCENE 6 : 電話・メール・情報の取り扱い =================
function s6(t) {
  let w = `<rect x="-100" width="1500" height="720" fill="#eae7df"/><rect x="-100" y="650" width="1500" height="100" fill="#b9b5aa"/><rect x="-100" y="646" width="1500" height="5" fill="#a6a297"/>`;
  w += win(60, 80, 330, 300, 'url(#gDay)', 2);
  for (let i = 0; i < 12; i++) w += `<rect x="60" y="${92 + i * 25}" width="330" height="5" fill="#fff" opacity=".75"/>`;
  w += `<path d="M60 386 h330 l230 334 h-330z" fill="#fff8e6" opacity=".3"/>` + lamp(560, 34, 220);
  // back shelf with binders
  w += `<rect x="880" y="130" width="330" height="230" fill="#c9c2b2"/><rect x="880" y="240" width="330" height="8" fill="#a39c8c"/>`;
  for (let i = 0; i < 9; i++) w += `<rect x="${892 + i * 34}" y="146" width="28" height="94" fill="${['#6f8fb3', '#8aa38b', '#d8d4c8'][i % 3]}"/><rect x="${892 + i * 34}" y="258" width="28" height="94" fill="${['#d8d4c8', '#6f8fb3', '#c08a6a'][i % 3]}"/>`;
  w += plant(1250, 650, 1.2);
  // chair
  w += `<rect x="478" y="388" width="18" height="170" rx="8" fill="#56616b"/><rect x="484" y="548" width="130" height="18" rx="8" fill="#56616b"/><rect x="540" y="566" width="10" height="64" fill="#3f474d"/><path d="M490 648 q55 -30 110 0" stroke="#3f474d" stroke-width="9" fill="none" stroke-linecap="round"/>`;
  const reach = seg(t, 0.4, 1.3), lift = seg(t, 1.5, 2.6);
  const rx = lerp(712, 574, lift), ry = lerp(394, 344, lift), ra = lerp(0, 50, lift);
  const hand = reach < 1 ? [lerp(600, 712, reach), lerp(470, 394, reach)] : [rx + lerp(0, 6, lift), ry + lerp(0, 14, lift)];
  const wr = seg(t, 3.0, 3.6);
  // desk (behind the sitter's arms, in front of legs)
  const desk = `<rect x="590" y="430" width="610" height="16" fill="#e2d2b0"/><rect x="590" y="446" width="610" height="16" fill="#bfa97f"/><rect x="606" y="462" width="14" height="190" fill="#8a8f93"/>` +
    `<rect x="990" y="462" width="190" height="190" fill="#c9c2b2"/><rect x="1000" y="470" width="170" height="52" rx="3" fill="#d8d2c4"/><rect x="1000" y="590" width="170" height="54" rx="3" fill="#d8d2c4"/><rect x="1066" y="490" width="40" height="7" rx="3" fill="#8a8f93"/><rect x="1066" y="610" width="40" height="7" rx="3" fill="#8a8f93"/>` +
    // open middle drawer with neatly filed folders
    `<rect x="1000" y="528" width="170" height="56" fill="#6e685c"/>` + [0, 1, 2, 3, 4, 5].map(i => `<rect x="${976 + i * 26}" y="${520}" width="22" height="34" rx="2" fill="${['#e6d9a8', '#a9c3d6', '#e6d9a8', '#c7d9b0', '#e6d9a8', '#a9c3d6'][i]}"/>`).join('') +
    `<rect x="966" y="544" width="176" height="56" rx="3" fill="#ddd7c9" stroke="#b3ac9c" stroke-width="2"/><rect x="1034" y="566" width="40" height="7" rx="3" fill="#8a8f93"/>`;
  const stuff = `<path d="M600 430 l52 0 l-8 -12 l-50 0z" fill="#f4dc6b"/>` +
    `<path d="M664 430 h112 l-8 -30 h-90z" fill="#e9e7e1" stroke="#b9b6ad" stroke-width="2"/><rect x="730" y="404" width="34" height="14" rx="2" fill="#c9d9cc"/>` +
    [0, 1, 2].map(i => [0, 1, 2].map(j => `<circle cx="${736 + i * 10}" cy="${421 + j * 0}" r="0"/>`).join('')).join('') +
    `<rect x="842" y="423" width="124" height="7" rx="2" fill="#aeb4b9"/><path d="M962 424 L1000 336 l7 3 L970 428z" fill="#8d949a"/>` +
    `<rect x="1090" y="396" width="30" height="34" rx="3" fill="#6f8296"/><path d="M1098 396 l-4 -30 M1106 396 l2 -34 M1112 396 l8 -28" stroke="#3d4349" stroke-width="4" stroke-linecap="round"/>`;
  const sitter = person({ kind: 'new', x: 548, y: 690, s: 1.4, sit: 60, bow: lerp(3, 12, reach) * (1 - lift) + 5 * wr,
    nod: 7 * bump(t, 4.3, 4.7, 5.2) + 7 * bump(t, 6.2, 6.6, 7.1) + 4 * wr,
    hB: { w: hand }, hA: { w: [lerp(598, 628 + Math.sin(t * 15) * 5, wr), lerp(424, 418 + Math.sin(t * 21) * 2, wr)] } });
  const receiver = `<path d="M736 418 Q${R(lerp(730, 640, lift))} ${R(lerp(440, 470, lift))} ${R(rx + lerp(-30, 34, lift))} ${R(ry + lerp(6, 42, lift))}" stroke="#55595e" stroke-width="3" fill="none" stroke-dasharray="3 3"/>` +
    `<g transform="translate(${R(rx)} ${R(ry)}) rotate(${R(ra)})"><path d="M-46 -8 q0 -8 10 -8 h72 q10 0 10 8 v8 q0 6 -8 6 h-10 q-6 0 -8 -6 h-40 q-2 6 -8 6 h-10 q-8 0 -8 -6z" fill="#f4f2ec" stroke="#b9b6ad" stroke-width="2"/></g>`;
  // order: chair, legs+body, desk (hides thighs), items, then the front arm & receiver
  // receiver sits behind her (far hand, far ear) so the face stays visible
  w += receiver + sitter + desk + stuff;
  if (wr > 0.5) w += `<path d="M${R(630 + Math.sin(t * 15) * 5)} ${R(414 + Math.sin(t * 21) * 2)} l-14 -30" stroke="#2f5d8f" stroke-width="5" stroke-linecap="round"/>`;
  const k1 = seg(t, 1.0, 4.2), k2 = seg(t, 4.0, 7.6);
  return cam(w, lerp(lerp(700, 610, k1), 640, k2), lerp(lerp(405, 370, k1), 360, k2), lerp(lerp(2.5, 1.65, k1), 1.0, k2));
}

// ================= SCENE 7 : 安全・健康・相談窓口 =================
function s7(t) {
  let w = `<rect x="-100" width="1700" height="720" fill="#e5e8e3"/><rect x="-100" y="640" width="1700" height="120" fill="url(#gFloor)"/><rect x="-100" y="636" width="1700" height="6" fill="#c2c8c3"/>`;
  for (let i = 0; i < 22; i++) w += `<path d="M${-60 + i * 76} 690 h38 l-14 16 h-38z" fill="#e3c44f"/><path d="M${-22 + i * 76} 690 h38 l-14 16 h-38z" fill="#3d4349"/>`;
  w += lamp(200, 36, 240) + lamp(820, 36, 240);
  // doorway into the shop floor + green-cross board
  w += `<rect x="1010" y="150" width="250" height="490" fill="#cfd8d3"/><rect x="1010" y="150" width="250" height="490" fill="none" stroke="#7d868c" stroke-width="10"/><path d="M1040 640 L1100 150 h90 L1130 640z" fill="#fff" opacity=".3"/>`;
  w += `<rect x="830" y="150" width="110" height="110" rx="6" fill="#fbfbf8" stroke="#b9c0bb" stroke-width="3"/><path d="M873 170 h24 v23 h23 v24 h-23 v23 h-24 v-23 h-23 v-24 h23z" fill="#3f9a5c"/>`;
  // shelf
  w += `<rect x="110" y="100" width="640" height="540" fill="#d9dcd6"/>`;
  const cols = [190, 315, 440, 565, 690];
  const taken = t > 1.4;
  cols.forEach((x, i) => {
    w += helmet(x - 4, 190) + (i === 4 && taken ? '' : helmet(x - 4, 320)) + goggles(x, 440);
    w += `<rect x="${x - 44}" y="488" width="88" height="72" rx="5" fill="${i % 2 ? '#5f7f9a' : '#7f9a72'}"/><rect x="${x - 30}" y="500" width="60" height="12" rx="3" fill="#00000022"/>`;
  });
  for (const y of [190, 320, 440, 560]) w += `<rect x="110" y="${y}" width="640" height="12" fill="#7d868c"/>`;
  w += `<rect x="104" y="92" width="14" height="552" fill="#6a7379"/><rect x="742" y="92" width="14" height="552" fill="#6a7379"/><rect x="104" y="92" width="652" height="12" fill="#6a7379"/>`;
  const NX = 822, HY = 670;
  const reach = seg(t, 0.5, 1.4), carry = seg(t, 1.4, 2.8), worn = t >= 2.8, down = seg(t, 3.0, 3.7);
  const turn = -Math.cos(Math.PI * seg(t, 3.7, 4.3)); // -1 -> 1
  const headX = NX - 4, headTop = HY - 352 * 1.3 + 44;
  let hx = lerp(686, headX - 2, carry), hy = lerp(320, headTop + 10, carry) - Math.sin(carry * Math.PI) * 30;
  let hA = null, hB = null;
  if (!worn) { hA = { w: [lerp(NX - 20, hx + 22, reach), lerp(HY - 200, hy - 16, reach)] }; hB = { w: [lerp(NX - 30, hx - 26, reach), lerp(HY - 200, hy - 12, reach)] }; }
  else if (down < 1) { hA = { w: [lerp(headX + 24, NX - 12, down), lerp(headTop, HY - 206, down)] }; hB = { w: [lerp(headX - 26, NX - 2, down), lerp(headTop, HY - 206, down)] }; }
  const tx = lerp(1420, 972, seg(t, 2.4, 4.6)), twalk = t > 2.4 && t < 4.6;
  const chk = seg(t, 4.9, 5.6) * (1 - seg(t, 6.4, 7.0));
  const chin = [NX + 26, HY - 286 * 1.3];
  w += person({ kind: 'trainer', x: tx, y: 676, s: 1.3, fx: -1, walk: twalk ? tx / 30 : undefined, smile: t > 6.2,
    nod: 10 * bump(t, 6.7, 7.1, 7.7) + 4 * chk,
    hA: chk > 0.01 ? { w: [lerp(tx - 14, chin[0] + 10 + Math.sin(t * 9) * 3 * chk, chk), lerp(470, chin[1] + 6 + Math.sin(t * 9) * 3, chk)] } : null });
  w += person({ kind: 'new', x: NX, y: HY, s: 1.3, fx: turn, helmet: worn, hA, hB, smile: t > 6.6,
    nod: -6 * chk + 9 * bump(t, 7.0, 7.4, 7.9), bow: 6 * bump(t, 7.0, 7.4, 7.9) });
  if (taken && !worn) w += helmet(hx, hy + 26);
  const k = seg(t, 2.4, 6.2);
  return cam(w, lerp(640, 830, k), lerp(360, 318, k), lerp(1.0, 1.42, k));
}

// ================= SCENE 8 : 最初の1週間と連絡先 =================
function s8(t) {
  let w = `<rect x="-100" width="1500" height="720" fill="#e9dccb"/>`;
  for (let i = 0; i < 4; i++) {
    const x = 70 + i * 292;
    w += win(x, 110, 262, 280, 'url(#gEve)', 2);
    w += `<path d="M${x} 390 v-40 h50 v-26 h70 v36 h60 v-20 h82 v50z" fill="#6b5148" opacity=".55"/>`;
  }
  w += `<circle cx="300" cy="318" r="150" fill="url(#gSun)"/><circle cx="300" cy="318" r="26" fill="#fff6dc"/>`;
  w += `<rect x="-100" y="640" width="1500" height="120" fill="#b8a48d"/><rect x="-100" y="636" width="1500" height="5" fill="#a08d77"/>`;
  w += lamp(120, 40, 220) + lamp(540, 40, 220) + lamp(960, 40, 220);
  // side furniture
  w += `<rect x="-40" y="470" width="300" height="16" fill="#d9c6a0"/><rect x="-30" y="486" width="12" height="160" fill="#8a8f93"/><rect x="238" y="486" width="12" height="160" fill="#8a8f93"/><rect x="60" y="388" width="120" height="76" rx="5" fill="#4b5158"/><rect x="112" y="464" width="16" height="8" fill="#4b5158"/>`;
  w += `<rect x="150" y="520" width="80" height="14" rx="6" fill="#56616b"/><rect x="186" y="534" width="8" height="90" fill="#3f474d"/><rect x="222" y="440" width="12" height="90" rx="6" fill="#56616b"/>`;
  w += `<rect x="1030" y="330" width="250" height="316" fill="#c9bca6"/>`;
  for (let r = 0; r < 3; r++) { w += `<rect x="1030" y="${426 + r * 106}" width="250" height="8" fill="#a39683"/>`; for (let i = 0; i < 7; i++) w += `<rect x="${1042 + i * 33}" y="${342 + r * 106}" width="27" height="84" fill="${['#6f8fb3', '#d8d4c8', '#8aa38b', '#c08a6a'][(i + r) % 4]}"/>`; }
  w += plant(345, 640, 1.15);
  // warm shafts
  for (let i = 0; i < 4; i++) { const x = 70 + i * 292; w += `<path d="M${x} 394 h262 l300 330 h-262z" fill="#ffc98a" opacity=".2"/>`; }
  const nodB = bump(t, 1.4, 1.9, 2.5), bow = 22 * bump(t, 3.0, 3.8, 4.7), show = seg(t, 4.7, 5.6);
  const cx = lerp(650, 596, show), cy = lerp(452, 418, show);
  w += person({ kind: 'trainer', view: 'front', x: 660, y: 676, s: 1.3, smile: true, nod: 6 * show, hA: { w: [cx + 34, cy + 6] }, hB: { w: [cx - 30, cy + 12] } });
  // desk
  w += `<rect x="520" y="470" width="290" height="16" fill="#dcc9a3"/><rect x="520" y="486" width="290" height="12" fill="#b9a379"/><rect x="536" y="498" width="12" height="150" fill="#8a8f93"/><rect x="782" y="498" width="12" height="150" fill="#8a8f93"/><rect x="700" y="452" width="80" height="18" rx="3" fill="#d8d4c8"/><rect x="706" y="446" width="68" height="8" rx="2" fill="#a9c3d6"/>`;
  // papers held by trainer
  w += `<g transform="translate(${R(cx)} ${R(cy)}) rotate(${R(lerp(-4, -16, show))})"><rect x="-40" y="-52" width="80" height="104" rx="3" fill="#8a6f4c"/><rect x="-35" y="-44" width="70" height="92" fill="#fbfaf5"/><rect x="-14" y="-58" width="28" height="12" rx="3" fill="#8a8f93"/>` +
    [0, 1, 2, 3, 4].map(i => `<rect x="-27" y="${-30 + i * 14}" width="${[54, 44, 54, 36, 48][i]}" height="4" rx="2" fill="#c3c7cc"/>`).join('') + `</g>`;
  w += person({ kind: 'boss', x: 900, y: 680, s: 1.3, fx: -1, smile: t > 1.2, bow: 7 * nodB + 4 * bump(t, 3.6, 4.1, 4.8), nod: 11 * nodB + 6 * bump(t, 3.6, 4.1, 4.8), hA: [-14, -150], hB: [-26, -150] });
  w += person({ kind: 'new', x: 424, y: 680, s: 1.3, smile: t > 2.4, bow, nod: bow * 0.3 + 8 * show,
    hA: show > 0.01 ? { w: [lerp(434, 548, show), lerp(470, 436, show)] } : (bow > 1 ? [14, -168] : null), hB: bow > 1 ? [8, -168] : null });
  w += `<rect x="-100" width="1500" height="760" fill="#ff9a48" opacity=".1"/>`;
  const k = seg(t, 0.8, 7.6);
  return cam(w, lerp(660, 640, k), lerp(372, 360, k), lerp(1.55, 1.0, k));
}

const SC = [s1, s2, s3, s4, s5, s6, s7, s8];
function frameSVG(T) {
  const total = SCENE_LEN * SCENES; T = clamp(T, 0, total - 0.001);
  const i = Math.floor(T / SCENE_LEN), t = T - i * SCENE_LEN;
  const fade = Math.max(1 - seg(T, 0, 0.6), seg(T, total - 0.8, total - 0.05));
  return DEFS + `<g clip-path="url(#frame)"><rect width="${W}" height="${H}" fill="#111"/>${SC[i](t)}<rect width="${W}" height="${H}" fill="url(#gVig)"/>` +
    (fade > 0.001 ? `<rect width="${W}" height="${H}" fill="#000" opacity="${R(fade * 100) / 100}"/>` : '') + `</g>`;
}
if (typeof window !== 'undefined') {
  window.renderAt = T => { document.getElementById('stage').innerHTML = frameSVG(T); };
  window.FILM = { total: SCENE_LEN * SCENES, sceneLen: SCENE_LEN };
}
