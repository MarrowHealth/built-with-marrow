'use strict';
// Annulus — four plain-language views (today, recent, changes, history) built from pluggable cards.
// Every card leads with a one-sentence conclusion; charts are pure SVG (CSP forbids inline styles).
(() => {
  const app = document.getElementById('app');
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const WD_MON = ['一', '二', '三', '四', '五', '六', '日'];
  const MEAL_NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐', snacks: '加餐', other: '其他' };
  const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
  const STAGE_NAMES = { deep: '深睡', core: '核心睡眠', rem: '快速眼动', awake: '清醒', asleep: '睡眠' };
  const SPORT_NAMES = {
    walking: '步行', strength: '力量训练', traditionalstrengthtraining: '力量训练',
    functionalstrengthtraining: '功能力量', running: '跑步', cycling: '骑行',
    elliptical: '椭圆机', swimming: '游泳', hiking: '徒步', climbing: '攀岩',
    stairclimbing: '爬楼梯', stairs: '爬楼梯', highintensityintervaltraining: 'HIIT',
    yoga: '瑜伽', badminton: '羽毛球', basketball: '篮球', tennis: '网球',
    tabletennis: '乒乓球', rowing: '划船', coretraining: '核心训练',
    flexibility: '拉伸', cooldown: '放松', mixedcardio: '混合有氧',
    play: '趣味运动', workout: '综合训练', other: '其他',
  };
  const SPORT_COLORS = ['#E8475F', '#1F8A63', '#1A9BD7', '#C7811F', '#6A5ACD', '#14A08F', '#8DBE2E', '#94A3B8'];
  const LAYOUT_STORAGE_KEY = 'annulus.layout.v3';

  const TABS = [
    { id: 'today', label: '今日' },
    { id: 'rhythm', label: '近期' },
    { id: 'trends', label: '洞察' },
    { id: 'archive', label: '岁月' },
  ];

  // ---------- runtime state
  let csrf = '';
  let data = null;
  let activeTab = readHashTab();
  let selectedDay = null;
  let calMonth = null;
  let calOverlay = 'rings';
  let calSelectedDay = null;
  let sleepSpan = 14;
  let energySpan = 14;
  let bodyRange = 180;
  let heatYear = null;
  let heatMetric = 'active_energy';
  let seasonMetric = 'steps';
  let workoutEraMode = 'hours';
  let mealsExpanded = false;
  let openPopover = null; // 'fresh' | 'account' | null
  let composerOpen = false;
  let chartSeq = 0;
  const charts = new Map();

  // ---------- basic helpers
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const ms = (iso) => {
    if (!iso) return 0;
    if (iso.length <= 7) return Date.parse(iso + '-01T00:00:00Z');
    if (iso.length <= 10) return Date.parse(iso + 'T12:00:00Z');
    return Date.parse(iso.replace(' ', 'T') + ':00Z');
  };
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const md = (iso) => (iso && iso.length >= 10 ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : iso || '');
  const cn = (iso) => (iso && iso.length >= 10 ? `${+iso.slice(5, 7)}月${+iso.slice(8, 10)}日` : iso || '');
  const wd = (iso) => WD[new Date(Date.parse(iso + 'T12:00:00Z')).getUTCDay()];
  const hm = (h) => {
    if (h == null || Number.isNaN(h)) return '–';
    const m = Math.round(h * 60);
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  };
  const clockFromMin = (m) => {
    if (m == null || Number.isNaN(m)) return '–';
    const norm = ((Math.round(m) % 1440) + 1440) % 1440;
    return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
  };
  const byDay = (pairs) => Object.fromEntries((pairs || []).map(([d, v]) => [d, v]));
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const quantile = (sorted, q) => {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
  };
  const sportLabel = (raw) => SPORT_NAMES[String(raw || '').toLowerCase()] || raw || '运动';
  const signed = (v, d = 0) => {
    if (v == null || Number.isNaN(v)) return '–';
    const r = Number(Math.abs(v).toFixed(d));
    return r === 0 ? '±0' : `${v > 0 ? '+' : '−'}${fmt(r, d)}`;
  };
  // Numbers inside a card headline use the numeral face; the sentence itself stays plain.
  const N = (text) => `<b class="n">${esc(text)}</b>`;
  const emptyNote = (text) => `<p class="empty-note">${esc(text)}</p>`;
  const weekdayIdx = (iso) => (new Date(Date.parse(iso + 'T12:00:00Z')).getUTCDay() + 6) % 7;
  const mealKey = (m) => (m === 'snacks' ? 'snack' : MEAL_NAMES[m] ? m : 'other');
  const UNIT_CN = { bpm: '次/分', ms: '毫秒', kg: '公斤', 'km/h': '公里/时', 'mL/kg·min': '' };
  const unitCn = (u) => (u in UNIT_CN ? UNIT_CN[u] : u);
  const avgWhere = (pairs, from, to) => {
    const vals = (pairs || []).filter(([d, v]) => d >= from && d <= to && v != null).map(([, v]) => v);
    return vals.length ? mean(vals) : null;
  };

  function readHashTab() {
    const h = (location.hash || '').replace('#', '');
    return TABS.some((t) => t.id === h) ? h : 'today';
  }

  function chartWidth(span) {
    const vw = document.documentElement.clientWidth;
    const pad = Math.min(28, Math.max(14, vw * 0.03));
    const inner = Math.min(1280, vw) - 2 * pad;
    if (vw >= 900 && span === 'half') return Math.max(300, Math.round((inner - 16) / 2 - 44));
    return Math.max(300, Math.round(inner - 48));
  }

  function scale(d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    return (v) => r0 + (v - d0) * k;
  }

  function niceTicks(lo, hi, n = 4) {
    const span = hi - lo || 1;
    const step0 = span / n;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  function movingAvg(points, days) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const t = points[i][0];
      let s = 0, n = 0;
      for (let j = i; j >= 0 && points[j][0] > t - days * 864e5; j--) {
        s += points[j][1];
        n++;
      }
      out.push([t, s / n]);
    }
    return out;
  }

  function ewmaSeries(points, alpha = 0.16) {
    if (!points.length) return [];
    let ema = points[0][1];
    return points.map(([t, v], idx) => {
      ema = idx === 0 ? v : alpha * v + (1 - alpha) * ema;
      return [t, ema];
    });
  }

  // ---------- API
  async function api(path, body) {
    const init = { credentials: 'same-origin', headers: {} };
    if (body) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      if (csrf) init.headers['X-CSRF-Token'] = csrf;
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    let json = {};
    try { json = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) {
      const e = new Error(json.error || `请求失败（${res.status}）`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  // ---------- Brand icon & Tab icons
  const ICON_BRAND = `<svg viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="14" fill="#F4EDF7"/>
    <circle cx="32" cy="32" r="25" fill="#BCA0D6"/>
    <circle cx="32" cy="32" r="17.6" fill="#8A70BA"/>
    <circle cx="32" cy="32" r="10.4" fill="#43397E"/>
    <path d="M32 32h8l2-2 2.8 8 3.2-10.4 2.8 4.4H54" fill="none" stroke="#2D245A" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const TAB_ICONS = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/></svg>',
    rhythm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h2v2H8zm5 0h3"/></svg>',
    trends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 3 5-7"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h8M8 11h6"/></svg>',
  };

  // ---------- Reusable Pure-SVG Visuals (Zero inline HTML style attributes!)
  function svgHBar(ratio, color, h = 7) {
    const pct = Math.max(0, Math.min(100, (ratio || 0) * 100));
    const track = css('--faint');
    return `<svg viewBox="0 0 200 ${h}" preserveAspectRatio="none" width="100%" height="${h}" role="img" aria-hidden="true">
      <rect x="0" y="0" width="200" height="${h}" rx="${h / 2}" fill="${track}" fill-opacity="0.45"/>
      ${pct > 0 ? `<rect x="0" y="0" width="${(pct * 2).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : ''}
    </svg>`;
  }

  function svgMiniRings(moveR, exR, standR, size = 24) {
    const c = size / 2;
    const specs = [
      [c * 0.78, Math.max(2, size * 0.115), moveR, css('--ring-move')],
      [c * 0.53, Math.max(2, size * 0.115), exR, css('--ring-ex')],
      [c * 0.28, Math.max(2, size * 0.115), standR, css('--ring-stand')],
    ];
    let inner = '';
    for (const [r, sw, ratio, col] of specs) {
      const circ = 2 * Math.PI * r;
      const pct = Math.max(0, Math.min(1, ratio || 0));
      const dash = pct * circ;
      inner += `<circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="${col}" stroke-opacity="0.2" stroke-width="${sw.toFixed(2)}"/>`;
      if (pct > 0.01) {
        inner += `<circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="${col}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
      }
    }
    return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true">${inner}</svg>`;
  }

  function svgConcentricRings(rings, size = 210) {
    const c = size / 2;
    let body = '';
    rings.forEach((ring, idx) => {
      const r = 84 - idx * 24;
      const sw = 18;
      const circ = 2 * Math.PI * r;
      const pct = Math.max(0, ring.ratio || 0);
      const lap1 = Math.min(1, pct) * circ;
      const lap2 = pct > 1 ? Math.min(1, pct - 1) * circ : 0;
      body += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ring.color}" stroke-opacity="0.18" stroke-width="${sw}"/>`;
      if (lap1 > 0.5) {
        body += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ring.color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${lap1.toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
      }
      if (lap2 > 0.5) {
        body += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${css('--hero-ink')}" stroke-opacity="0.3" stroke-width="${sw * 0.48}" stroke-linecap="round" stroke-dasharray="${lap2.toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
      }
    });
    const movePct = Math.round((rings[0].ratio || 0) * 100);
    body += `<text x="${c}" y="${c + 6}" text-anchor="middle" fill="${css('--hero-ink')}" font-family="Fraunces, serif" font-weight="600" font-size="34">${movePct}%</text>`;
    body += `<text x="${c}" y="${c + 22}" text-anchor="middle" fill="${css('--hero-ink')}" fill-opacity="0.6" font-size="10">活动环</text>`;
    return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="活动三环">${body}</svg>`;
  }

  function svgBudgetArc(kcal, target) {
    const W = 170, H = 128, cx = 85, cy = 84, r = 64, sw = 14;
    const startA = 145, sweep = 250;
    const polar = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    const arcPath = (a0, a1) => {
      const [x0, y0] = polar(a0);
      const [x1, y1] = polar(a1);
      const large = a1 - a0 > 180 ? 1 : 0;
      return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    };
    const ratio = target ? Math.max(0, Math.min(1.15, kcal / target)) : 0;
    const over = kcal > target;
    const col = over ? css('--bad') : css('--sys-food');
    const endA = startA + Math.min(1, ratio) * sweep;
    const left = target - kcal;
    const centerSub = left >= 0 ? `余 ${fmt(left)}` : `超 ${fmt(-left)}`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="热量预算仪表">
      <path d="${arcPath(startA, startA + sweep)}" fill="none" stroke="${css('--faint')}" stroke-opacity="0.4" stroke-width="${sw}" stroke-linecap="round"/>
      ${ratio > 0.01 ? `<path d="${arcPath(startA, endA)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${css('--ink')}" font-family="Fraunces, serif" font-weight="600" font-size="36">${fmt(kcal)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="${over ? css('--bad') : css('--muted')}" font-size="12" font-weight="600">${esc(centerSub)} 千卡</text>
      <text x="26" y="118" fill="${css('--muted')}" font-size="10.5">0</text>
      <text x="144" y="118" text-anchor="end" fill="${css('--muted')}" font-size="10.5">${fmt(target)}</text>
    </svg>`;
  }

  function svgLineChart({
    span = 'half', series, target, targetLabel, height = 175,
    yfmt = (v) => fmt(v), xfmt, tipfmt, pad = 0.09, xTicks, area = false,
  }) {
    const W = chartWidth(span), H = height, L = 40, R = 10, T = 12, B = 24;
    const all = series.flatMap((s) => [
      ...(s.pts || []).map((p) => p[1]),
      ...(s.band || []).flatMap((b) => [b[1], b[2]]),
    ]).filter((v) => v != null);
    if (!all.length) return '<p class="empty-note">这段时间还没有记录。</p>';
    let lo = Math.min(...all, target ?? Infinity);
    let hi = Math.max(...all, target ?? -Infinity);
    const gap = (hi - lo || Math.abs(hi) || 1) * pad;
    lo -= gap;
    hi += gap;
    const xs = series.flatMap((s) => [...(s.pts || []), ...(s.band || [])].map((p) => p[0]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const x = scale(x0, x1 === x0 ? x0 + 1 : x1, L, W - R);
    const y = scale(lo, hi, H - B, T);
    const id = `c${++chartSeq}`;
    let g = '';
    for (const t of niceTicks(lo, hi, 4)) {
      g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`;
      g += `<text class="ax" x="${L - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(yfmt(t))}</text>`;
    }
    if (target != null) {
      const ty = y(target).toFixed(1);
      g += `<line class="tg" x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}"/>`;
      if (targetLabel) g += `<text class="ax" x="${W - R}" y="${ty - 4}" text-anchor="end">${esc(targetLabel)}</text>`;
    }
    const ticks = xTicks ? xTicks(x0, x1) : (x0 === x1 ? [x0] : [x0, (x0 + x1) / 2, x1]);
    ticks.forEach((t, i) => {
      const anchor = i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle';
      g += `<text class="ax" x="${x(t).toFixed(1)}" y="${H - 5}" text-anchor="${anchor}">${esc(xfmt(t))}</text>`;
    });
    series.forEach((s, si) => {
      if (s.band && s.band.length > 1) {
        const top = s.band.map((b) => `${x(b[0]).toFixed(1)},${y(b[2]).toFixed(1)}`).join(' ');
        const bot = s.band.slice().reverse().map((b) => `${x(b[0]).toFixed(1)},${y(b[1]).toFixed(1)}`).join(' ');
        g += `<polygon points="${top} ${bot}" fill="${s.color}" fill-opacity="0.16"/>`;
      }
      if (area && s.area && s.pts.length > 1) {
        const gid = `${id}_g${si}`;
        g += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0.02"/></linearGradient></defs>`;
        const poly = `${x(s.pts[0][0]).toFixed(1)},${H - B} ` + s.pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ') + ` ${x(s.pts[s.pts.length - 1][0]).toFixed(1)},${H - B}`;
        g += `<polygon points="${poly}" fill="url(#${gid})"/>`;
      }
      if (s.dots) {
        for (const p of s.pts) {
          g += `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="${s.r || 2.3}" fill="${s.color}" fill-opacity="${s.opacity ?? 0.45}"/>`;
        }
      }
      if (s.width && s.pts.length > 1) {
        const dashAttr = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
        g += `<polyline points="${s.pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linejoin="round" stroke-linecap="round"${dashAttr}/>`;
      }
    });
    g += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${css('--ink')}" stroke-width="1" opacity="0"/>`;
    charts.set(id, {
      mode: 'line', x, W, series,
      tipfmt: tipfmt || ((p) => `${xfmt(p[0])}  ${yfmt(p[1])}`),
    });
    return `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg><div class="tip"></div></div>`;
  }

  function svgBarChart({
    span = 'half', bars, target, height = 165, yfmt = (v) => fmt(v),
    labelEvery = 1, overlayLine = null, overlayColor = null,
  }) {
    if (!bars.length) return '<p class="empty-note">这段时间还没有记录。</p>';
    const W = chartWidth(span), H = height, L = 40, R = 10, T = 12, B = 24;
    const tops = bars.map((b) => b.stacks.reduce((s, x) => s + (x.v || 0), 0));
    const overVals = overlayLine ? overlayLine.filter((v) => v != null) : [];
    const hi = Math.max(...tops, ...overVals, target || 0, 1) * 1.08;
    const y = scale(0, hi, H - B, T);
    const bw = (W - L - R) / bars.length;
    const id = `c${++chartSeq}`;
    let g = '';
    for (const t of niceTicks(0, hi, 3)) {
      g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`;
      g += `<text class="ax" x="${L - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(yfmt(t))}</text>`;
    }
    const barHits = [];
    bars.forEach((b, i) => {
      let acc = 0;
      const bx = L + i * bw + bw * 0.16;
      const w = Math.max(2, bw * 0.68);
      for (const s of b.stacks) {
        if (!s.v) continue;
        const yTop = y(acc + s.v);
        const bh = Math.max(0.8, y(acc) - yTop);
        g += `<rect x="${bx.toFixed(1)}" y="${yTop.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${s.color}" fill-opacity="${s.opacity ?? 1}"/>`;
        acc += s.v;
      }
      if (i % labelEvery === 0 || i === bars.length - 1) {
        g += `<text class="ax" x="${(bx + w / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(b.label)}</text>`;
      }
      barHits.push({ cx: bx + w / 2, tip: b.tip || `${b.label} ${fmt(acc)}` });
    });
    if (target != null) {
      g += `<line class="tg" x1="${L}" x2="${W - R}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/>`;
    }
    if (overlayLine && overlayLine.length) {
      const pts = [];
      overlayLine.forEach((v, i) => {
        if (v != null) pts.push(`${(L + (i + 0.5) * bw).toFixed(1)},${y(v).toFixed(1)}`);
      });
      if (pts.length > 1) {
        g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${overlayColor || css('--ink')}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }
    g += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${css('--ink')}" stroke-width="1" opacity="0"/>`;
    charts.set(id, { mode: 'bars', W, barHits });
    return `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg><div class="tip"></div></div>`;
  }

  function bindCharts(root) {
    root.querySelectorAll('[data-chart]').forEach((el) => {
      const c = charts.get(el.dataset.chart);
      if (!c) return;
      const svg = el.querySelector('svg');
      const tip = el.querySelector('.tip');
      const cur = svg.querySelector('.cursor');
      const move = (ev) => {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * c.W;
        let sx = null, txt = '';
        if (c.mode === 'line') {
          const main = c.series.find((s) => s.tip) || c.series[c.series.length - 1];
          if (!main || !main.pts.length) return;
          let best = null, bd = Infinity;
          for (const p of main.pts) {
            const d = Math.abs(c.x(p[0]) - px);
            if (d < bd) { bd = d; best = p; }
          }
          if (!best) return;
          sx = c.x(best[0]);
          txt = c.tipfmt(best);
        } else if (c.mode === 'bars') {
          let best = null, bd = Infinity;
          for (const b of c.barHits) {
            const d = Math.abs(b.cx - px);
            if (d < bd) { bd = d; best = b; }
          }
          if (!best) return;
          sx = best.cx;
          txt = best.tip;
        } else if (c.mode === 'heat') {
          let best = null, bd = Infinity;
          const py = ((ev.clientY - r.top) / r.height) * c.H;
          for (const cell of c.cells) {
            const d = Math.hypot(cell.cx - px, cell.cy - py);
            if (d < bd) { bd = d; best = cell; }
          }
          if (!best || bd > 16) return;
          sx = best.cx;
          txt = best.tip;
        }
        if (sx == null) return;
        if (cur) {
          cur.setAttribute('x1', sx.toFixed(1));
          cur.setAttribute('x2', sx.toFixed(1));
          cur.setAttribute('opacity', '0.35');
        }
        tip.textContent = txt;
        tip.style.left = `${Math.max(12, Math.min(88, (sx / c.W) * 100))}%`;
        tip.classList.add('on');
      };
      const out = () => {
        tip.classList.remove('on');
        if (cur) cur.setAttribute('opacity', '0');
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', out);
    });
  }

  // ---------- Card Composer State
  function defaultTabLayout(tabId) {
    return CARD_REGISTRY
      .filter((c) => c.tab === tabId)
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ id: c.id, enabled: c.defaultEnabled, span: c.defaultSpan }));
  }

  function loadLayout() {
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');
      const out = {};
      for (const tab of TABS) {
        const defs = CARD_REGISTRY.filter((c) => c.tab === tab.id);
        const byId = Object.fromEntries(defs.map((c) => [c.id, c]));
        const saved = Array.isArray(raw[tab.id]) ? raw[tab.id] : [];
        const seen = new Set();
        const items = [];
        for (const item of saved) {
          const def = item && byId[item.id];
          if (!def || seen.has(def.id)) continue;
          seen.add(def.id);
          const span = def.allowSpanToggle && (item.span === 'half' || item.span === 'wide')
            ? item.span
            : def.defaultSpan;
          items.push({ id: def.id, enabled: item.enabled !== false, span });
        }
        for (const def of defs.sort((a, b) => a.order - b.order)) {
          if (!seen.has(def.id)) {
            items.push({ id: def.id, enabled: def.defaultEnabled, span: def.defaultSpan });
          }
        }
        out[tab.id] = items;
      }
      return out;
    } catch (_) {
      return Object.fromEntries(TABS.map((t) => [t.id, defaultTabLayout(t.id)]));
    }
  }

  let layoutState = null;
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutState)); } catch (_) { /* ignore */ }
  }

  // ---------- Lookups. Today's daily totals arrive only after the day closes, so the
  // running totals for today are summed from the hourly series (same sources).
  function hourlyDay(p, metric, day) {
    const items = ((p.hourly && p.hourly[metric]) || []).filter((h) => h.t.slice(0, 10) === day);
    if (!items.length) return null;
    return {
      sum: items.reduce((s, h) => s + (h.v || 0), 0),
      lastHour: Math.max(...items.map((h) => Number(h.t.slice(11, 13)))),
    };
  }

  function buildLookups(p) {
    const t = p.targets || {};
    const ctx = {
      today: p.meta.today,
      lastWatchDay: p.meta.last_data_day || (last(p.daily.steps)?.[0]) || p.meta.today,
      targets: t,
      steps: byDay(p.daily.steps),
      active: byDay(p.daily.active_energy),
      basal: byDay(p.daily.basal_energy),
      ex: byDay(p.daily.exercise),
      stand: byDay(p.daily.stand_hour),
      dist: byDay(p.daily.distance),
      flights: byDay(p.daily.flights),
      effort: byDay(p.daily.physical_effort),
      rhr: byDay(p.daily.resting_hr),
      hrv: byDay(p.daily.hrv),
      temp: byDay(p.daily.wrist_temp),
      resp: byDay(p.daily.respiratory_rate),
      spo2: byDay(p.daily.blood_oxygen),
      daylight: byDay(p.daily.daylight),
      envAudio: byDay(p.daily.env_audio),
      water: byDay(p.daily.water_ml),
      sleepMap: Object.fromEntries((p.sleep || []).map((s) => [s.night, s])),
      nutMap: Object.fromEntries((p.nutrition || []).map((n) => [n.day, n])),
      woByDay: (p.workouts || []).reduce((acc, w) => { (acc[w.day] ||= []).push(w); return acc; }, {}),
      partialHour: null,
      asOf: null,
    };
    const today = p.meta.today;
    for (const [day, items] of Object.entries(p.meals_by_day || {})) {
      if (ctx.nutMap[day] || !items.length) continue;
      const sum = (k) => items.reduce((s, m) => s + (m[k] || 0), 0);
      ctx.nutMap[day] = { day, kcal: Math.round(sum('kcal')), protein_g: sum('protein_g'), carbs_g: sum('carbs_g'), fat_g: sum('fat_g'), entries: items.length, meals: {} };
      for (const m of items) ctx.nutMap[day].meals[mealKey(m.meal)] = (ctx.nutMap[day].meals[mealKey(m.meal)] || 0) + (m.kcal || 0);
    }
    const hours = [];
    for (const [key, metric] of [['steps', 'step_count'], ['active', 'active_energy'], ['ex', 'apple_exercise_time']]) {
      if (ctx[key][today] != null) continue;
      const h = hourlyDay(p, metric, today);
      if (h) {
        ctx[key][today] = Math.round(h.sum);
        hours.push(h.lastHour);
      }
    }
    if (hours.length) {
      ctx.partialHour = Math.max(...hours);
      if (ctx.ex[today] == null) ctx.ex[today] = 0;
      const ing = p.meta.last_ingest || '';
      ctx.asOf = ing.slice(0, 10) === today ? ing.slice(11, 16) : `${String(ctx.partialHour).padStart(2, '0')}:59`;
    }
    return ctx;
  }

  function resolveWatchDay(reqDay, p, checkMap) {
    if (checkMap[reqDay] != null) return { day: reqDay, lagged: false };
    if (reqDay === p.meta.today) {
      const keys = Object.keys(checkMap).sort();
      const latest = keys[keys.length - 1];
      if (latest) return { day: latest, lagged: latest !== reqDay };
    }
    return { day: reqDay, lagged: false };
  }

  const dayLabel = (d, today) => (d === today ? '今天' : d === addDays(today, -1) ? '昨天' : `${cn(d)} 周${wd(d)}`);

  // Card anatomy: a body-system label, a one-sentence conclusion, optional tools, the
  // evidence (chart/list), and an optional plain-language note on how it is computed.
  function cardShell(def, span, tools, bodyHtml, head = {}) {
    const isHero = def.defaultSpan === 'hero';
    const spanClass = isHero ? 'span-hero is-hero' : span === 'wide' ? 'span-wide' : 'span-half';
    return `<article class="card ${spanClass} sys-${def.system}" data-card="${def.id}">
      <header class="card-head">
        <div class="card-title-wrap">
          <p class="card-label"><span class="sys-dot" aria-hidden="true"></span>${esc(def.title)}${head.meta ? `<span class="card-meta">${esc(head.meta)}</span>` : ''}</p>
          ${head.headline ? `<h2 class="card-headline">${head.headline}</h2>` : ''}
        </div>
        ${tools ? `<div class="card-tools">${tools}</div>` : ''}
      </header>
      ${bodyHtml}
    </article>`;
  }

  const segHtml = (attr, options, current, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${options.map(([v, l]) => `<button type="button" ${attr}="${v}" aria-pressed="${String(current) === String(v)}">${esc(l)}</button>`).join('')}</div>`;

  function bindSeg(el, attr, apply) {
    el.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener('click', () => { apply(b.getAttribute(attr)); renderWorkspaceOnly(); }));
  }

  function paintSwatches(el, map) {
    el.querySelectorAll('[data-sw]').forEach((sw) => {
      const key = sw.dataset.sw;
      const v = map[key] ?? (key.startsWith('--') ? css(key) : key);
      sw.style.background = v;
    });
  }

  const legend = (items) => `<ul class="legend">${items.map(([sw, label]) => `<li><i class="swatch" data-sw="${esc(sw)}"></i>${esc(label)}</li>`).join('')}</ul>`;

  function circleGauge(ratio, color, size = 26) {
    const c = size / 2, r = c - 3.5, circ = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(1, ratio || 0));
    return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-opacity="0.18" stroke-width="4"/>${pct > 0.01 ? `<circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(pct * circ).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>` : ''}</svg>`;
  }

  function sparkline(values, color, { w = 120, h = 30, base = null } = {}) {
    const vals = values.filter((v) => v != null);
    if (vals.length < 2) return '';
    const lo = Math.min(...vals, base ?? Infinity), hi = Math.max(...vals, base ?? -Infinity);
    const sx = scale(0, values.length - 1, 2, w - 2);
    const sy = scale(lo, hi === lo ? lo + 1 : hi, h - 3, 3);
    const pts = values.map((v, i) => (v == null ? null : `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`)).filter(Boolean).join(' ');
    const baseLine = base != null ? `<line x1="2" x2="${w - 2}" y1="${sy(base).toFixed(1)}" y2="${sy(base).toFixed(1)}" stroke="${css('--muted')}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>` : '';
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${baseLine}<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  // Weekly averages of a daily series over the last `weeks` weeks ending at `end`.
  function weeklyMeans(pairs, end, weeks) {
    const map = byDay(pairs);
    return Array.from({ length: weeks }, (_, w) => {
      const vals = [];
      for (let i = 0; i < 7; i++) {
        const v = map[addDays(end, -((weeks - 1 - w) * 7 + i))];
        if (v != null) vals.push(v);
      }
      return vals.length ? mean(vals) : null;
    });
  }

  // ---------- 24 PLUGGABLE CARDS ----------
  const CARD_REGISTRY = [
    // ==================== TAB 1: TODAY ====================
    {
      id: 'today.rings',
      tab: 'today',
      title: '活动',
      system: 'move',
      defaultSpan: 'hero',
      allowSpanToggle: false,
      defaultEnabled: true,
      order: 1,
      render(p, span, ctx) {
        const d = ctx.day;
        const isToday = d === p.meta.today;
        const partial = isToday && ctx.partialHour != null;
        const t = ctx.targets;
        const move = ctx.active[d], ex = ctx.ex[d], stand = ctx.stand[d], steps = ctx.steps[d];
        const meta = partial ? `今天 截至 ${ctx.asOf}` : dayLabel(d, p.meta.today);
        if (move == null && ex == null && stand == null && steps == null) {
          return cardShell(this, span, '', emptyNote('这一天还没有活动数据。iPhone 打开 Marrow 后会自动同步。'), { meta, headline: '还没有活动数据' });
        }
        const mv = move ?? 0, exv = ex ?? 0, stv = stand ?? 0;
        const rings = [
          { ratio: mv / (t.move_kcal || 600), color: css('--ring-move') },
          { ratio: exv / (t.exercise_minutes || 30), color: css('--ring-ex') },
          { ratio: stv / (t.stand_hours || 12), color: css('--ring-stand') },
        ];
        const closed = [mv >= t.move_kcal, exv >= t.exercise_minutes, stand != null && stv >= t.stand_hours].filter(Boolean).length;
        const left = t.move_kcal - mv;
        let headline;
        if (closed === 3) headline = '三个圆环都已合拢';
        else if (left > 0) headline = `活动环完成 ${N(Math.round((mv / t.move_kcal) * 100) + '%')}，${isToday ? '还差' : '差'} ${N(fmt(left))} 千卡`;
        else headline = `活动环已合拢，多出 ${N(fmt(-left))} 千卡`;

        let pace = '';
        if (partial && steps != null) {
          const usual = (p.circadian || []).slice(0, ctx.partialHour + 1).reduce((s, c) => s + (c.steps || 0), 0);
          if (usual > 300) {
            const diff = ((steps - usual) / usual) * 100;
            pace = Math.abs(diff) < 8
              ? `步数和你平时这个时间差不多（平时约 ${fmt(usual)} 步）。`
              : `步数比你平时这个时间${diff > 0 ? '多' : '少'} ${fmt(Math.abs(diff))}%（平时约 ${fmt(usual)} 步）。`;
          }
        }
        const basal = ctx.basal[d];
        const total = basal != null && move != null ? basal + move : null;
        const kpi = (cls, label, val, target, unit) => `<div class="ring-kpi">
          <span class="ring-kpi-lbl"><i class="ring-kpi-dot ${cls}"></i>${label}</span>
          <div class="ring-kpi-val num">${val}<small>/ ${fmt(target)} ${unit}</small></div>
        </div>`;
        const strip = (label, val, unit) => `<div class="strip-item"><span>${label}</span><b>${val}</b><small>${unit}</small></div>`;
        const body = `<div class="rings-hero-grid">
          <div class="rings-svg-wrap">${svgConcentricRings(rings, 208)}</div>
          <div class="rings-stats">
            <div class="rings-trio">
              ${kpi('dot-move', '活动', fmt(mv), t.move_kcal, '千卡')}
              ${kpi('dot-ex', '锻炼', fmt(exv), t.exercise_minutes, '分钟')}
              ${kpi('dot-stand', '站立', stand != null ? fmt(stv) : '–', t.stand_hours, '小时')}
            </div>
            ${pace ? `<p class="hero-note">${esc(pace)}</p>` : ''}
            <div class="rings-strip">
              ${strip('步数', fmt(steps), '步')}
              ${strip('步行距离', ctx.dist[d] != null ? fmt(ctx.dist[d], 1) : '–', '公里')}
              ${strip('全天总消耗', total != null ? fmt(total) : '–', '千卡')}
              ${strip('爬楼', ctx.flights[d] != null ? fmt(ctx.flights[d]) : '–', '层')}
            </div>
          </div>
        </div>`;
        return cardShell(this, span, '', body, { meta, headline });
      },
    },
    {
      id: 'today.sleep_hypnogram',
      tab: 'today',
      title: '睡眠',
      system: 'sleep',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 2,
      render(p, span, ctx) {
        const res = resolveWatchDay(ctx.day, p, ctx.sleepMap);
        const night = ctx.sleepMap[res.day];
        if (!night) return cardShell(this, span, '', emptyNote('这一晚没有睡眠记录。戴着 Apple Watch 入睡后，第二天同步即可看到。'), { meta: dayLabel(ctx.day, p.meta.today), headline: '没有睡眠记录' });
        const target = ctx.targets.sleep_hours || 7;
        const gap = night.hours - target;
        const headline = gap >= 0
          ? `睡了 ${N(hm(night.hours))}，达到 ${fmt(target)} 小时目标`
          : `睡了 ${N(hm(night.hours))}，比目标少 ${N(hm(-gap))}`;
        const prior = (p.sleep || []).filter((s) => s.night < night.night).slice(-14);
        const medBed = quantile(prior.map((s) => s.bed_min).filter((v) => v != null).sort((a, b) => a - b), 0.5);
        let bedNote = '';
        if (medBed != null && night.bed_min != null) {
          const diff = night.bed_min - medBed;
          bedNote = Math.abs(diff) < 20 ? '和平时差不多' : `比平时${diff > 0 ? '晚' : '早'} ${hm(Math.abs(diff) / 60)}`;
        }
        const stageCols = { awake: css('--st-awake'), rem: css('--st-rem'), core: css('--st-core'), deep: css('--st-deep'), asleep: css('--st-asleep') };
        const stageY = { awake: 16, rem: 44, core: 74, asleep: 74, deep: 104 };
        let visual = '';
        const segs = (night.segments || []).filter((s) => s[2] !== 'in_bed');
        if (segs.length >= 3) {
          const W = chartWidth(span), H = 136, L = 46, R = 10, B = 24;
          const t0 = segs[0][0], t1 = segs[segs.length - 1][1];
          const x = scale(t0, t1 === t0 ? t0 + 60 : t1, L, W - R);
          const offMs = (p.meta.tz_offset_s || 28800) * 1000;
          const hmTick = (ep) => new Date(ep * 1000 + offMs).toISOString().slice(11, 16);
          let g = '';
          [['清醒', 16], ['快速眼动', 44], ['核心', 74], ['深睡', 104]].forEach(([lbl, yy]) => {
            g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${yy + 6}" y2="${yy + 6}"/>`;
            g += `<text class="ax" x="${L - 6}" y="${yy + 10}" text-anchor="end">${lbl}</text>`;
          });
          const barHits = [];
          for (let i = 0; i < segs.length; i++) {
            const [s0, s1, st] = segs[i];
            const xx = x(s0), ww = Math.max(1.5, x(s1) - xx);
            const yy = stageY[st] ?? 74;
            if (i > 0) {
              const prevY = stageY[segs[i - 1][2]] ?? 74;
              if (prevY !== yy) g += `<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${Math.min(prevY, yy) + 6}" y2="${Math.max(prevY, yy) + 6}" stroke="${css('--faint')}" stroke-width="1"/>`;
            }
            g += `<rect x="${xx.toFixed(1)}" y="${yy}" width="${ww.toFixed(1)}" height="12" rx="3" fill="${stageCols[st] || stageCols.core}"/>`;
            barHits.push({ cx: xx + ww / 2, tip: `${hmTick(s0)}–${hmTick(s1)} ${STAGE_NAMES[st] || st} ${Math.max(1, Math.round((s1 - s0) / 60))} 分钟` });
          }
          [t0, (t0 + t1) / 2, t1].forEach((tt, idx) => {
            const anc = idx === 0 ? 'start' : idx === 2 ? 'end' : 'middle';
            g += `<text class="ax" x="${x(tt).toFixed(1)}" y="${H - 5}" text-anchor="${anc}">${hmTick(tt)}</text>`;
          });
          g += `<line class="cursor" x1="0" x2="0" y1="8" y2="${H - B}" stroke="${css('--ink')}" stroke-width="1" opacity="0"/>`;
          const id = `c${++chartSeq}`;
          charts.set(id, { mode: 'bars', W, barHits });
          visual = `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="睡眠分期图">${g}</svg><div class="tip"></div></div>`;
        } else {
          const parts = ['deep', 'core', 'rem', 'asleep', 'awake'].filter((k) => night[k]);
          const tot = parts.reduce((s, k) => s + night[k], 0) || 1;
          let acc = 0, rects = '';
          for (const k of parts) {
            const w = (night[k] / tot) * 200;
            rects += `<rect x="${acc.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="14" fill="${stageCols[k]}"/>`;
            acc += w;
          }
          const cid = `slpClip_${++chartSeq}`;
          visual = `<svg viewBox="0 0 200 14" preserveAspectRatio="none" width="100%" height="14" role="img"><clipPath id="${cid}"><rect x="0" y="0" width="200" height="14" rx="7"/></clipPath><g clip-path="url(#${cid})">${rects}</g></svg>`;
        }
        const asleep = ['deep', 'core', 'rem', 'asleep'].reduce((s, k) => s + (night[k] || 0), 0) || night.hours;
        const stages = ['deep', 'core', 'rem', 'awake'].filter((k) => night[k] != null).map((k) => `<div class="stage">
            <span><i class="swatch" data-sw="--st-${k}"></i>${STAGE_NAMES[k]}</span>
            <b>${hm(night[k])}</b>
            <small>${k === 'awake' ? '' : `${fmt((night[k] / asleep) * 100)}%`}</small>
          </div>`).join('');
        const facts = `<div class="fact-row">
          <span>入睡 <b>${esc(night.bed || '–')}</b></span>
          <span>起床 <b>${esc(night.wake || '–')}</b></span>
          ${bedNote ? `<span>入睡时间${esc(bedNote)}</span>` : ''}
        </div>`;
        const meta = `${res.day === p.meta.today ? '昨晚' : `${md(night.night)} 醒来`}`;
        return cardShell(this, span, '', `${facts}${visual}<div class="stage-row">${stages}</div>`, { meta, headline });
      },
      bind(el) { paintSwatches(el, {}); },
    },
    {
      id: 'today.vitals',
      tab: 'today',
      title: '身体状态',
      system: 'heart',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 3,
      render(p, span, ctx) {
        const vitals = p.vitals || {};
        const maps = { resting_hr: ctx.rhr, hrv: ctx.hrv, wrist_temp: ctx.temp, respiratory_rate: ctx.resp, blood_oxygen: ctx.spo2 };
        const names = { resting_hr: '静息心率', hrv: '心率变异性 HRV', wrist_temp: '睡眠腕温', respiratory_rate: '呼吸频率', blood_oxygen: '血氧' };
        const rows = [];
        const flagged = [];
        let usedDay = null;
        for (const k of Object.keys(maps)) {
          const spec = vitals[k];
          if (!spec) continue;
          let val = maps[k][ctx.day];
          let dShown = ctx.day;
          if (val == null && ctx.day === p.meta.today) { val = spec.latest; dShown = spec.latest_day; }
          if (val == null) continue;
          if (!usedDay || dShown > usedDay) usedDay = dShown;
          const has = spec.p15 != null && spec.p85 != null;
          const state = !has ? 'ok' : val > spec.p85 ? 'high' : val < spec.p15 ? 'low' : 'ok';
          if (state !== 'ok') flagged.push(`${names[k].replace(' HRV', '')}偏${state === 'high' ? '高' : '低'}`);
          const lo = Math.min(spec.p15 ?? val, val) - (spec.sd || 1) * 1.2;
          const hi = Math.max(spec.p85 ?? val, val) + (spec.sd || 1) * 1.2;
          const sx = scale(lo, hi === lo ? lo + 1 : hi, 6, 194);
          const x15 = sx(spec.p15 ?? val), x85 = sx(spec.p85 ?? val), xv = sx(val);
          const dotCol = state === 'ok' ? css('--good') : css('--warn');
          const isTemp = k === 'wrist_temp' && spec.p50 != null;
          const display = isTemp ? signed(val - spec.p50, 2) : fmt(val, k === 'blood_oxygen' || k === 'respiratory_rate' || k === 'hrv' ? 0 : 0);
          const unit = isTemp ? '°C' : unitCn(spec.unit);
          const range = isTemp ? `${signed(spec.p15 - spec.p50, 1)}~${signed(spec.p85 - spec.p50, 1)}` : `${fmt(spec.p15, 0)}–${fmt(spec.p85, 0)}`;
          rows.push(`<div class="vital-row">
            <div class="vital-name"><span>${esc(names[k])}</span><small>平时 ${esc(range)}</small></div>
            <svg class="vital-svg" viewBox="0 0 200 22" role="img" aria-label="${esc(names[k])}与平时范围">
              <rect x="6" y="9" width="188" height="4" rx="2" fill="${css('--faint')}" fill-opacity="0.5"/>
              <rect x="${x15.toFixed(1)}" y="6" width="${Math.max(4, x85 - x15).toFixed(1)}" height="10" rx="5" fill="${css('--good')}" fill-opacity="0.2"/>
              <circle cx="${xv.toFixed(1)}" cy="11" r="5.5" fill="${dotCol}" stroke="${css('--surface')}" stroke-width="2"/>
            </svg>
            <div class="vital-val"><b>${display}</b><small>${esc(unit)}</small><span class="state ${state === 'ok' ? 'ok' : 'off'}">${state === 'ok' ? '正常' : state === 'high' ? '偏高' : '偏低'}</span></div>
          </div>`);
        }
        const meta = usedDay ? `${dayLabel(usedDay, p.meta.today)}夜间` : '';
        if (!rows.length) return cardShell(this, span, '', emptyNote('这一天没有夜间生理指标。戴着 Apple Watch 睡觉才会记录。'), { headline: '没有夜间指标' });
        const headline = flagged.length
          ? `${esc(flagged.join('、'))}，其余 ${N(rows.length - flagged.length)} 项在平时范围内`
          : `${N(rows.length)} 项夜间指标都在你的平时范围内`;
        return cardShell(this, span, '', `<div class="vitals-list">${rows.join('')}</div>`, { meta, headline });
      },
    },
    {
      id: 'today.nutrition',
      tab: 'today',
      title: '饮食',
      system: 'food',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 4,
      render(p, span, ctx) {
        const d = ctx.day;
        const isToday = d === p.meta.today;
        const n = ctx.nutMap[d];
        const meals = (p.meals_by_day && p.meals_by_day[d]) || (isToday ? p.meals_today : []) || [];
        const t = ctx.targets;
        const meta = dayLabel(d, p.meta.today);
        if (!n && !meals.length) {
          return cardShell(this, span, '', emptyNote('这一天没有饮食记录。在 Marrow 里记一餐，下次同步后会显示在这里。'), { meta, headline: '还没有饮食记录' });
        }
        const sum = (k) => meals.reduce((s, m) => s + (m[k] || 0), 0);
        const kcal = n ? (n.kcal || 0) : sum('kcal');
        const pro = n ? (n.protein_g || 0) : sum('protein_g');
        const carb = n ? (n.carbs_g || 0) : sum('carbs_g');
        const fat = n ? (n.fat_g || 0) : sum('fat_g');
        const left = t.kcal - kcal;
        const headline = left >= 0
          ? `${isToday ? '已吃' : '吃了'} ${N(fmt(kcal))} 千卡，${isToday ? '还可以吃' : '低于目标'} ${N(fmt(left))}`
          : `${isToday ? '已吃' : '吃了'} ${N(fmt(kcal))} 千卡，超出目标 ${N(fmt(-left))}`;
        const total = ctx.active[d] != null && ctx.basal[d] != null ? ctx.active[d] + ctx.basal[d] : null;

        const macroLine = (lbl, v, tgt, col) => `<div class="macro-row">
          <div class="macro-head"><span>${lbl}</span><span><b>${fmt(v, 0)}</b><small> / ${fmt(tgt)} 克</small></span></div>
          ${svgHBar(v / (tgt || 1), col, 6)}
        </div>`;

        const groups = {};
        for (const m of meals) (groups[mealKey(m.meal)] ||= []).push(m);
        const groupKeys = MEAL_ORDER.filter((k) => groups[k]);
        const totalItems = meals.length;
        const limit = mealsExpanded ? Infinity : 2;
        const mealHtml = groupKeys.length ? `<div class="meal-groups">${groupKeys.map((k) => {
          const items = groups[k];
          const gk = items.reduce((s, m) => s + (m.kcal || 0), 0);
          const gp = items.reduce((s, m) => s + (m.protein_g || 0), 0);
          const shown = items.slice(0, limit);
          const more = items.length - shown.length;
          return `<section class="meal-group">
            <header><span class="meal-name">${MEAL_NAMES[k]}</span><small>${esc(items[0].t || '')} · ${items.length} 项 · 蛋白 ${fmt(gp)} 克</small><b class="meal-kcal">${fmt(gk)}</b></header>
            <ul>${shown.map((m) => `<li><span>${esc(m.food || '未命名')}</span><span class="meal-item-kcal">${fmt(m.kcal)}</span></li>`).join('')}${more > 0 ? `<li class="more">还有 ${more} 项</li>` : ''}</ul>
          </section>`;
        }).join('')}</div>${totalItems > groupKeys.length * 2 ? `<button type="button" class="text-btn" data-meals-toggle>${mealsExpanded ? '收起明细' : `展开全部 ${totalItems} 项`}</button>` : ''}`
          : '<p class="card-sub">当日只有 Apple 健康里的营养汇总，没有分餐明细。</p>';

        const body = `<div class="nut-top">
          <div class="nut-arc">${svgBudgetArc(kcal, t.kcal)}</div>
          <div class="nut-macros">
            ${macroLine('蛋白质', pro, t.protein_g, css('--sys-move'))}
            ${macroLine('碳水', carb, t.carbs_g, css('--sys-body'))}
            ${macroLine('脂肪', fat, t.fat_g, css('--sys-food'))}
          </div>
        </div>
        ${total != null ? `<div class="fact-row"><span>全天总消耗 <b>${fmt(total)}</b> 千卡</span><span>${kcal - total <= 0 ? '热量缺口' : '热量盈余'} <b>${fmt(Math.abs(kcal - total))}</b> 千卡</span></div>` : ''}
        ${mealHtml}`;
        return cardShell(this, span, '', body, { meta, headline });
      },
      bind(el) {
        el.querySelector('[data-meals-toggle]')?.addEventListener('click', () => { mealsExpanded = !mealsExpanded; renderWorkspaceOnly(); });
      },
    },
    {
      id: 'today.intraday_hr',
      tab: 'today',
      title: '心率',
      system: 'heart',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 5,
      render(p, span, ctx) {
        const allHr = (p.hourly && p.hourly.heart_rate) || [];
        if (!allHr.length) return cardShell(this, span, '', emptyNote('最近 7 天没有逐小时心率。'), { headline: '没有心率数据' });
        let day = ctx.day;
        let dayHr = allHr.filter((h) => h.t.slice(0, 10) === day);
        if (!dayHr.length) {
          day = allHr[allHr.length - 1].t.slice(0, 10);
          dayHr = allHr.filter((h) => h.t.slice(0, 10) === day);
        }
        const W = chartWidth(span), H = 165, L = 36, R = 10, T = 12, B = 24;
        const lows = dayHr.map((h) => h.lo ?? h.v);
        const highs = dayHr.map((h) => h.hi ?? h.v);
        const lo = Math.max(30, Math.min(...lows) - 6);
        const hi = Math.max(...highs) + 6;
        const y = scale(lo, hi, H - B, T);
        const x = scale(0, 23, L + 6, W - R - 6);
        const byH = Object.fromEntries(dayHr.map((h) => [parseInt(h.t.slice(11, 13), 10), h]));
        let g = '';
        for (const tk of niceTicks(lo, hi, 4)) {
          g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(tk).toFixed(1)}" y2="${y(tk).toFixed(1)}"/>`;
          g += `<text class="ax" x="${L - 6}" y="${(y(tk) + 3.5).toFixed(1)}" text-anchor="end">${fmt(tk)}</text>`;
        }
        const rhr = ctx.rhr[day] ?? last(p.daily.resting_hr)?.[1];
        if (rhr != null && rhr >= lo && rhr <= hi) {
          g += `<line class="tg" x1="${L}" x2="${W - R}" y1="${y(rhr).toFixed(1)}" y2="${y(rhr).toFixed(1)}"/>`;
        }
        const meanPts = [];
        const barHits = [];
        for (let h = 0; h < 24; h++) {
          const item = byH[h];
          const cx = x(h);
          if (item) {
            const yTop = y(item.hi ?? item.v);
            const yBot = y(item.lo ?? item.v);
            g += `<rect x="${(cx - 3.5).toFixed(1)}" y="${yTop.toFixed(1)}" width="7" height="${Math.max(5, yBot - yTop).toFixed(1)}" rx="3.5" fill="${css('--sys-heart')}" fill-opacity="0.24"/>`;
            g += `<circle cx="${cx.toFixed(1)}" cy="${y(item.v).toFixed(1)}" r="2.6" fill="${css('--sys-heart')}"/>`;
            meanPts.push(`${cx.toFixed(1)},${y(item.v).toFixed(1)}`);
            barHits.push({ cx, tip: `${String(h).padStart(2, '0')}:00 平均 ${fmt(item.v)}，${fmt(item.lo)}–${fmt(item.hi)} 次/分` });
          }
          if (h % 6 === 0 || h === 23) g += `<text class="ax" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${String(h).padStart(2, '0')}:00</text>`;
        }
        if (meanPts.length > 1) g += `<polyline points="${meanPts.join(' ')}" fill="none" stroke="${css('--sys-heart')}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
        g += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${css('--ink')}" stroke-width="1" opacity="0"/>`;
        const id = `c${++chartSeq}`;
        charts.set(id, { mode: 'bars', W, barHits });
        const minHr = Math.min(...lows), maxHr = Math.max(...highs);
        const peak = dayHr.reduce((a, b) => ((b.hi ?? b.v) > (a.hi ?? a.v) ? b : a));
        const headline = `心率在 ${N(fmt(minHr))}–${N(fmt(maxHr))} 次/分之间${rhr != null ? `，静息 ${N(fmt(rhr))}` : ''}`;
        const body = `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="逐小时心率">${g}</svg><div class="tip"></div></div>
          <div class="fact-row"><span>最高出现在 <b>${esc(peak.t.slice(11, 16))}</b></span><span>已记录 <b>${dayHr.length}</b> 小时</span></div>`;
        return cardShell(this, span, '', body, { meta: dayLabel(day, p.meta.today), headline });
      },
    },
    {
      id: 'today.circadian',
      tab: 'today',
      title: '一天中的活动',
      system: 'env',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 6,
      render(p, span, ctx) {
        const circ = p.circadian || [];
        const hSteps = (p.hourly && p.hourly.step_count) || [];
        let day = ctx.day;
        let dayPts = hSteps.filter((x) => x.t.slice(0, 10) === day);
        if (!dayPts.length && hSteps.length) {
          day = hSteps[hSteps.length - 1].t.slice(0, 10);
          dayPts = hSteps.filter((x) => x.t.slice(0, 10) === day);
        }
        if (!dayPts.length) return cardShell(this, span, '', emptyNote('这一天没有逐小时步数。'), { headline: '没有逐小时步数' });
        const byH = Object.fromEntries(dayPts.map((x) => [parseInt(x.t.slice(11, 13), 10), x.v]));
        const bars = Array.from({ length: 24 }, (_, h) => {
          const val = byH[h] || 0;
          const base = circ[h]?.steps ?? 0;
          return {
            label: `${h}时`,
            stacks: [{ v: val, color: css('--sys-move') }],
            tip: `${String(h).padStart(2, '0')}:00 这一小时 ${fmt(val)} 步，平时 ${fmt(base)} 步`,
          };
        });
        const overlay = Array.from({ length: 24 }, (_, h) => circ[h]?.steps ?? 0);
        const total = dayPts.reduce((s, x) => s + (x.v || 0), 0);
        const peak = dayPts.reduce((a, b) => (b.v > a.v ? b : a));
        const isPartial = day === p.meta.today && ctx.partialHour != null;
        const headline = isPartial
          ? `截至 ${esc(ctx.asOf)} 走了 ${N(fmt(total))} 步，最活跃在 ${N(Number(peak.t.slice(11, 13)) + ' 点')}`
          : `全天 ${N(fmt(total))} 步，最活跃在 ${N(Number(peak.t.slice(11, 13)) + ' 点')}`;
        const dl = ctx.daylight[day];
        const body = `${svgBarChart({
          span, bars, height: 160, labelEvery: 3,
          yfmt: (v) => (v >= 1000 ? `${fmt(v / 1000, 1)}k` : fmt(v)),
          overlayLine: overlay, overlayColor: css('--muted'),
        })}
        ${legend([['--sys-move', '这一天每小时步数'], ['--muted', '平时（近 30 天平均）']])}
        ${dl != null ? `<div class="fact-row"><span>户外日照 <b>${fmt(dl)}</b> 分钟</span></div>` : ''}`;
        return cardShell(this, span, '', body, { meta: dayLabel(day, p.meta.today), headline });
      },
      bind(el) { paintSwatches(el, {}); },
    },

    // ==================== TAB 2: RECENT ====================
    {
      id: 'rhythm.ring_calendar',
      tab: 'rhythm',
      title: '月历',
      system: 'move',
      defaultSpan: 'wide',
      allowSpanToggle: false,
      defaultEnabled: true,
      order: 1,
      render(p, span, ctx) {
        const month = calMonth || p.meta.today.slice(0, 7);
        const [yr, mo] = month.split('-').map(Number);
        const daysInMonth = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
        const startOffset = weekdayIdx(`${month}-01`);
        const t = ctx.targets;
        let cells = WD_MON.map((w) => `<div class="cal-wd">${w}</div>`).join('');
        for (let i = 0; i < startOffset; i++) cells += '<div class="cal-cell blank"></div>';
        let moveHits = 0, sleepHits = 0, foodHits = 0, foodDays = 0, dataDays = 0;
        for (let dn = 1; dn <= daysInMonth; dn++) {
          const iso = `${month}-${String(dn).padStart(2, '0')}`;
          const future = iso > p.meta.today;
          const m = ctx.active[iso], e = ctx.ex[iso], st = ctx.stand[iso], sl = ctx.sleepMap[iso]?.hours;
          const nut = ctx.nutMap[iso];
          if (m != null || sl != null || nut) dataDays++;
          if (m != null && m >= t.move_kcal) moveHits++;
          if (sl != null && sl >= t.sleep_hours) sleepHits++;
          if (nut) { foodDays++; if (nut.kcal <= t.kcal) foodHits++; }
          let icon = '';
          if (!future) {
            if (calOverlay === 'rings') icon = svgMiniRings((m || 0) / (t.move_kcal || 600), (e || 0) / (t.exercise_minutes || 30), (st || 0) / (t.stand_hours || 12), 26);
            else if (calOverlay === 'sleep') icon = circleGauge((sl || 0) / (t.sleep_hours || 7), css('--sys-sleep'));
            else icon = circleGauge(nut ? (nut.kcal || 0) / (t.kcal || 2100) : 0, nut && nut.kcal > t.kcal ? css('--bad') : css('--sys-food'));
          }
          const cls = `cal-cell${future ? ' future' : ''}${iso === p.meta.today ? ' today' : ''}`;
          cells += future
            ? `<div class="${cls}"><span class="dn">${dn}</span></div>`
            : `<button type="button" class="${cls}" data-cal-day="${iso}" aria-pressed="${calSelectedDay === iso}" aria-label="${cn(iso)}"><span class="dn">${dn}</span>${icon}</button>`;
        }
        const inspDay = calSelectedDay && calSelectedDay.startsWith(month)
          ? calSelectedDay
          : (p.meta.today.startsWith(month) ? p.meta.today : `${month}-${String(daysInMonth).padStart(2, '0')}`);
        const iw = ctx.woByDay[inspDay] || [];
        const inut = ctx.nutMap[inspDay];
        const islp = ctx.sleepMap[inspDay];
        const metric = (v, unit) => `<span><b>${v}</b>${unit}</span>`;
        const inspHtml = `<div class="cal-inspector">
          <div class="cal-insp-date">${cn(inspDay)} 周${wd(inspDay)}</div>
          <div class="cal-insp-metrics">
            ${metric(fmt(ctx.active[inspDay]), '千卡活动')}
            ${metric(fmt(ctx.steps[inspDay]), '步')}
            ${metric(fmt(ctx.ex[inspDay]), '分钟锻炼')}
            ${metric(islp ? hm(islp.hours) : '–', '睡眠')}
            ${metric(inut ? fmt(inut.kcal) : '–', '千卡摄入')}
            ${iw.length ? `<span>${iw.map((x) => `${esc(sportLabel(x.activity))} ${fmt(x.minutes)} 分钟`).join('、')}</span>` : ''}
          </div>
        </div>`;
        const tools = `<div class="cal-month-ctrl">
          <button type="button" class="mini-btn" data-cal-shift="-1" aria-label="上个月">‹</button>
          <span class="cal-month-lbl">${yr} 年 ${mo} 月</span>
          <button type="button" class="mini-btn" data-cal-shift="1" aria-label="下个月" ${month >= p.meta.today.slice(0, 7) ? 'disabled' : ''}>›</button>
        </div>
        ${segHtml('data-cal-mode', [['rings', '圆环'], ['sleep', '睡眠'], ['food', '饮食']], calOverlay, '月历显示')}`;
        let headline;
        if (calOverlay === 'sleep') headline = `${mo} 月有 ${N(sleepHits)} 晚睡够 ${fmt(t.sleep_hours)} 小时`;
        else if (calOverlay === 'food') headline = foodDays ? `${mo} 月记录饮食 ${N(foodDays)} 天，其中 ${N(foodHits)} 天没超热量目标` : `${mo} 月还没有饮食记录`;
        else headline = `${mo} 月活动环合拢 ${N(moveHits)} 天${dataDays ? `，共记录 ${N(dataDays)} 天` : ''}`;
        return cardShell(this, span, tools, `<div class="cal-grid">${cells}</div>${inspHtml}`, { headline });
      },
      bind(el, p) {
        el.querySelectorAll('[data-cal-shift]').forEach((b) => b.addEventListener('click', () => {
          const cur = calMonth || p.meta.today.slice(0, 7);
          const [y, m] = cur.split('-').map(Number);
          const d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.calShift), 15));
          calMonth = d.toISOString().slice(0, 7);
          renderWorkspaceOnly();
        }));
        bindSeg(el, 'data-cal-mode', (v) => { calOverlay = v; });
        el.querySelectorAll('[data-cal-day]').forEach((b) => b.addEventListener('click', () => { calSelectedDay = b.dataset.calDay; renderWorkspaceOnly(); }));
      },
    },
    {
      id: 'rhythm.week_matrix',
      tab: 'rhythm',
      title: '近 7 天达标',
      system: 'move',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 2,
      render(p, span, ctx) {
        const end = p.meta.today;
        const days = Array.from({ length: 7 }, (_, i) => addDays(end, i - 6));
        const t = ctx.targets;
        const rows = [
          ['步数', (d) => ctx.steps[d], t.steps, css('--sys-move'), 'floor', (v) => fmt(v / 1000, 1) + 'k'],
          ['锻炼', (d) => ctx.ex[d], t.exercise_minutes, css('--ring-ex'), 'floor', (v) => fmt(v)],
          ['站立', (d) => ctx.stand[d], t.stand_hours, css('--ring-stand'), 'floor', (v) => fmt(v)],
          ['睡眠', (d) => ctx.sleepMap[d]?.hours, t.sleep_hours, css('--sys-sleep'), 'floor', (v) => fmt(v, 1)],
          ['热量', (d) => ctx.nutMap[d]?.kcal, t.kcal, css('--sys-food'), 'cap', (v) => fmt(v / 1000, 1) + 'k'],
          ['蛋白', (d) => ctx.nutMap[d]?.protein_g, t.protein_g, css('--sys-food'), 'floor', (v) => fmt(v)],
        ];
        let html = '<div class="week-mat"><span></span>' + days.map((d) => `<span class="dh ${d === end ? 'now' : ''}">${d === end ? '今天' : '周' + wd(d)}<br>${+d.slice(8)}</span>`).join('');
        let hits = 0, total = 0;
        const rates = [];
        for (const [lbl, get, target, color, kind, short] of rows) {
          html += `<span class="rl">${lbl}</span>`;
          let rh = 0, rt = 0;
          for (const d of days) {
            const v = get(d);
            const partialToday = d === end && kind === 'floor' && lbl !== '睡眠';
            if (v == null) { html += '<div class="mat-cell none" title="没有数据"></div>'; continue; }
            const ratio = Math.min(1, v / (target || 1));
            const hit = kind === 'cap' ? v <= target : v >= target;
            if (!partialToday || hit) { rt++; total++; if (hit) { rh++; hits++; } }
            const yTop = (1 - ratio) * 36;
            html += `<div class="mat-cell ${kind === 'cap' && v > target ? 'over' : ''}" title="${esc(lbl)} ${fmt(v, 1)}">
              <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="${yTop.toFixed(1)}" width="100" height="${(36 - yTop).toFixed(1)}" fill="${color}" fill-opacity="${hit ? 0.55 : 0.22}"/></svg>
              <span class="mat-val">${short(v)}</span>
            </div>`;
          }
          if (rt) rates.push([lbl, rh / rt]);
        }
        html += '</div>';
        rates.sort((a, b) => a[1] - b[1]);
        const weakest = rates.filter((r) => r[1] < 0.5).slice(0, 2).map((r) => r[0]);
        const headline = `达标 ${N(hits)}/${N(total)} 项${weakest.length ? `，${esc(weakest.join('和'))}最常没达到` : '，各项都比较稳定'}`;
        return cardShell(this, span, '', html, { headline });
      },
    },
    {
      id: 'rhythm.sleep_tunnel',
      tab: 'rhythm',
      title: '作息',
      system: 'sleep',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 3,
      render(p, span, ctx) {
        const nights = (p.sleep || []).slice(-sleepSpan).reverse();
        if (!nights.length) return cardShell(this, span, '', emptyNote('还没有睡眠记录。'), { headline: '没有睡眠记录' });
        const bedMins = nights.map((n) => n.bed_min).filter((v) => v != null);
        const wakeMins = nights.map((n) => n.wake_min).filter((v) => v != null);
        const medBed = quantile([...bedMins].sort((a, b) => a - b), 0.5);
        const medWake = quantile([...wakeMins].sort((a, b) => a - b), 0.5);
        const bedSpread = bedMins.length ? Math.sqrt(mean(bedMins.map((v) => (v - mean(bedMins)) ** 2))) : 0;
        const regScore = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, bedSpread - 15) * 0.7)));
        const START = -180, SPAN = 960;
        const W = chartWidth(span), rowH = sleepSpan > 16 ? 13 : 19, L = 46, R = 42, T = 10, B = 24;
        const H = T + nights.length * rowH + B;
        const x = scale(START, START + SPAN, L, W - R);
        const cols = { deep: css('--st-deep'), core: css('--st-core'), rem: css('--st-rem'), asleep: css('--st-asleep'), awake: css('--st-awake') };
        let g = '';
        if (medBed != null && medWake != null) {
          const xB = x(Math.max(START, medBed - 30));
          const xW = x(Math.min(START + SPAN, medWake + 30));
          g += `<rect x="${xB.toFixed(1)}" y="${T}" width="${Math.max(4, xW - xB).toFixed(1)}" height="${nights.length * rowH}" rx="6" fill="${css('--sys-sleep')}" fill-opacity="0.08"/>`;
        }
        const shortCut = ctx.targets.sleep_hours - 1;
        nights.forEach((n, idx) => {
          const cy = T + idx * rowH + rowH * 0.2;
          const bh = Math.max(6, rowH * 0.62);
          g += `<text class="ax" x="${L - 6}" y="${(cy + bh - 1).toFixed(1)}" text-anchor="end">${md(n.night)}</text>`;
          const a = x(Math.max(START, n.bed_min ?? 0));
          const b = x(Math.min(START + SPAN, n.wake_min ?? 480));
          const totalW = Math.max(4, b - a);
          const parts = ['deep', 'core', 'rem', 'asleep', 'awake'].filter((k) => n[k]);
          const sum = parts.reduce((s, k) => s + n[k], 0) || 1;
          let curX = a;
          if (parts.length) {
            for (const k of parts) {
              const pw = (n[k] / sum) * totalW;
              g += `<rect x="${curX.toFixed(1)}" y="${cy.toFixed(1)}" width="${pw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${cols[k]}"/>`;
              curX += pw;
            }
          } else {
            g += `<rect x="${a.toFixed(1)}" y="${cy.toFixed(1)}" width="${totalW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${cols.core}"/>`;
          }
          g += `<text class="${n.hours < shortCut ? 'ax-short' : 'ax-strong'}" x="${W - 2}" y="${(cy + bh - 1).toFixed(1)}" text-anchor="end">${hm(n.hours)}</text>`;
        });
        [[-180, '21:00'], [60, '01:00'], [300, '05:00'], [540, '09:00'], [780, '13:00']].forEach(([m, lbl]) => {
          g += `<text class="ax" x="${x(m).toFixed(1)}" y="${H - 5}" text-anchor="middle">${lbl}</text>`;
        });
        const avg = mean(nights.map((n) => n.hours));
        const shortN = nights.filter((n) => n.hours < shortCut).length;
        const headline = `近 ${nights.length} 晚平均睡 ${N(hm(avg))}，${shortN ? `${N(shortN)} 晚不足 ${fmt(shortCut)} 小时` : '没有明显睡眠不足的夜晚'}`;
        const body = `<div class="fact-row">
          <span>通常 <b>${clockFromMin(medBed)}</b> 入睡</span>
          <span><b>${clockFromMin(medWake)}</b> 起床</span>
          <span>规律度 <b>${regScore}%</b></span>
        </div>
        <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每晚作息">${g}</svg></div>`;
        return cardShell(this, span, segHtml('data-slp-span', [[14, '14 晚'], [30, '30 晚']], sleepSpan, '范围'), body, { headline });
      },
      bind(el) { bindSeg(el, 'data-slp-span', (v) => { sleepSpan = Number(v); }); },
    },
    {
      id: 'rhythm.energy_balance',
      tab: 'rhythm',
      title: '吃进与消耗',
      system: 'food',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 4,
      render(p, span, ctx) {
        const end = p.meta.today;
        const days = Array.from({ length: energySpan }, (_, i) => addDays(end, i - energySpan + 1));
        const f = css('--sys-food');
        const shades = { breakfast: 0.45, lunch: 0.72, dinner: 1.0, snack: 0.28 };
        const bars = days.map((d) => {
          const n = ctx.nutMap[d];
          const meals = {};
          for (const [k, v] of Object.entries(n?.meals || {})) meals[mealKey(k)] = (meals[mealKey(k)] || 0) + v;
          const known = Object.values(meals).reduce((s, v) => s + v, 0);
          const stacks = ['breakfast', 'lunch', 'dinner', 'snack'].map((m) => ({ v: meals[m] || 0, color: f, opacity: shades[m] }));
          if (n && n.kcal > known + 1) stacks.push({ v: n.kcal - known, color: f, opacity: 0.6 });
          const tot = ctx.active[d] != null && ctx.basal[d] != null ? ctx.active[d] + ctx.basal[d] : null;
          return {
            label: energySpan <= 14 ? `${+d.slice(8)}` : md(d),
            stacks,
            tip: `${md(d)} 吃进 ${n ? fmt(n.kcal) : '–'}，消耗 ${tot != null ? fmt(tot) : '–'} 千卡`,
          };
        });
        const totLine = days.map((d) => (ctx.active[d] != null && ctx.basal[d] != null ? ctx.active[d] + ctx.basal[d] : null));
        const paired = days.filter((d) => ctx.nutMap[d] && ctx.active[d] != null && ctx.basal[d] != null);
        const avgDiff = paired.length ? mean(paired.map((d) => ctx.nutMap[d].kcal - (ctx.active[d] + ctx.basal[d]))) : null;
        const logged = days.filter((d) => ctx.nutMap[d]).length;
        const avgPro = mean(days.filter((d) => ctx.nutMap[d]?.protein_g != null).map((d) => ctx.nutMap[d].protein_g));
        const headline = avgDiff == null
          ? '还没有可对比的饮食和消耗数据'
          : `平均每天${avgDiff <= 0 ? '热量缺口' : '热量盈余'} ${N(fmt(Math.abs(avgDiff)))} 千卡`;
        const weekly = avgDiff != null ? Math.abs(avgDiff * 7) / 7700 : null;
        const body = `<div class="fact-row">
          <span>有记录 <b>${logged}</b>/${energySpan} 天</span>
          <span>平均蛋白 <b>${avgPro != null ? fmt(avgPro) : '–'}</b> 克</span>
          ${weekly != null ? `<span>约等于每周${avgDiff <= 0 ? '减' : '增'} <b>${fmt(weekly, 1)}</b> 公斤脂肪</span>` : ''}
        </div>
        ${svgBarChart({ span, bars, target: ctx.targets.kcal, labelEvery: energySpan <= 14 ? 2 : 5, overlayLine: totLine, overlayColor: css('--sys-move') })}
        ${legend([['--sys-food', '吃进'], ['--sys-move', '全天总消耗'], ['--muted', `虚线：目标 ${fmt(ctx.targets.kcal)} 千卡`]])}`;
        return cardShell(this, span, segHtml('data-eng-span', [[14, '14 天'], [30, '30 天']], energySpan, '范围'), body, { headline });
      },
      bind(el) { bindSeg(el, 'data-eng-span', (v) => { energySpan = Number(v); }); paintSwatches(el, {}); },
    },
    {
      id: 'rhythm.training_load',
      tab: 'rhythm',
      title: '锻炼',
      system: 'move',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 5,
      render(p, span, ctx) {
        const today = p.meta.today;
        const thisMon = addDays(today, -weekdayIdx(today));
        const weeks = Array.from({ length: 12 }, (_, i) => addDays(thisMon, (i - 11) * 7));
        const sums = weeks.map((mon) => {
          let s = 0;
          for (let i = 0; i < 7; i++) s += ctx.ex[addDays(mon, i)] || 0;
          return s;
        });
        const bars = weeks.map((mon, i) => ({
          label: md(mon),
          stacks: [{ v: sums[i], color: css('--ring-ex'), opacity: i === 11 ? 0.55 : 1 }],
          tip: `${md(mon)} 起的一周 ${fmt(sums[i])} 分钟${i === 11 ? '（进行中）' : ''}`,
        }));
        const full = sums.slice(0, 11);
        const hitWeeks = full.filter((s) => s >= 150).length;
        const lastWeek = sums[10];
        const headline = `本周已锻炼 ${N(fmt(sums[11]))} 分钟，上周 ${N(fmt(lastWeek))} 分钟`;
        const floor30 = addDays(today, -29);
        const bySport = {};
        for (const w of (p.workouts || []).filter((x) => x.day >= floor30)) bySport[w.activity] = (bySport[w.activity] || 0) + (w.minutes || 0);
        const sportSorted = Object.entries(bySport).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totMin = sportSorted.reduce((s, x) => s + x[1], 0) || 1;
        let acc = 0, mixBar = '';
        sportSorted.forEach(([, m], idx) => {
          const w = (m / totMin) * 200;
          mixBar += `<rect x="${acc.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="10" fill="${SPORT_COLORS[idx % SPORT_COLORS.length]}"/>`;
          acc += w;
        });
        const clip = `woMix_${++chartSeq}`;
        const woList = (p.workouts || []).slice(0, 4).map((w) =>
          `<li><span>${esc(sportLabel(w.activity))}<time>${esc(md(w.day))} ${esc(w.start.slice(11, 16))}</time></span><span class="wo-dur">${fmt(w.minutes)}<small> 分钟</small></span></li>`).join('');
        const body = `<div class="fact-row"><span>近 11 周有 <b>${hitWeeks}</b> 周达到 150 分钟</span><span>周均 <b>${fmt(mean(full))}</b> 分钟</span></div>
        ${svgBarChart({ span, bars, target: 150, height: 150, labelEvery: 3 })}
        ${sportSorted.length ? `<p class="sub-head">近 30 天的训练项目</p>
          <svg viewBox="0 0 200 10" preserveAspectRatio="none" width="100%" height="10" role="img" aria-label="训练项目构成"><clipPath id="${clip}"><rect x="0" y="0" width="200" height="10" rx="5"/></clipPath><g clip-path="url(#${clip})">${mixBar}</g></svg>
          ${legend(sportSorted.map(([act, m], idx) => [SPORT_COLORS[idx % SPORT_COLORS.length], `${sportLabel(act)} ${fmt(m)} 分钟`]))}` : ''}
        ${woList ? `<p class="sub-head">最近的训练</p><ul class="wo-list">${woList}</ul>` : ''}`;
        return cardShell(this, span, '', body, { headline });
      },
      bind(el) { paintSwatches(el, {}); },
    },
    {
      id: 'rhythm.weekday_radar',
      tab: 'rhythm',
      title: '一周节奏',
      system: 'body',
      defaultSpan: 'wide',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 6,
      render(p, span, ctx) {
        const floor = addDays(p.meta.today, -90);
        const until = addDays(p.meta.today, -1);
        const buckets = Array.from({ length: 7 }, () => ({ steps: [], sleep: [] }));
        for (const [d, v] of (p.daily.steps || [])) if (d >= floor && d <= until) buckets[weekdayIdx(d)].steps.push(v);
        for (const s of (p.sleep || [])) if (s.night >= floor) buckets[weekdayIdx(s.night)].sleep.push(s.hours);
        const stepMeans = buckets.map((b) => mean(b.steps));
        const slpMeans = buckets.map((b) => mean(b.sleep));
        const wdSteps = mean(stepMeans.slice(0, 5).filter((v) => v != null)), weSteps = mean(stepMeans.slice(5).filter((v) => v != null));
        const wdSlp = mean(slpMeans.slice(0, 5).filter((v) => v != null)), weSlp = mean(slpMeans.slice(5).filter((v) => v != null));
        const stepBars = buckets.map((b, i) => ({
          label: `周${WD_MON[i]}`,
          stacks: [{ v: stepMeans[i] || 0, color: css('--sys-move'), opacity: i >= 5 ? 0.55 : 1 }],
          tip: `周${WD_MON[i]} 平均 ${fmt(stepMeans[i])} 步`,
        }));
        const sleepBars = buckets.map((b, i) => ({
          label: `周${WD_MON[i]}`,
          stacks: [{ v: slpMeans[i] || 0, color: css('--sys-sleep'), opacity: i >= 5 ? 0.55 : 1 }],
          tip: `周${WD_MON[i]} 平均睡 ${hm(slpMeans[i])}`,
        }));
        const headline = wdSteps != null && weSteps != null
          ? `工作日平均 ${N(fmt(wdSteps))} 步，周末 ${N(fmt(weSteps))} 步`
          : '数据不足以比较工作日和周末';
        const body = `<div class="horizon-grid">
          <div class="horizon-cell"><div class="horizon-head"><strong>步数</strong><span>工作日 ${fmt(wdSteps)}，周末 ${fmt(weSteps)}</span></div>
            ${svgBarChart({ span: 'half', bars: stepBars, height: 140, target: ctx.targets.steps, yfmt: (v) => `${fmt(v / 1000, 0)}k` })}</div>
          <div class="horizon-cell"><div class="horizon-head"><strong>睡眠</strong><span>工作日 ${hm(wdSlp)}，周末 ${hm(weSlp)}</span></div>
            ${svgBarChart({ span: 'half', bars: sleepBars, height: 140, target: ctx.targets.sleep_hours, yfmt: (v) => `${fmt(v, 0)}h` })}</div>
        </div>`;
        return cardShell(this, span, '', body, { headline });
      },
    },

    // ==================== TAB 3: CHANGES ====================
    {
      id: 'trends.spotlight',
      tab: 'trends',
      title: '最近的变化',
      system: 'heart',
      defaultSpan: 'wide',
      allowSpanToggle: false,
      defaultEnabled: true,
      order: 1,
      render(p, span) {
        const items = (p.spotlights || []).slice(0, 9);
        if (!items.length) return cardShell(this, span, '', emptyNote('需要至少 4 个月的数据才能比较。'), { headline: '数据还不够比较' });
        const decimals = (k) => (k === 'steps' || k === 'active_energy' || k === 'exercise' || k === 'daylight' ? 0 : 1);
        const cards = items.map((it) => {
          const up = it.delta >= 0;
          const good = it.polarity === 'higher' ? up : it.polarity === 'lower' ? !up : null;
          const z = Math.abs(it.z_score || 0);
          const level = z >= 1 ? '明显' : z >= 0.5 ? '有变化' : '稳定';
          const tone = z < 0.5 || good == null ? '' : good ? 'good' : 'warn';
          const col = tone === 'good' ? css('--good') : tone === 'warn' ? css('--warn') : css('--muted');
          const spark = sparkline((it.spark || []).map((q) => q[1]), col, { w: 180, h: 34, base: it.avg_base });
          return `<div class="spot-card">
            <div class="spot-top"><span class="spot-name">${esc(it.label)}</span><span class="badge ${tone}">${level}</span></div>
            <div class="spot-nums"><b>${fmt(it.avg_recent, decimals(it.key))}</b><small>${esc(unitCn(it.unit))}</small></div>
            <p class="spot-line">比之前 90 天${up ? '高' : '低'} ${fmt(Math.abs(it.pct), 1)}%（${signed(it.delta, decimals(it.key))}）</p>
            ${spark}
          </div>`;
        }).join('');
        const top = items[0];
        const z0 = Math.abs(top.z_score || 0);
        const headline = z0 < 0.5
          ? '近 30 天各项指标和之前差不多'
          : `变化最大的是${esc(top.label)}：${top.delta >= 0 ? '上升' : '下降'} ${N(fmt(Math.abs(top.delta), top.key === 'steps' || top.key === 'active_energy' ? 0 : 1))} ${esc(unitCn(top.unit))}`;
        return cardShell(this, span, '', `<div class="spot-grid">${cards}</div>`, { meta: '近 30 天 vs 之前 90 天', headline });
      },
    },
    {
      id: 'trends.body_comp',
      tab: 'trends',
      title: '体重',
      system: 'body',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 2,
      render(p, span) {
        const wPts = (p.daily.weight || []).map(([d, v]) => [ms(d), v]);
        if (!wPts.length) return cardShell(this, span, '', emptyNote('还没有体重记录。用体重秤或在健康 App 里记录后会显示。'), { headline: '没有体重记录' });
        const ema = ewmaSeries(wPts, 0.16);
        const from = ms(addDays(p.meta.today, -bodyRange));
        const dVis = wPts.filter((q) => q[0] >= from);
        const eVis = ema.filter((q) => q[0] >= from);
        const latestW = last(p.daily.weight);
        const trendNow = last(ema)[1];
        const ref = ema.find((q) => q[0] >= ms(addDays(latestW[0], -30)));
        const d30 = ref ? trendNow - ref[1] : null;
        const startVis = eVis[0]?.[1];
        const fat = last(p.daily.body_fat);
        const lean = last(p.daily.lean_mass);
        const headline = d30 == null || Math.abs(d30) < 0.2
          ? `趋势体重 ${N(fmt(trendNow, 1))} 公斤，近 30 天基本持平`
          : `趋势体重 ${N(fmt(trendNow, 1))} 公斤，近 30 天${d30 < 0 ? '下降' : '上升'} ${N(fmt(Math.abs(d30), 1))} 公斤`;
        const body = `<div class="fact-row">
          <span>最近称重 <b>${fmt(latestW[1], 1)}</b> 公斤（${md(latestW[0])}）</span>
          ${startVis != null ? `<span>本区间 <b>${signed(trendNow - startVis, 1)}</b> 公斤</span>` : ''}
          ${fat ? `<span>体脂率 <b>${fmt(fat[1], 1)}</b>%</span>` : ''}
          ${lean ? `<span>去脂体重 <b>${fmt(lean[1], 1)}</b> 公斤</span>` : ''}
        </div>
        ${svgLineChart({
          span, height: 175, area: true,
          series: [
            { pts: dVis, color: css('--muted'), dots: true, r: 2.3, opacity: 0.45 },
            { pts: eVis, color: css('--sys-body'), width: 2.4, area: true, tip: true },
          ],
          yfmt: (v) => fmt(v, 1),
          xfmt: (t) => md(new Date(t).toISOString()),
          tipfmt: (q) => `${md(new Date(q[0]).toISOString())} 趋势体重 ${fmt(q[1], 1)} 公斤`,
        })}`;
        return cardShell(this, span, segHtml('data-body-r', [[90, '3 个月'], [180, '6 个月'], [365, '1 年']], bodyRange, '范围'), body, { headline });
      },
      bind(el) { bindSeg(el, 'data-body-r', (v) => { bodyRange = Number(v); }); },
    },
    {
      id: 'trends.autonomic',
      tab: 'trends',
      title: '心率与 HRV',
      system: 'heart',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 3,
      render(p, span, ctx) {
        const endDay = last(p.daily.resting_hr)?.[0] || p.meta.today;
        const floor = addDays(endDay, -119);
        const pts = [];
        for (const [d, hr] of (p.daily.resting_hr || [])) {
          if (d >= floor && ctx.hrv[d] != null) pts.push({ d, x: hr, y: ctx.hrv[d] });
        }
        if (pts.length < 10) return cardShell(this, span, '', emptyNote('静息心率和 HRV 的配对数据还不够。'), { headline: '数据还不够' });
        const xs = pts.map((q) => q.x).sort((a, b) => a - b);
        const ys = pts.map((q) => q.y).sort((a, b) => a - b);
        const medX = quantile(xs, 0.5), medY = quantile(ys, 0.5);
        const W = chartWidth(span), H = 236, L = 34, R = 12, T = 12, B = 26;
        const sx = scale(xs[0] - 2, xs[xs.length - 1] + 2, L, W - R);
        const sy = scale(Math.max(5, ys[0] - 5), ys[ys.length - 1] + 5, H - B, T);
        const mx = sx(medX), my = sy(medY);
        let g = `<rect x="${L}" y="${T}" width="${Math.max(0, mx - L).toFixed(1)}" height="${Math.max(0, my - T).toFixed(1)}" rx="10" fill="${css('--good')}" fill-opacity="0.09"/>`;
        g += `<rect x="${mx.toFixed(1)}" y="${my.toFixed(1)}" width="${Math.max(0, W - R - mx).toFixed(1)}" height="${Math.max(0, H - B - my).toFixed(1)}" rx="10" fill="${css('--warn')}" fill-opacity="0.08"/>`;
        g += `<line class="tg" x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${T}" y2="${H - B}"/>`;
        g += `<line class="tg" x1="${L}" x2="${W - R}" y1="${my.toFixed(1)}" y2="${my.toFixed(1)}"/>`;
        g += `<text class="ax" x="${L + 8}" y="${T + 16}">恢复充分</text>`;
        g += `<text class="ax" x="${W - R - 8}" y="${H - B - 8}" text-anchor="end">疲劳偏多</text>`;
        g += `<text class="ax" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">静息心率 →</text>`;
        g += `<text class="ax" x="${L - 6}" y="${(T + 10).toFixed(1)}" text-anchor="end">HRV</text>`;
        const cut30 = addDays(endDay, -29);
        const cut60 = addDays(endDay, -59);
        const cells = [];
        for (const q of pts) {
          const recent = q.d >= cut30;
          const px = sx(q.x), py = sy(q.y);
          g += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${recent ? 3.6 : 2.4}" fill="${recent ? css('--sys-heart') : css('--muted')}" fill-opacity="${recent ? 0.72 : 0.3}"/>`;
          cells.push({ cx: px, cy: py, tip: `${md(q.d)} 静息 ${fmt(q.x)} 次/分，HRV ${fmt(q.y)} 毫秒` });
        }
        // Centroid of each 30-day window, oldest to newest, shows where recovery is drifting.
        const centroids = [pts.filter((q) => q.d < cut60), pts.filter((q) => q.d >= cut60 && q.d < cut30), pts.filter((q) => q.d >= cut30)]
          .filter((c) => c.length >= 3)
          .map((c) => [mean(c.map((q) => q.x)), mean(c.map((q) => q.y))]);
        if (centroids.length >= 2) {
          g += `<polyline points="${centroids.map((c) => `${sx(c[0]).toFixed(1)},${sy(c[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${css('--ink')}" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 5" />`;
          centroids.forEach((c, i) => {
            const end = i === centroids.length - 1;
            g += `<circle cx="${sx(c[0]).toFixed(1)}" cy="${sy(c[1]).toFixed(1)}" r="${end ? 6 : 4}" fill="${end ? css('--sys-heart') : css('--ink')}" stroke="${css('--surface')}" stroke-width="2"/>`;
          });
        }
        const id = `c${++chartSeq}`;
        charts.set(id, { mode: 'heat', W, H, cells });
        const recent = pts.filter((q) => q.d >= addDays(endDay, -6));
        const rx = mean(recent.map((q) => q.x)), ry = mean(recent.map((q) => q.y));
        let headline = '近一周在你的常态中间';
        if (rx != null && ry != null) {
          if (rx <= medX && ry >= medY) headline = '近一周落在恢复充分的一侧';
          else if (rx > medX && ry < medY) headline = '近一周偏向疲劳的一侧，留意休息';
          else if (rx > medX) headline = '近一周静息心率偏高，HRV 尚可';
          else headline = '近一周静息心率不高，HRV 略低';
        }
        const body = `<div class="fact-row"><span>近 7 天静息 <b>${fmt(rx, 0)}</b> 次/分</span><span>HRV <b>${fmt(ry, 0)}</b> 毫秒</span><span>120 天中位 <b>${fmt(medX, 0)}</b> / <b>${fmt(medY, 0)}</b></span></div>
          <div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="静息心率与 HRV 散点">${g}</svg><div class="tip"></div></div>
          ${legend([['--sys-heart', '近 30 天'], ['--muted', '更早'], ['--ink', '每 30 天的重心']])}`;
        return cardShell(this, span, '', body, { meta: '近 120 天', headline });
      },
    },
    {
      id: 'trends.cardio_engine',
      tab: 'trends',
      title: '心肺耐力',
      system: 'move',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 4,
      render(p, span) {
        const vo2Raw = p.daily.vo2max || [];
        const vo2 = vo2Raw.map(([d, v]) => [ms(d), v]);
        const rec = (p.daily.cardio_recovery || []).slice(-20);
        const vLatest = last(vo2Raw);
        if (!vLatest) return cardShell(this, span, '', emptyNote('还没有 VO₂max 数据。戴 Apple Watch 户外步行或跑步 20 分钟以上会自动估算。'), { headline: '没有 VO₂max 数据' });
        const yearAgo = vo2Raw.find(([d]) => d >= addDays(vLatest[0], -365));
        const change = yearAgo && yearAgo[0] !== vLatest[0] ? vLatest[1] - yearAgo[1] : null;
        const headline = change == null
          ? `最大摄氧量 ${N(fmt(vLatest[1], 1))}`
          : `最大摄氧量 ${N(fmt(vLatest[1], 1))}，比一年前${Math.abs(change) < 0.5 ? '基本持平' : `${change > 0 ? '提高' : '下降'} ${N(fmt(Math.abs(change), 1))}`}`;
        const whr = last(p.daily.walking_hr);
        const rLatest = last(rec);
        const body = `<div class="fact-row">
          <span>最近测得 <b>${md(vLatest[0])}</b></span>
          ${rLatest ? `<span>运动后心率恢复 <b>${fmt(rLatest[1], 0)}</b> 次/分</span>` : ''}
          ${whr ? `<span>步行平均心率 <b>${fmt(whr[1], 0)}</b> 次/分</span>` : ''}
        </div>
        ${vo2.length >= 2 ? svgLineChart({
          span, height: 145, area: true,
          series: [{ pts: vo2, color: css('--sys-move'), width: 2.2, dots: true, r: 2.5, opacity: 1, area: true, tip: true }],
          yfmt: (v) => fmt(v, 0),
          xfmt: (t) => md(new Date(t).toISOString()),
          tipfmt: (q) => `${md(new Date(q[0]).toISOString())} VO₂max ${fmt(q[1], 1)}`,
        }) : ''}
        ${rec.length >= 2 ? `<p class="sub-head">每次训练后的 1 分钟心率恢复</p>${svgBarChart({
          span, height: 100, labelEvery: Math.max(1, Math.floor(rec.length / 4)),
          bars: rec.map(([d, v]) => ({ label: md(d), stacks: [{ v, color: css('--sys-heart'), opacity: 0.8 }], tip: `${md(d)} 下降 ${fmt(v, 0)} 次/分` })),
        })}` : ''}`;
        return cardShell(this, span, '', body, { headline });
      },
    },
    {
      id: 'trends.walking',
      tab: 'trends',
      title: '步行能力',
      system: 'body',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 5,
      render(p, span) {
        const end = p.meta.today;
        const specs = [
          ['walking_speed', '步行速度', '公里/时', 2, 'higher', '越快越好'],
          ['walking_step_length', '步长', '厘米', 0, 'higher', '越长越好'],
          ['walking_steadiness', '步行稳定性', '%', 0, 'higher', '跌倒风险的反向指标'],
          ['walking_asymmetry', '步态不对称', '%', 1, 'lower', '越低越好'],
          ['walking_double_support', '双脚着地时间', '%', 1, 'lower', '越低越稳健'],
          ['stair_speed_up', '上楼速度', '米/秒', 2, 'higher', '越快越好'],
          ['six_minute_walk', '六分钟步行距离', '米', 0, 'higher', '估算值，越远越好'],
        ];
        const rows = [];
        let lead = null;
        for (const [key, label, unit, dec, pol, hint] of specs) {
          const pts = p.daily[key] || [];
          const now = avgWhere(pts, addDays(end, -89), end);
          if (now == null) continue;
          const before = avgWhere(pts, addDays(end, -179), addDays(end, -90));
          const diff = before != null ? now - before : null;
          const meaningful = diff != null && before && Math.abs(diff / before) >= 0.02;
          const good = diff == null || !meaningful ? null : (pol === 'higher' ? diff > 0 : diff < 0);
          const tone = good == null ? '' : good ? 'good' : 'warn';
          const col = tone === 'good' ? css('--good') : tone === 'warn' ? css('--warn') : css('--sys-body');
          if (!lead) lead = [label, now, unit, dec];
          rows.push(`<div class="walk-row">
            <div class="walk-name"><span>${esc(label)}</span><small>${esc(hint)}</small></div>
            ${sparkline(weeklyMeans(pts, end, 26), col, { w: 120, h: 28 })}
            <div class="walk-val"><b>${fmt(now, dec)}</b><small>${esc(unit)}</small><span class="delta ${tone}">${diff == null ? '' : meaningful ? signed(diff, dec) : '持平'}</span></div>
          </div>`);
        }
        if (!rows.length) return cardShell(this, span, '', emptyNote('还没有步行能力数据。'), { headline: '没有步行能力数据' });
        const speed = avgWhere(p.daily.walking_speed, addDays(end, -89), end);
        const steady = avgWhere(p.daily.walking_steadiness, addDays(end, -89), end);
        const headline = speed != null
          ? `平均步速 ${N(fmt(speed, 1))} 公里/时${steady != null ? `，步行稳定性 ${N(fmt(steady, 0) + '%')}` : ''}`
          : `${esc(lead[0])} ${N(fmt(lead[1], lead[3]))} ${esc(lead[2])}`;
        return cardShell(this, span, '', `<div class="walk-list">${rows.join('')}</div>`, { meta: '近 90 天', headline });
      },
    },
    {
      id: 'trends.sleep_coupling',
      tab: 'trends',
      title: '睡眠和恢复',
      system: 'sleep',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 6,
      render(p, span, ctx) {
        const buckets = [
          { lbl: '不到 6 小时', test: (h) => h < 6, hrv: [], rhr: [] },
          { lbl: '6–7 小时', test: (h) => h >= 6 && h < 7, hrv: [], rhr: [] },
          { lbl: '7–8 小时', test: (h) => h >= 7 && h < 8, hrv: [], rhr: [] },
          { lbl: '超过 8 小时', test: (h) => h >= 8, hrv: [], rhr: [] },
        ];
        for (const s of (p.sleep || [])) {
          const b = buckets.find((x) => x.test(s.hours));
          if (!b) continue;
          if (ctx.hrv[s.night] != null) b.hrv.push(ctx.hrv[s.night]);
          if (ctx.rhr[s.night] != null) b.rhr.push(ctx.rhr[s.night]);
        }
        const used = buckets.filter((b) => b.hrv.length || b.rhr.length);
        if (!used.length) return cardShell(this, span, '', emptyNote('睡眠和次日指标的配对样本还不够。'), { headline: '样本不足' });
        const maxHrv = Math.max(...used.map((b) => mean(b.hrv) || 0), 1);
        const minHrv = Math.min(...used.map((b) => mean(b.hrv) ?? Infinity));
        const rows = used.map((b) => {
          const mh = mean(b.hrv), mr = mean(b.rhr);
          const n = Math.max(b.hrv.length, b.rhr.length);
          return `<div class="couple-row ${n < 5 ? 'thin' : ''}">
            <div class="couple-lbl"><b>${b.lbl}</b><small>${n} 晚</small></div>
            <div>${mh != null ? svgHBar((mh - minHrv * 0.8) / (maxHrv - minHrv * 0.8 || 1), css('--sys-sleep'), 9) : ''}</div>
            <div class="couple-vals"><span><b>${mh != null ? fmt(mh, 0) : '–'}</b> 毫秒</span><span><b>${mr != null ? fmt(mr, 0) : '–'}</b> 次/分</span></div>
          </div>`;
        }).join('');
        const solid = used.filter((b) => b.hrv.length >= 5);
        let headline = '样本还不够得出结论';
        if (solid.length >= 2) {
          const short = solid[0], long = solid[solid.length - 1];
          const diff = mean(long.hrv) - mean(short.hrv);
          headline = Math.abs(diff) < 3
            ? '睡得长短对第二天 HRV 的影响不明显'
            : `睡${/^\d/.test(long.lbl) ? ' ' : ''}${esc(long.lbl)}的夜晚，第二天 HRV 比${/^\d/.test(short.lbl) ? ' ' : ''}${esc(short.lbl)}的${diff > 0 ? '高' : '低'} ${N(fmt(Math.abs(diff), 0))} 毫秒`;
        }
        return cardShell(this, span, '', `<div class="couple-head"><span></span><span></span><span>第二天 HRV · 静息心率</span></div><div class="couple-rows">${rows}</div>`, { meta: '近 60 晚', headline });
      },
    },
    {
      id: 'trends.environment',
      tab: 'trends',
      title: '日照与噪音',
      system: 'env',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 7,
      render(p, span) {
        const floor = addDays(p.meta.today, -119);
        const dlRaw = (p.daily.daylight || []).filter(([d]) => d >= floor);
        const envRaw = (p.daily.env_audio || []).filter(([d]) => d >= floor);
        const dl = dlRaw.map(([d, v]) => [ms(d), v]);
        const env = envRaw.map(([d, v]) => [ms(d), v]);
        const recentDl = dlRaw.filter(([d]) => d >= addDays(p.meta.today, -29));
        const avgDl = recentDl.length ? mean(recentDl.map(([, v]) => v)) : null;
        const hitDl = recentDl.filter(([, v]) => v >= 30).length;
        const avgEnv = envRaw.length ? mean(envRaw.slice(-30).map(([, v]) => v)) : null;
        const headline = avgDl != null
          ? `近 30 天平均每天日照 ${N(fmt(avgDl))} 分钟，${N(hitDl)} 天达到 30 分钟`
          : '近 30 天没有日照记录';
        const c1 = dl.length ? svgLineChart({
          span: 'half', height: 130, area: true, target: 30, targetLabel: '30 分钟',
          series: [{ pts: movingAvg(dl, 7), color: css('--sys-food'), width: 2, area: true, tip: true }, { pts: dl, color: css('--sys-food'), dots: true, r: 1.8, opacity: 0.3 }],
          xfmt: (t) => md(new Date(t).toISOString()),
          tipfmt: (q) => `${md(new Date(q[0]).toISOString())} 7 天平均 ${fmt(q[1])} 分钟`,
        }) : emptyNote('没有日照记录。');
        const c2 = env.length ? svgLineChart({
          span: 'half', height: 120, target: 80, targetLabel: '80 分贝',
          series: [{ pts: env, color: css('--sys-env'), width: 1.6, tip: true }],
          xfmt: (t) => md(new Date(t).toISOString()),
          tipfmt: (q) => `${md(new Date(q[0]).toISOString())} 平均 ${fmt(q[1], 0)} 分贝`,
        }) : emptyNote('没有环境噪音记录。');
        const body = `<div class="horizon-grid">
          <div class="horizon-cell"><div class="horizon-head"><strong>户外日照</strong><span>近 120 天，7 天平均</span></div>${c1}</div>
          <div class="horizon-cell"><div class="horizon-head"><strong>环境噪音</strong><span>近 30 天平均 ${avgEnv != null ? fmt(avgEnv, 0) : '–'} 分贝</span></div>${c2}</div>
        </div>`;
        return cardShell(this, span, '', body, { headline });
      },
    },

    // ==================== TAB 4: HISTORY ====================
    {
      id: 'archive.odometer',
      tab: 'archive',
      title: '累计',
      system: 'move',
      defaultSpan: 'hero',
      allowSpanToggle: false,
      defaultEnabled: true,
      order: 1,
      render(p, span) {
        const lt = p.lifetime || {};
        const rec = lt.records || {};
        const years = lt.tracked_days ? lt.tracked_days / 365.25 : 0;
        const laps = lt.total_distance_km ? lt.total_distance_km / 40075 : 0;
        const tile = (label, big, unit, small) => `<div class="odo-tile"><span>${label}</span><b>${big}<em>${unit}</em></b><small>${small}</small></div>`;
        const odo = `<div class="odo-grid">
          ${tile('步数', fmt((lt.total_steps || 0) / 1e4, 0), '万步', `平均每天 ${fmt((lt.total_steps || 0) / (lt.tracked_days || 1))} 步`)}
          ${tile('步行和跑步', fmt(lt.total_distance_km), '公里', `相当于绕赤道 ${fmt(laps * 100, 0)}%`)}
          ${tile('活动消耗', fmt((lt.total_active_kcal || 0) / 1e4, 0), '万千卡', `平均每天 ${fmt((lt.total_active_kcal || 0) / (lt.tracked_days || 1))} 千卡`)}
          ${tile('体能训练', fmt(lt.total_workouts), '次', `共 ${fmt(lt.total_workout_hours)} 小时`)}
          ${tile('三环全满', fmt(lt.perfect_ring_days), '天', `活动环最长连续 ${fmt(lt.longest_move_streak)} 天`)}
        </div>`;
        const hofItems = [
          ['单日最多步数', rec.max_steps && `${fmt(rec.max_steps[1])} 步`, rec.max_steps?.[0]],
          ['单日最远距离', rec.max_distance_km && `${fmt(rec.max_distance_km[1], 1)} 公里`, rec.max_distance_km?.[0]],
          ['单日最多活动消耗', rec.max_active_kcal && `${fmt(rec.max_active_kcal[1])} 千卡`, rec.max_active_kcal?.[0]],
          ['最长一次训练', rec.longest_workout && `${hm(rec.longest_workout[1] / 60)}`, rec.longest_workout ? `${rec.longest_workout[0]} ${sportLabel(rec.longest_workout[2])}` : ''],
          ['最低静息心率', rec.min_rhr && `${fmt(rec.min_rhr[1], 0)} 次/分`, rec.min_rhr?.[0]],
          ['最高 HRV', rec.max_hrv && `${fmt(rec.max_hrv[1], 0)} 毫秒`, rec.max_hrv?.[0]],
        ];
        const hof = `<p class="hero-sub">个人纪录</p><div class="hof-grid">${hofItems.map(([lbl, val, sub]) => `<div class="hof-item"><span>${lbl}</span><b>${esc(val || '–')}</b><small>${esc(sub || '')}</small></div>`).join('')}</div>`;
        const headline = `${N(fmt(years, 1))} 年里走了 ${N(fmt((lt.total_steps || 0) / 1e4, 0))} 万步，约 ${N(fmt(lt.total_distance_km))} 公里`;
        return cardShell(this, span, '', `${odo}${hof}`, { meta: `${lt.first_day ? `${lt.first_day.slice(0, 4)} 年 ${+lt.first_day.slice(5, 7)} 月起，` : ''}${fmt(lt.tracked_days)} 天`, headline });
      },
    },
    {
      id: 'archive.year_heatmap',
      tab: 'archive',
      title: '年度日历',
      system: 'move',
      defaultSpan: 'wide',
      allowSpanToggle: false,
      defaultEnabled: true,
      order: 2,
      render(p, span, ctx) {
        const yearsMap = p.archive_years || {};
        const years = Object.keys(yearsMap).sort().reverse();
        if (!years.length) return cardShell(this, span, '', emptyNote('还没有跨年数据。'), { headline: '没有跨年数据' });
        const yr = heatYear && yearsMap[heatYear] ? heatYear : years[0];
        const byMmDd = Object.fromEntries((yearsMap[yr] || []).map((r) => [r[0], r]));
        const specs = {
          active_energy: { label: '活动', idx: 1, unit: '千卡', col: css('--ring-move'), target: ctx.targets.move_kcal, verb: '活动环合拢' },
          steps: { label: '步数', idx: 2, unit: '步', col: css('--sys-move'), target: ctx.targets.steps, verb: `走满 ${fmt(ctx.targets.steps)} 步` },
          exercise: { label: '锻炼', idx: 3, unit: '分钟', col: css('--ring-ex'), target: ctx.targets.exercise_minutes, verb: '锻炼环合拢' },
          sleep: { label: '睡眠', idx: 5, unit: '小时', col: css('--sys-sleep'), target: ctx.targets.sleep_hours, verb: `睡够 ${fmt(ctx.targets.sleep_hours)} 小时` },
        };
        const sp = specs[heatMetric] || specs.active_energy;
        const jan1Wd = weekdayIdx(`${yr}-01-01`);
        const y0 = Number(yr);
        const daysInYr = (y0 % 4 === 0 && y0 % 100 !== 0) || y0 % 400 === 0 ? 366 : 365;
        const W = 740, H = 120, L = 22, T = 18, cell = 11.4, gap = 2.2;
        const step = cell + gap;
        let g = '';
        const seenMonth = new Set();
        const cells = [];
        let yrSum = 0, yrDays = 0, yrHits = 0;
        for (let i = 0; i < daysInYr; i++) {
          const dt = new Date(Date.UTC(y0, 0, 1 + i));
          const iso = dt.toISOString().slice(0, 10);
          if (iso > p.meta.today) break;
          const mmdd = iso.slice(5, 10);
          const x = L + Math.floor((i + jan1Wd) / 7) * step, y = T + ((i + jan1Wd) % 7) * step;
          if (dt.getUTCDate() <= 7 && !seenMonth.has(dt.getUTCMonth())) {
            seenMonth.add(dt.getUTCMonth());
            g += `<text class="ax" x="${x.toFixed(1)}" y="11">${dt.getUTCMonth() + 1}月</text>`;
          }
          const val = byMmDd[mmdd]?.[sp.idx] ?? null;
          let op = 0.07, fill = css('--muted');
          if (val != null) {
            yrDays++; yrSum += val;
            if (val >= sp.target) yrHits++;
            const ratio = val / (sp.target || 1);
            fill = sp.col;
            op = ratio >= 1.35 ? 1 : ratio >= 1.0 ? 0.78 : ratio >= 0.65 ? 0.5 : ratio >= 0.3 ? 0.28 : 0.14;
          }
          g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="2.6" fill="${fill}" fill-opacity="${op}"/>`;
          cells.push({ cx: x + cell / 2, cy: y + cell / 2, tip: `${cn(iso)} ${val != null ? `${fmt(val, heatMetric === 'sleep' ? 1 : 0)} ${sp.unit}` : '没有记录'}` });
        }
        [['一', 0], ['三', 2], ['五', 4], ['日', 6]].forEach(([w, r]) => {
          g += `<text class="ax" x="12" y="${(T + r * step + 9).toFixed(1)}" text-anchor="end">${w}</text>`;
        });
        const id = `c${++chartSeq}`;
        charts.set(id, { mode: 'heat', W, H, cells });
        const pct = yrDays ? Math.round((yrHits / yrDays) * 100) : 0;
        const headline = `${yr} 年有 ${N(yrHits)} 天${esc(sp.verb)}，占记录天数的 ${N(pct + '%')}`;
        const tools = `${segHtml('data-heat-m', Object.entries(specs).map(([k, s]) => [k, s.label]), heatMetric, '指标')}
          <label class="select-wrap"><span class="sr-only">年份</span><select data-heat-y>${years.map((y) => `<option value="${y}" ${y === yr ? 'selected' : ''}>${y} 年</option>`).join('')}</select></label>`;
        const body = `<div class="fact-row"><span>有记录 <b>${yrDays}</b> 天</span><span>日均 <b>${yrDays ? fmt(yrSum / yrDays, heatMetric === 'sleep' ? 1 : 0) : '–'}</b> ${sp.unit}</span></div>
          <div class="chart heat-scroll" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${yr} 年每日${sp.label}">${g}</svg><div class="tip"></div></div>`;
        return cardShell(this, span, tools, body, { headline });
      },
      bind(el) {
        const sc = el.querySelector('.heat-scroll');
        if (sc) sc.scrollLeft = sc.scrollWidth;
        el.querySelector('[data-heat-y]')?.addEventListener('change', (ev) => { heatYear = ev.target.value; renderWorkspaceOnly(); });
        bindSeg(el, 'data-heat-m', (v) => { heatMetric = v; });
      },
    },
    {
      id: 'archive.horizon_strips',
      tab: 'archive',
      title: '长期走势',
      system: 'body',
      defaultSpan: 'wide',
      allowSpanToggle: false,
      defaultEnabled: true,
      order: 3,
      render(p, span) {
        const specs = [
          ['body_mass', '体重', '公斤', css('--sys-body'), 1],
          ['step_count', '日均步数', '步', css('--sys-move'), 0],
          ['resting_heart_rate', '静息心率', '次/分', css('--sys-heart'), 1],
          ['heart_rate_variability', '心率变异性 HRV', '毫秒', css('--sys-sleep'), 0],
          ['sleep_analysis', '睡眠时长', '小时', css('--sys-sleep'), 1],
          ['vo2_max', 'VO₂max', '', css('--ring-ex'), 1],
          ['walking_speed', '步行速度', '公里/时', css('--sys-body'), 1],
          ['active_energy', '日均活动消耗', '千卡', css('--ring-move'), 0],
        ];
        const yearTicks = (a, b) => {
          const out = [];
          for (let y = new Date(a).getUTCFullYear() + 1; y <= new Date(b).getUTCFullYear(); y += 2) out.push(Date.UTC(y, 0, 1));
          return out.length ? out : [a, b];
        };
        const strips = specs.map(([k, lbl, unit, col, dec]) => {
          const rows = (p.monthly && p.monthly[k]) || [];
          if (rows.length < 2) return '';
          const pts = rows.map(([m, v]) => [ms(m), v]);
          const first12 = mean(rows.slice(0, 12).map((r) => r[1]));
          const last12 = mean(rows.slice(-12).map((r) => r[1]));
          return `<div class="horizon-cell">
            <div class="horizon-head"><strong>${lbl}</strong><span>${rows[0][0].slice(0, 4)} 年 ${fmt(first12, dec)} → 近一年 <b>${fmt(last12, dec)}</b> ${unit}</span></div>
            ${svgLineChart({
              span: 'half', height: 112, pad: 0.12, area: true,
              series: [{ pts, color: col, width: 2, area: true, tip: true }],
              yfmt: (v) => fmt(v, dec),
              xfmt: (t) => `${new Date(t).getUTCFullYear()}`,
              xTicks: yearTicks,
              tipfmt: (q) => `${new Date(q[0]).toISOString().slice(0, 7)} ${fmt(q[1], dec)} ${unit}`,
            })}
          </div>`;
        }).filter(Boolean).join('');
        const steps = (p.monthly && p.monthly.step_count) || [];
        const headline = steps.length >= 24
          ? `近一年日均 ${N(fmt(mean(steps.slice(-12).map((r) => r[1]))))} 步，最早一年是 ${N(fmt(mean(steps.slice(0, 12).map((r) => r[1]))))} 步`
          : '各项指标的月度长期走势';
        return cardShell(this, span, '', `<div class="horizon-grid">${strips}</div>`, { headline });
      },
    },
    {
      id: 'archive.seasonality',
      tab: 'archive',
      title: '季节规律',
      system: 'env',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 4,
      render(p, span) {
        const map = {
          steps: ['step_count', '步数', '步', css('--sys-move'), 0, 'higher'],
          weight: ['body_mass', '体重', '公斤', css('--sys-body'), 1, 'neutral'],
          rhr: ['resting_heart_rate', '静息心率', '次/分', css('--sys-heart'), 1, 'lower'],
          sleep: ['sleep_analysis', '睡眠', '小时', css('--sys-sleep'), 1, 'higher'],
        };
        const [mKey, lbl, unit, col, dec] = map[seasonMetric] || map.steps;
        const rows = (p.monthly && p.monthly[mKey]) || [];
        const tools = segHtml('data-sea', Object.entries(map).map(([k, v]) => [k, v[1]]), seasonMetric, '指标');
        if (rows.length < 6) return cardShell(this, span, tools, emptyNote('跨年数据还不够。'), { headline: '数据不够' });
        const curYr = p.meta.today.slice(0, 4);
        const byMoHist = Array.from({ length: 12 }, () => []);
        const curPts = [];
        for (const [ym, v] of rows) {
          const mo = Number(ym.slice(5, 7)) - 1;
          if (ym.startsWith(curYr)) curPts.push([mo, v]);
          else byMoHist[mo].push(v);
        }
        const band = [], meanPts = [];
        for (let m = 0; m < 12; m++) {
          if (byMoHist[m].length) {
            band.push([m, Math.min(...byMoHist[m]), Math.max(...byMoHist[m])]);
            meanPts.push([m, mean(byMoHist[m])]);
          }
        }
        // Compare the latest complete month of this year with the same month in past years.
        const done = curPts.filter(([m]) => m < Number(p.meta.today.slice(5, 7)) - 1);
        const ref = last(done.length ? done : curPts);
        let headline = `${lbl}的月度季节规律`;
        if (ref && byMoHist[ref[0]].length) {
          const hist = mean(byMoHist[ref[0]]);
          const diff = ref[1] - hist;
          const pct = hist ? (diff / hist) * 100 : 0;
          headline = Math.abs(pct) < 3
            ? `今年 ${ref[0] + 1} 月${lbl}和往年同期差不多`
            : `今年 ${ref[0] + 1} 月${lbl}比往年同期${diff > 0 ? '高' : '低'} ${N(fmt(Math.abs(pct), 0) + '%')}`;
        }
        const body = `${svgLineChart({
          span, height: 170,
          series: [
            { pts: meanPts, band, color: css('--muted'), width: 1.6, dash: '4 4' },
            { pts: curPts, color: col, width: 2.6, dots: true, r: 3.2, opacity: 1, tip: true },
          ],
          yfmt: (v) => fmt(v, dec),
          xfmt: (t) => `${Math.round(t) + 1}月`,
          xTicks: () => [0, 3, 6, 9, 11],
          tipfmt: (q) => `${curYr} 年 ${Math.round(q[0]) + 1} 月 ${fmt(q[1], dec)} ${unit}`,
        })}
        ${legend([[col, `${curYr} 年`], ['--muted', '往年同月']])}`;
        return cardShell(this, span, tools, body, { headline });
      },
      bind(el) { bindSeg(el, 'data-sea', (v) => { seasonMetric = v; }); paintSwatches(el, {}); },
    },
    {
      id: 'archive.workout_eras',
      tab: 'archive',
      title: '历年训练',
      system: 'move',
      defaultSpan: 'half',
      allowSpanToggle: true,
      defaultEnabled: true,
      order: 5,
      render(p, span) {
        const wby = p.workouts_by_year || {};
        const years = Object.keys(wby).sort();
        const tools = segHtml('data-era', [['hours', '时长'], ['count', '次数']], workoutEraMode, '统计方式');
        if (!years.length) return cardShell(this, span, tools, emptyNote('还没有训练记录。'), { headline: '没有训练记录' });
        const hoursMode = workoutEraMode === 'hours';
        const totals = {};
        const yearTot = {};
        for (const yr of years) {
          for (const [act, [cnt, mins]] of Object.entries(wby[yr])) {
            totals[act] = (totals[act] || 0) + (hoursMode ? mins : cnt);
            yearTot[yr] = (yearTot[yr] || 0) + (hoursMode ? mins / 60 : cnt);
          }
        }
        const topActs = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
        const bars = years.map((yr) => {
          const stacks = topActs.map((act, idx) => {
            const pair = wby[yr][act];
            return { v: pair ? (hoursMode ? pair[1] / 60 : pair[0]) : 0, color: SPORT_COLORS[idx % SPORT_COLORS.length] };
          });
          let other = 0;
          for (const [act, [cnt, mins]] of Object.entries(wby[yr])) if (!topActs.includes(act)) other += hoursMode ? mins / 60 : cnt;
          if (other > 0) stacks.push({ v: other, color: css('--faint') });
          return { label: yr, stacks, tip: `${yr} 年 ${fmt(yearTot[yr], hoursMode ? 0 : 0)} ${hoursMode ? '小时' : '次'}` };
        });
        const best = Object.entries(yearTot).sort((a, b) => b[1] - a[1])[0];
        const headline = `训练最多的是 ${N(best[0])} 年，共 ${N(fmt(best[1]))} ${hoursMode ? '小时' : '次'}`;
        const body = `${svgBarChart({ span, bars, height: 170, yfmt: (v) => fmt(v, 0) })}
        ${legend(topActs.map((a, idx) => [SPORT_COLORS[idx % SPORT_COLORS.length], sportLabel(a)]))}`;
        return cardShell(this, span, tools, body, { headline });
      },
      bind(el) { bindSeg(el, 'data-era', (v) => { workoutEraMode = v; }); paintSwatches(el, {}); },
    },
  ];

  layoutState = loadLayout();

  // ---------- Date strip (Today) and page header
  function renderDateStrip(p, ctx) {
    const today = p.meta.today;
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
    const t = ctx.targets;
    const chips = days.map((d) => {
      const m = ctx.active[d] || 0, e = ctx.ex[d] || 0, st = ctx.stand[d] || 0;
      const hasMeal = Boolean(ctx.nutMap[d] || (p.meals_by_day && p.meals_by_day[d]?.length));
      const hasWo = Boolean(ctx.woByDay[d]?.length);
      return `<button type="button" class="day-chip" data-pick-day="${d}" aria-pressed="${selectedDay === d}" aria-label="${cn(d)}">
        <span class="wd">${d === today ? '今天' : '周' + wd(d)}</span>
        <span class="dn">${+d.slice(8)}</span>
        ${svgMiniRings(m / (t.move_kcal || 600), e / (t.exercise_minutes || 30), st / (t.stand_hours || 12), 24)}
        <span class="dot-row">${hasMeal ? '<i class="dot-meal" title="有饮食记录"></i>' : ''}${hasWo ? '<i class="dot-wo" title="有训练"></i>' : ''}</span>
      </button>`;
    }).join('');
    return `<section class="date-strip" aria-label="选择日期">${chips}</section>`;
  }

  function renderPageHead(p) {
    const tab = TABS.find((x) => x.id === activeTab);
    const d = selectedDay || p.meta.today;
    const title = activeTab === 'today' ? `${cn(d)} 周${wd(d)}` : tab.label;
    const back = activeTab === 'today' && d !== p.meta.today ? '<button type="button" class="text-btn" data-pick-day-reset>回到今天</button>' : '';
    return `<div class="page-head"><h1>${esc(title)}</h1>${back}</div>`;
  }

  // ---------- Topbar, popovers, composer drawer and shell
  function freshnessSummary(meta) {
    const off = meta.tz_offset_s || 28800;
    const snap = meta.snapshot_at ? new Date(Date.parse(meta.snapshot_at) + off * 1000).toISOString().slice(11, 16) : '–';
    const ing = meta.last_ingest ? meta.last_ingest.replace('T', ' ') : '';
    const ingestShort = ing ? (ing.slice(0, 10) === meta.today ? `今天 ${ing.slice(11, 16)}` : `${md(ing)} ${ing.slice(11, 16)}`) : '未知';
    const lag = !ing || ing.slice(0, 10) < addDays(meta.today, -1);
    return { snap, ingestShort, lag };
  }

  const ICON_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/></svg>';

  function renderTopbar(p) {
    const f = freshnessSummary(p.meta);
    const tabsHtml = TABS.map((t) => `<button type="button" class="tab-btn" role="tab" data-tab="${t.id}" aria-selected="${activeTab === t.id}">${TAB_ICONS[t.id]}<span>${t.label}</span></button>`).join('');
    const initial = esc(String(p.user || '我').slice(0, 1).toUpperCase());
    return `<header class="topbar">
      <div class="topbar-inner">
        <div class="brand-group">
          <button type="button" class="brand-link" data-tab="today" aria-label="Annulus 首页">${ICON_BRAND}<span class="brand-name">Annulus</span></button>
          <button type="button" class="fresh-pill" id="freshBtn" aria-expanded="${openPopover === 'fresh'}" title="数据同步状态">
            <i class="fresh-dot ${f.lag ? 'lag' : ''}"></i><span>${f.lag ? '同步滞后' : '已同步'} ${esc(f.ingestShort.replace('今天 ', ''))}</span>
          </button>
        </div>
        <nav class="tabnav" role="tablist" aria-label="视图">${tabsHtml}</nav>
        <div class="top-actions">
          <button type="button" class="round-btn ${composerOpen ? 'active' : ''}" id="composerBtn" aria-expanded="${composerOpen}" aria-label="调整卡片" title="调整卡片">${ICON_GRID}</button>
          <button type="button" class="round-btn avatar ${openPopover === 'account' ? 'active' : ''}" id="accountBtn" aria-expanded="${openPopover === 'account'}" aria-label="账户" title="账户">${initial}</button>
        </div>
      </div>
    </header>`;
  }

  function renderBottomDock() {
    const btns = TABS.map((t) => `<button type="button" class="dock-btn" data-tab="${t.id}" aria-selected="${activeTab === t.id}">${TAB_ICONS[t.id]}<span>${t.label}</span></button>`).join('');
    return `<nav class="tabdock" aria-label="视图">${btns}</nav>`;
  }

  function renderPopovers(p) {
    if (openPopover === 'fresh') {
      const f = freshnessSummary(p.meta);
      return `<aside class="popover" id="popoverBox" role="dialog" aria-label="同步状态">
        <h3>数据同步</h3>
        <p class="popover-sub">iPhone 上的 Marrow 打开或被系统唤醒时上传健康数据，看板每 10 分钟整理一次。</p>
        <div class="popover-kv">
          <div><span>iPhone 最近上传</span><b>${esc(f.ingestShort)}</b></div>
          <div><span>看板最近整理</span><b>${esc(f.snap)}</b></div>
          <div><span>最新数据日期</span><b>${p.meta.last_data_day ? cn(p.meta.last_data_day) : '–'}</b></div>
        </div>
        ${f.lag ? '<p class="popover-warn">超过一天没有收到新数据。打开 iPhone 上的 Marrow 即可同步。</p>' : ''}
      </aside>`;
    }
    if (openPopover === 'account') {
      return `<aside class="popover" id="popoverBox" role="dialog" aria-label="账户">
        <h3>${esc(p.user || '账户')}</h3>
        <form class="stack" id="pwform">
          <label>当前密码<input type="password" name="current_password" autocomplete="current-password" required></label>
          <label>新密码（至少 14 位）<input type="password" name="new_password" autocomplete="new-password" minlength="14" required></label>
          <label>再次输入新密码<input type="password" name="confirm_password" autocomplete="new-password" minlength="14" required></label>
          <p class="err" id="pwerr"></p>
          <button class="primary" type="submit">修改密码</button>
        </form>
        <div class="popover-actions">
          <button type="button" class="danger-link" id="logoutBtn">退出登录</button>
          <button type="button" class="ghost-btn" id="closePopoverBtn">关闭</button>
        </div>
      </aside>`;
    }
    return '';
  }

  function renderComposerDrawer() {
    if (!composerOpen) return '';
    const tab = TABS.find((t) => t.id === activeTab);
    const items = layoutState[activeTab] || [];
    const byId = Object.fromEntries(CARD_REGISTRY.map((c) => [c.id, c]));
    const rows = items.map((item, idx) => {
      const def = byId[item.id];
      if (!def) return '';
      return `<div class="composer-item ${item.enabled ? '' : 'off'}">
        <label class="composer-meta"><input type="checkbox" data-comp-toggle="${idx}" ${item.enabled ? 'checked' : ''}><strong>${esc(def.title)}</strong></label>
        <div class="composer-ctrl">
          ${def.allowSpanToggle ? `<button type="button" class="mini-btn" data-comp-span="${idx}" aria-pressed="${item.span === 'wide'}">${item.span === 'wide' ? '整行' : '半行'}</button>` : ''}
          <button type="button" class="mini-btn" data-comp-move="${idx}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
          <button type="button" class="mini-btn" data-comp-move="${idx}" data-dir="1" ${idx === items.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="drawer-backdrop" id="drawerBackdrop">
      <aside class="drawer" role="dialog" aria-label="调整「${esc(tab.label)}」的卡片">
        <div class="drawer-head">
          <h2>调整「${esc(tab.label)}」</h2>
          <button type="button" class="ghost-btn" id="closeComposerBtn">完成</button>
        </div>
        <p class="drawer-sub">勾选要显示的卡片，用箭头调整顺序。设置只保存在这台设备的浏览器里。</p>
        <div class="composer-list">${rows}</div>
        <div class="popover-actions">
          <button type="button" class="ghost-btn" id="resetLayoutBtn">恢复默认</button>
        </div>
      </aside>
    </div>`;
  }

  function currentCtx(p) {
    const ctx = buildLookups(p);
    ctx.day = selectedDay || p.meta.today;
    return ctx;
  }

  function renderWorkspaceHtml(p) {
    const ctx = currentCtx(p);
    const byId = Object.fromEntries(CARD_REGISTRY.map((c) => [c.id, c]));
    const items = (layoutState[activeTab] || []).filter((x) => x.enabled && byId[x.id]);
    const strip = activeTab === 'today' ? renderDateStrip(p, ctx) : '';
    const renderOne = (x, span, ord) => {
      let out;
      try { out = byId[x.id].render(p, span, ctx); } catch (e) {
        console.error(x.id, e);
        out = cardShell(byId[x.id], span, '', emptyNote('这张卡片暂时无法显示。'), {});
      }
      return out.replace('<article ', `<article data-ord="${ord}" `);
    };
    const twoCol = document.documentElement.clientWidth >= 920;
    const blocks = [];
    let run = [];
    const flush = () => {
      if (run.length === 1) blocks.push(renderOne(run[0], 'wide', 0));
      else if (run.length) {
        const cards = run.map((x, i) => renderOne(x, 'half', i)).join('');
        blocks.push(twoCol ? `<div class="duo"><div class="duo-col">${cards}</div><div class="duo-col"></div></div>` : cards);
      }
      run = [];
    };
    for (const x of items) {
      if (x.span === 'half' && byId[x.id].defaultSpan !== 'hero') run.push(x);
      else { flush(); blocks.push(renderOne(x, x.span, 0)); }
    }
    flush();
    const cardsHtml = items.length ? blocks.join('') : '<p class="empty-note">这个视图的卡片都隐藏了。点右上角的调整按钮重新打开。</p>';
    return `${renderPageHead(p)}${strip}<section class="bento" aria-label="${esc(activeTab)}">${cardsHtml}</section>`;
  }

  function bindWorkspace(root, p) {
    const ctx = currentCtx(p);
    const byId = Object.fromEntries(CARD_REGISTRY.map((c) => [c.id, c]));
    root.querySelectorAll('[data-pick-day]').forEach((b) => b.addEventListener('click', () => {
      selectedDay = b.dataset.pickDay;
      mealsExpanded = false;
      renderWorkspaceOnly();
    }));
    root.querySelector('[data-pick-day-reset]')?.addEventListener('click', () => { selectedDay = p.meta.today; renderWorkspaceOnly(); });
    root.querySelectorAll('[data-card]').forEach((el) => {
      const def = byId[el.dataset.card];
      if (def && def.bind) def.bind(el, p, ctx);
    });
    paintSwatches(root, {});
    bindCharts(root);
    balanceDuos(root);
    document.fonts?.ready.then(() => balanceDuos(root));
  }

  // Greedy placement: each card (in reading order) goes to the shorter column.
  function balanceDuos(root) {
    root.querySelectorAll('.duo').forEach((duo) => {
      const [a, b] = duo.querySelectorAll('.duo-col');
      const cards = [...duo.querySelectorAll('[data-ord]')].sort((x, y) => x.dataset.ord - y.dataset.ord);
      cards.forEach((c) => a.appendChild(c));
      const heights = cards.map((c) => c.offsetHeight);
      let ha = 0, hb = 0;
      cards.forEach((c, i) => {
        if (ha <= hb) { a.appendChild(c); ha += heights[i]; } else { b.appendChild(c); hb += heights[i]; }
      });
    });
  }

  function renderWorkspaceOnly() {
    if (!data) return;
    charts.clear();
    const ws = document.getElementById('workspace');
    if (!ws) { render(); return; }
    ws.innerHTML = renderWorkspaceHtml(data);
    bindWorkspace(ws, data);
  }

  function render() {
    const p = data;
    charts.clear();
    if (!selectedDay) selectedDay = p.meta.today;
    app.innerHTML = `${renderTopbar(p)}
      <div class="workspace" id="workspace">${renderWorkspaceHtml(p)}</div>
      ${renderBottomDock()}
      ${renderPopovers(p)}
      ${renderComposerDrawer()}`;

    bindWorkspace(document.getElementById('workspace'), p);

    app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      const next = b.dataset.tab;
      if (next === activeTab) return;
      activeTab = next;
      openPopover = null;
      history.replaceState(null, '', '#' + next);
      render();
      window.scrollTo({ top: 0, behavior: 'auto' });
    }));

    document.getElementById('freshBtn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openPopover = openPopover === 'fresh' ? null : 'fresh';
      render();
    });
    document.getElementById('accountBtn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openPopover = openPopover === 'account' ? null : 'account';
      render();
    });
    document.getElementById('closePopoverBtn')?.addEventListener('click', () => { openPopover = null; render(); });
    document.getElementById('composerBtn')?.addEventListener('click', () => {
      openPopover = null;
      composerOpen = !composerOpen;
      render();
    });
    document.getElementById('closeComposerBtn')?.addEventListener('click', () => { composerOpen = false; render(); });
    document.getElementById('drawerBackdrop')?.addEventListener('click', (ev) => {
      if (ev.target.id === 'drawerBackdrop') { composerOpen = false; render(); }
    });
    document.getElementById('resetLayoutBtn')?.addEventListener('click', () => {
      layoutState[activeTab] = defaultTabLayout(activeTab);
      saveLayout();
      render();
    });
    app.querySelectorAll('[data-comp-toggle]').forEach((b) => b.addEventListener('change', () => {
      const i = Number(b.dataset.compToggle);
      layoutState[activeTab][i].enabled = b.checked;
      saveLayout();
      render();
    }));
    app.querySelectorAll('[data-comp-span]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.compSpan);
      layoutState[activeTab][i].span = layoutState[activeTab][i].span === 'wide' ? 'half' : 'wide';
      saveLayout();
      render();
    }));
    app.querySelectorAll('[data-comp-move]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.compMove);
      const j = i + Number(b.dataset.dir);
      const arr = layoutState[activeTab];
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      saveLayout();
      render();
    }));

    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
      try { await api('/auth/logout', {}); } finally { login(); }
    });
    document.getElementById('pwform')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = document.getElementById('pwerr');
      err.textContent = '';
      try {
        await api('/auth/password', Object.fromEntries(new FormData(ev.target)));
        err.textContent = '密码已修改，其他设备需要重新登录。';
        ev.target.reset();
      } catch (e) {
        err.textContent = e.message;
      }
    });
  }

  function login(message) {
    openPopover = null;
    composerOpen = false;
    app.innerHTML = `<div class="login-wrap"><section class="login-card">
      <div class="login-brand">${ICON_BRAND}<h1>Annulus</h1></div>
      <p>登录查看你的健康数据。</p>
      <form class="stack" id="loginform">
        <label>账号<input name="username" autocomplete="username" required autocapitalize="off"></label>
        <label>密码<input type="password" name="password" autocomplete="current-password" required></label>
        <p class="err" id="lerr">${esc(message || '')}</p>
        <button class="primary" type="submit">登录</button>
      </form>
    </section></div>`;
    document.getElementById('loginform').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = document.getElementById('lerr');
      err.textContent = '';
      try {
        await api('/auth/login', Object.fromEntries(new FormData(ev.target)));
        await boot();
      } catch (e) {
        err.textContent = e.message;
      }
    });
  }

  async function boot() {
    try {
      data = await api('/api/ui/overview');
      csrf = data.csrf || '';
      render();
    } catch (e) {
      if (e.status === 401) login();
      else app.innerHTML = `<div class="boot-shell"><p class="boot-text">${esc(e.message)}</p><button type="button" class="ghost-btn" id="retryBtn">重新加载</button></div>`;
      document.getElementById('retryBtn')?.addEventListener('click', boot);
    }
  }

  document.addEventListener('click', (ev) => {
    if (openPopover && !ev.target.closest('#popoverBox') && !ev.target.closest('#freshBtn') && !ev.target.closest('#accountBtn')) {
      openPopover = null;
      render();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (composerOpen) { composerOpen = false; render(); } else if (openPopover) { openPopover = null; render(); }
  });
  let resizeTimer = 0, lastW = document.documentElement.clientWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = document.documentElement.clientWidth;
      if (data && w !== lastW) { lastW = w; renderWorkspaceOnly(); }
    }, 150);
  });
  window.addEventListener('hashchange', () => {
    const t = readHashTab();
    if (data && t !== activeTab) { activeTab = t; render(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (data) render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) boot(); });
  boot();
})();
