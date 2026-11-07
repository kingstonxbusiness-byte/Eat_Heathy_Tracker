/* NutriSync — AI 饮食 + 身体 + WHOOP 追踪 (单页 PWA)
 * 数据全部保存在本机浏览器 (localStorage)。AI 有两种模式：
 *  1) claude.ai 托管页面：使用内置 Claude (sample capability)，不需要 API key
 *  2) 自己托管 (GitHub Pages 等)：在设置里填自己的 API key (Anthropic / OpenAI / Gemini / OpenAI-compatible)
 */
(() => {
'use strict';

/* ---------------- 工具 ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const todayStr = () => fmtDate(new Date());
function fmtDate(d) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; }
function addDays(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDate(d); }
function nowTime() { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
const r0 = n => Math.round(+n || 0);
const r1 = n => Math.round((+n || 0) * 10) / 10;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function weekday(s) { return '日一二三四五六'[new Date(s + 'T00:00:00').getDay()]; }
function mdLabel(s) { return s.slice(5).replace('-', '/'); }

/* ---------------- 存储 ---------------- */
const KEY = 'nutrisync.v1';
const DEFAULT = {
  profile: { name: '', sex: 'male', age: 35, heightCm: 172, weightKg: 70, activity: 1.375, goal: 'maintain', proteinPerKg: 1.8, manualKcal: 0 },
  settings: { provider: 'anthropic', apiKey: '', model: '', baseUrl: '' },
  meals: [],    // {id,date,time,slot,items:[{name,portion,grams,calories,protein,carbs,fat,fiber}],note,thumb}
  weights: [],  // {date,kg,bodyFat,waist}
  whoop: [],    // {date,recovery,hrv,rhr,sleepPerf,sleepHours,inBedHours,deep,rem,light,awake,strain,spo2,skinTemp,respRate,sleepNeed,sleepDebt,efficiency,consistency,kcalBurned}
  insights: []  // {id,date,range,text}
};
let DB = load();
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const d = JSON.parse(raw); return { ...structuredClone(DEFAULT), ...d, profile: { ...DEFAULT.profile, ...(d.profile||{}) }, settings: { ...DEFAULT.settings, ...(d.settings||{}) } }; } } catch (e) { console.warn('load failed', e); }
  return structuredClone(DEFAULT);
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { toast('保存失败：浏览器存储已满或不可用'); } }

/* ---------------- UI 基础 ---------------- */
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }
function openModal(html) { $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; document.body.style.overflow = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
function confirmBox(msg, okText = '确定') {
  return new Promise(res => {
    openModal(`<h3>确认</h3><p>${esc(msg)}</p><div class="row" style="margin-top:14px"><button class="btn" id="cNo">取消</button><button class="btn danger" id="cOk">${esc(okText)}</button></div>`);
    $('#cNo').onclick = () => { closeModal(); res(false); };
    $('#cOk').onclick = () => { closeModal(); res(true); };
  });
}

/* ---------------- 营养目标计算 ---------------- */
function latestWeight() { const w = [...DB.weights].sort((a, b) => a.date < b.date ? 1 : -1)[0]; return w ? w.kg : DB.profile.weightKg; }
function targets() {
  const p = DB.profile, w = latestWeight();
  const bmr = p.sex === 'female' ? 10*w + 6.25*p.heightCm - 5*p.age - 161 : 10*w + 6.25*p.heightCm - 5*p.age + 5;
  const tdee = bmr * (+p.activity || 1.375);
  const adj = { lose: -500, lose_slow: -300, maintain: 0, gain_slow: 250, gain: 400 }[p.goal] ?? 0;
  const kcal = p.manualKcal > 0 ? p.manualKcal : Math.max(1200, tdee + adj);
  const protein = w * (+p.proteinPerKg || 1.8);
  const fat = kcal * 0.27 / 9;
  const carbs = Math.max(0, (kcal - protein*4 - fat*9) / 4);
  const bmi = w / Math.pow(p.heightCm/100, 2);
  return { bmr, tdee, kcal, protein, fat, carbs, bmi, weight: w };
}
function bmiCat(b) { return b < 18.5 ? ['偏瘦', 'pill-warn'] : b < 23 ? ['正常 (亚洲标准)', 'pill-ok'] : b < 27.5 ? ['超重', 'pill-warn'] : ['肥胖', 'pill-bad']; }

function dayTotals(date) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, meals: 0, lastTime: null, firstTime: null };
  for (const m of DB.meals) if (m.date === date) {
    t.meals++;
    for (const it of m.items) { t.calories += +it.calories||0; t.protein += +it.protein||0; t.carbs += +it.carbs||0; t.fat += +it.fat||0; t.fiber += +it.fiber||0; }
    if (!t.lastTime || m.time > t.lastTime) t.lastTime = m.time;
    if (!t.firstTime || m.time < t.firstTime) t.firstTime = m.time;
  }
  return t;
}

/* ---------------- AI 层 ---------------- */
const AI = {
  sample: null, sampleImages: false, ready: false,
  async init() {
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        const s = await Promise.race([window.claude.use('sample'), new Promise(r => setTimeout(() => r(null), 10000))]);
        if (s) { this.sample = s; try { const lim = await s.limits(); this.sampleImages = !!(lim && lim.images); } catch { this.sampleImages = true; } }
      }
    } catch (e) { console.warn('sample unavailable', e); }
    this.ready = true; renderBadge();
  },
  mode() { if (this.sample) return 'claude'; if (DB.settings.apiKey || DB.settings.provider === 'custom') return 'byok'; return 'none'; },
  label() {
    const m = this.mode();
    if (m === 'claude') return 'AI: Claude 内置' + (this.sampleImages ? '' : ' (无图)');
    if (m === 'byok') return 'AI: ' + ({ anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', custom: '自定义' }[DB.settings.provider] || DB.settings.provider);
    return 'AI: 未配置';
  },
  defaultModel(p) { return { anthropic: 'claude-sonnet-4-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', custom: 'llama3.2-vision' }[p] || ''; },
  /** 统一调用。images: [{blob, dataUrl, mediaType, b64}] */
  async ask({ system, user, images = [], onText, maxTokens = 2500 }) {
    const m = this.mode();
    if (m === 'none') throw new Error('尚未配置 AI。请到「设置」填入 API key，或在 claude.ai 中打开此页面。');
    if (m === 'claude') {
      const input = `${system}\n\n----\n\n${user}`;
      const opts = { modelTier: images.length ? 'default' : 'default', cache: false };
      if (onText) opts.onText = ({ text }) => onText(text);
      if (images.length && this.sampleImages) opts.images = images.map(i => i.blob);
      const res = await this.sample(input, opts);
      return res.text;
    }
    const s = DB.settings, model = s.model || this.defaultModel(s.provider);
    if (s.provider === 'anthropic') {
      const content = [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.b64 } })), { type: 'text', text: user }];
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
      return (j.content || []).map(c => c.text || '').join('');
    }
    if (s.provider === 'gemini') {
      const parts = [{ text: user }, ...images.map(i => ({ inline_data: { mime_type: i.mediaType, data: i.b64 } }))];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(s.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxTokens } }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
      return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
    // openai / custom (OpenAI-compatible: OpenRouter, Ollama, LM Studio…)
    const base = s.provider === 'custom' ? (s.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '') : 'https://api.openai.com/v1';
    const content = [{ type: 'text', text: user }, ...images.map(i => ({ type: 'image_url', image_url: { url: i.dataUrl } }))];
    const headers = { 'content-type': 'application/json' }; if (s.apiKey) headers.authorization = 'Bearer ' + s.apiKey;
    const r = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }] }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
    return j.choices?.[0]?.message?.content || '';
  }
};
function parseJSON(text) {
  if (!text) throw new Error('AI 没有返回内容');
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}'), c = t.indexOf('['), d = t.lastIndexOf(']');
  let cand = (a >= 0 && (c < 0 || a < c)) ? t.slice(a, b + 1) : t.slice(c, d + 1);
  try { return JSON.parse(cand); } catch (e) { throw new Error('AI 返回的不是有效 JSON：' + t.slice(0, 200)); }
}
function renderBadge() { const b = $('#aiBadge'); b.textContent = AI.label(); b.className = 'ai-badge ' + (AI.mode() === 'none' ? 'warn' : 'ok'); }

/* 图片压缩 → {blob,dataUrl,mediaType,b64,thumb} */
function prepImage(file, max = 1024, q = 0.85) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL('image/jpeg', q);
      const tc = document.createElement('canvas'); const ts = Math.min(1, 160 / Math.max(img.width, img.height)); tc.width = Math.round(img.width * ts); tc.height = Math.round(img.height * ts);
      tc.getContext('2d').drawImage(img, 0, 0, tc.width, tc.height);
      const thumb = tc.toDataURL('image/jpeg', 0.7);
      cv.toBlob(blob => { URL.revokeObjectURL(url); res({ blob, dataUrl, mediaType: 'image/jpeg', b64: dataUrl.split(',')[1], thumb }); }, 'image/jpeg', q);
    };
    img.onerror = () => rej(new Error('无法读取图片')); img.src = url;
  });
}

/* ---------------- 食物分析 ---------------- */
const FOOD_SYSTEM = `你是一位专业营养师。用户会给你一张食物照片和/或文字描述。请识别每一样食物，估算份量（用用户看得懂的单位，例如 1 cup / 1 碗 / 2 片 / 1 块手掌大小，并换算成克数），再按常用营养数据库 (USDA / 马来西亚食物成分表) 估算营养。
规则：
- 每样不同的食物一行；一道复合菜 (例如 nasi lemak, chicken rice, 咖喱鸡) 当一项，不拆配料，但份量要合理。
- 看不清或不确定也要给出最可能的估算，并用 confidence (0-1) 表示把握。
- 看得出来的油、酱汁、糖饮料也要算进去。
- 名称用简体中文，必要时在括号加英文/马来文原名。

同时你也是用户的私人健康教练。用户上传照片的时间就是他进食的时间。我会给你「进食情境」：几点吃、今天已吃了多少、距上一餐多久、今日目标剩余、他的减脂/增肌目标、今早 WHOOP recovery/睡眠。请结合运动营养学、昼夜节律 (circadian)、睡眠科学的知识，针对这一餐给 2–4 条简短、具体、可执行的建议 (例如：这餐蛋白不够，晚餐补到 40 g；距离睡觉不到 3 小时，碳水减半；进食窗口已超过 12 小时；今早 recovery 低，今天别再喝含糖饮料)。再给一句「下一餐建议」(吃什么、大约几点、多少 kcal / 蛋白)。语气像朋友，直接，不说教，不重复数字表格。
- 只输出 JSON，不要其它文字。格式：
{"items":[{"name":"","portion":"1 cup (约 180 g)","grams":180,"calories":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"confidence":0.8}],"meal_note":"一句话点评这餐 (中文)","advice":["建议1","建议2"],"next_meal":"下一餐建议一句话","timing_flag":"ok|late|long_gap|long_window|none"}`;

/** 组装「进食情境」给 AI：时间、今天已吃、距上一餐、目标剩余、WHOOP */
function mealContext(date, time, excludeId) {
  const tg = targets(), p = DB.profile;
  const prev = DB.meals.filter(m => m.date === date && m.id !== excludeId && m.time <= time).sort((a, b) => a.time < b.time ? -1 : 1);
  const eaten = prev.reduce((a, m) => ({ c: a.c + sum(m.items, 'calories'), p: a.p + sum(m.items, 'protein'), cb: a.cb + sum(m.items, 'carbs'), f: a.f + sum(m.items, 'fat') }), { c: 0, p: 0, cb: 0, f: 0 });
  const last = prev[prev.length - 1]; const first = prev[0];
  const gapH = last ? r1(toMin(time) - toMin(last.time)) / 60 : null;
  const windowH = first ? r1((toMin(time) - toMin(first.time)) / 60) : 0;
  const h = +time.slice(0, 2) + (+time.slice(3, 5)) / 60;
  const whoop = DB.whoop.find(x => x.date === date);
  const yday = DB.whoop.find(x => x.date === addDays(date, 1));
  const lines = [
    `进食时间：${date} (周${weekday(date)}) ${time}，属于${SLOT[slotFor(time)]}${h >= 21.5 || h < 4.5 ? '，属于深夜进食' : ''}`,
    `用户：${p.sex === 'female' ? '女' : '男'} ${p.age} 岁，${r1(tg.weight)} kg，BMI ${r1(tg.bmi)}，目标「${GOAL[p.goal]}」`,
    `每日目标：${r0(tg.kcal)} kcal，蛋白 ${r0(tg.protein)} g，碳水 ${r0(tg.carbs)} g，脂肪 ${r0(tg.fat)} g`,
    `这餐之前今天已吃：${r0(eaten.c)} kcal，蛋白 ${r0(eaten.p)} g，碳水 ${r0(eaten.cb)} g，脂肪 ${r0(eaten.f)} g (${prev.length} 餐${prev.length ? '：' + prev.map(m => `${m.time} ${m.items.map(i => i.name).join('/')}`).join('；') : ''})`,
    `目标剩余 (未算这餐)：${r0(tg.kcal - eaten.c)} kcal，蛋白 ${r0(tg.protein - eaten.p)} g`,
    last ? `距上一餐 ${r1(gapH)} 小时；今天第一餐 ${first.time}，到现在进食窗口 ${windowH} 小时` : '这是今天第一餐',
  ];
  if (whoop) lines.push(`今早 WHOOP：recovery ${whoop.recovery ?? '—'}%，睡眠 ${whoop.sleepHours ?? '—'} h，HRV ${whoop.hrv != null ? r0(whoop.hrv) : '—'} ms，RHR ${whoop.rhr ?? '—'}，strain ${whoop.strain ?? '—'}`);
  if (yday) lines.push(`(注意：这天之后隔天早上的 recovery 是 ${yday.recovery}%，可作为参考)`);
  const recentW = [...DB.weights].sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 7);
  if (recentW.length >= 2) lines.push(`最近体重：${recentW.map(w => `${mdLabel(w.date)} ${w.kg}`).join('，')}`);
  return lines.join('\n');
}
const toMin = t => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));

async function analyzeFood({ image, text, date, time, excludeId }) {
  const ctx = mealContext(date || todayStr(), time || nowTime(), excludeId);
  const user = `【进食情境】\n${ctx}\n\n【这餐】\n${text ? `用户补充说明：${text}\n${image ? '请结合照片分析。' : '没有照片，请根据文字估算。'}` : '请分析这张照片里的食物。'}`;
  const raw = await AI.ask({ system: FOOD_SYSTEM, user, images: image ? [image] : [] });
  const j = parseJSON(raw);
  const items = (j.items || []).map(it => ({ name: it.name || '未知食物', portion: it.portion || '', grams: r0(it.grams), calories: r0(it.calories), protein: r1(it.protein), carbs: r1(it.carbs), fat: r1(it.fat), fiber: r1(it.fiber), confidence: +it.confidence || 0 }));
  if (!items.length) throw new Error('AI 没有识别到食物，请换一张更清楚的照片或补充文字。');
  return { items, note: j.meal_note || '', advice: Array.isArray(j.advice) ? j.advice.filter(Boolean).slice(0, 5) : [], nextMeal: j.next_meal || '', flag: j.timing_flag || 'none' };
}

/** 不用 AI 也能算的进食时间统计 + 规则提示 */
function timingStats(date) {
  const ms = DB.meals.filter(m => m.date === date).sort((a, b) => a.time < b.time ? -1 : 1);
  if (!ms.length) return null;
  const first = ms[0].time, last = ms[ms.length - 1].time;
  const windowH = r1((toMin(last) - toMin(first)) / 60);
  let maxGap = 0; for (let i = 1; i < ms.length; i++) maxGap = Math.max(maxGap, (toMin(ms[i].time) - toMin(ms[i - 1].time)) / 60);
  const lastH = toMin(last) / 60; const tg = targets();
  const tips = [];
  if (lastH >= 21.5) tips.push(['late', `最后一餐在 ${last}，较晚。睡前 2–3 小时进食会影响深睡与隔天 recovery，尽量把大餐移到 20:00 前。`]);
  if (windowH > 12) tips.push(['long_window', `今天进食窗口 ${windowH} 小时，超过 12 小时。把窗口压到 10–12 小时 (例如 08:00–19:00) 对代谢与睡眠都有帮助。`]);
  if (maxGap >= 6 && ms.length > 1) tips.push(['long_gap', `两餐间隔最长 ${r1(maxGap)} 小时，容易在下一餐过量。中间可以加一份蛋白质小点 (希腊酸奶 / 水煮蛋)。`]);
  const perMealP = ms.map(m => sum(m.items, 'protein'));
  if (ms.length >= 2 && perMealP.filter(p => p < 25).length >= 2) tips.push(['protein', `有 ${perMealP.filter(p => p < 25).length} 餐蛋白质低于 25 g。每餐 30–40 g 蛋白质分布均匀，比集中在一餐更利于肌肉合成与饱腹。`]);
  const t = dayTotals(date);
  if (t.calories > tg.kcal * 1.15) tips.push(['over', `今天已超出目标 ${r0(t.calories - tg.kcal)} kcal。不用补偿性节食，明天正常吃、多走 20 分钟即可。`]);
  else if (lastH >= 19 && tg.kcal - t.calories > 500) tips.push(['under', `已是晚上但还剩 ${r0(tg.kcal - t.calories)} kcal。吃太少会影响睡眠与恢复，可补一份蛋白质 + 少量碳水 (例如鸡胸 + 半碗饭)。`]);
  return { first, last, windowH, maxGap: r1(maxGap), count: ms.length, tips };
}
function slotFor(time) { const h = +time.slice(0, 2); return h < 10.5 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snack'; }
const SLOT = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

/* 新增/编辑餐食 弹窗 */
function mealEditor({ meal, image, analyzing }) {
  const m = meal;
  openModal(`
    <h3>${m.id ? '编辑餐食' : '记录餐食'}</h3>
    ${image || m.thumb ? `<img class="preview" src="${image ? image.dataUrl : m.thumb}">` : ''}
    <div id="anaStatus" class="muted small" style="margin-bottom:8px">${analyzing ? '<span class="spinner"></span> AI 正在分析食物与份量…' : ''}</div>
    <div class="grid3" style="margin-bottom:10px">
      <div><label class="f">日期</label><input id="mDate" type="date" value="${m.date}"></div>
      <div><label class="f">进食时间${m.id ? '' : ' (= 上传时间)'}</label><input id="mTime" type="time" value="${m.time}"></div>
      <div><label class="f">餐别</label><select id="mSlot">${Object.entries(SLOT).map(([k, v]) => `<option value="${k}" ${m.slot === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div id="items"></div>
    <button class="btn sm" id="addItem" style="margin:10px 0">＋ 手动加一项</button>
    <div class="field"><label class="f">补充说明 (可选，例如「只吃了一半」「加了两勺糖」) — 填好后点「重新分析」</label>
      <div class="row"><input id="mNote" placeholder="例如：半碗饭，没喝汤" value="${esc(m.note || '')}"><button class="btn sm" id="reAna" ${AI.mode()==='none'?'disabled':''}>重新分析</button></div></div>
    <div id="aiNote" class="muted small"></div>
    <div id="advice"></div>
    <div class="card" style="margin:12px 0"><div class="row spread"><b>合计</b><b id="tot" class="num"></b></div></div>
    <div class="row"><button class="btn" id="mCancel">取消</button>${m.id ? '<button class="btn danger" id="mDel">删除</button>' : ''}<button class="btn primary" id="mSave" style="flex:1">保存</button></div>
  `);
  const list = $('#items');
  const drawAdvice = () => { $('#advice').innerHTML = adviceHTML(m); };
  const draw = () => {
    list.innerHTML = m.items.map((it, i) => `
      <div class="item-row" data-i="${i}">
        <div>
          <input class="nm" value="${esc(it.name)}" placeholder="食物名称">
          <input class="po" value="${esc(it.portion)}" placeholder="份量 (例如 1 cup / 150 g)" style="margin-top:6px;font-size:14px">
          <div class="meta">
            <div><label>kcal</label><input class="n" data-k="calories" type="number" inputmode="decimal" value="${it.calories}"></div>
            <div><label>蛋白 g</label><input class="n" data-k="protein" type="number" inputmode="decimal" value="${it.protein}"></div>
            <div><label>碳水 g</label><input class="n" data-k="carbs" type="number" inputmode="decimal" value="${it.carbs}"></div>
            <div><label>脂肪 g</label><input class="n" data-k="fat" type="number" inputmode="decimal" value="${it.fat}"></div>
            <div><label>纤维 g</label><input class="n" data-k="fiber" type="number" inputmode="decimal" value="${it.fiber}"></div>
          </div>
          ${it.confidence ? `<div class="small muted" style="margin-top:4px">AI 把握 ${Math.round(it.confidence*100)}%</div>` : ''}
        </div>
        <button class="btn sm danger rm">✕</button>
      </div>`).join('') || '<div class="empty">还没有项目</div>';
    tot();
  };
  const tot = () => { const s = m.items.reduce((a, it) => ({ c: a.c + (+it.calories||0), p: a.p + (+it.protein||0), cb: a.cb + (+it.carbs||0), f: a.f + (+it.fat||0) }), { c: 0, p: 0, cb: 0, f: 0 }); $('#tot').textContent = `${r0(s.c)} kcal · 蛋白 ${r0(s.p)} · 碳水 ${r0(s.cb)} · 脂肪 ${r0(s.f)}`; };
  list.addEventListener('input', e => { const row = e.target.closest('.item-row'); if (!row) return; const it = m.items[+row.dataset.i]; if (e.target.classList.contains('nm')) it.name = e.target.value; else if (e.target.classList.contains('po')) it.portion = e.target.value; else if (e.target.dataset.k) it[e.target.dataset.k] = +e.target.value || 0; tot(); });
  list.addEventListener('click', e => { if (e.target.classList.contains('rm')) { m.items.splice(+e.target.closest('.item-row').dataset.i, 1); draw(); } });
  $('#addItem').onclick = () => { m.items.push({ name: '', portion: '', grams: 0, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }); draw(); };
  $('#mCancel').onclick = closeModal;
  if ($('#mDel')) $('#mDel').onclick = async () => { if (await confirmBox('删除这餐记录？', '删除')) { DB.meals = DB.meals.filter(x => x.id !== m.id); save(); closeModal(); render(); } };
  $('#mSave').onclick = () => {
    m.date = $('#mDate').value || todayStr(); m.time = $('#mTime').value || nowTime(); m.slot = $('#mSlot').value; m.note = $('#mNote').value.trim();
    m.items = m.items.filter(it => it.name.trim());
    if (!m.items.length) return toast('请至少保留一项食物');
    if (image) m.thumb = image.thumb;
    if (!m.id) { m.id = uid(); DB.meals.push(m); }
    else { const i = DB.meals.findIndex(x => x.id === m.id); if (i >= 0) DB.meals[i] = m; else DB.meals.push(m); }
    save(); closeModal(); state.date = m.date; render(); toast('已保存 ✓');
  };
  const runAI = async () => {
    const note = $('#mNote').value.trim();
    if (!image && !note) return toast('请拍照或先填写说明');
    $('#anaStatus').innerHTML = '<span class="spinner"></span> AI 正在分析食物与份量…'; $('#reAna').disabled = true;
    try { const r = await analyzeFood({ image, text: note, date: $('#mDate').value || m.date, time: $('#mTime').value || m.time, excludeId: m.id }); m.items = r.items; m.aiNote = r.note; m.advice = r.advice; m.nextMeal = r.nextMeal; m.flag = r.flag; $('#aiNote').textContent = r.note ? '💬 ' + r.note : ''; draw(); drawAdvice(); $('#anaStatus').textContent = '分析完成，可以直接修改数字再保存。'; }
    catch (e) { $('#anaStatus').innerHTML = `<span class="pill-bad">分析失败：${esc(e.message)}</span>`; }
    finally { $('#reAna').disabled = false; }
  };
  $('#reAna').onclick = runAI;
  $('#mTime').addEventListener('change', e => { if (e.target.value) $('#mSlot').value = slotFor(e.target.value); });
  draw(); drawAdvice(); if (m.aiNote) $('#aiNote').textContent = '💬 ' + m.aiNote;
  if (analyzing) runAI();
}
function adviceHTML(m) {
  if (!(m.advice && m.advice.length) && !m.nextMeal) return '';
  const flagTxt = { late: '🌙 深夜进食', long_gap: '⏳ 间隔过久', long_window: '🕒 进食窗口过长' }[m.flag];
  return `<div class="card" style="margin:10px 0;border-color:#14532d"><h2>🧑‍⚕️ 教练建议${flagTxt ? ` · <span class="pill-warn">${flagTxt}</span>` : ''}</h2>
    <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.55">${(m.advice || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul>
    ${m.nextMeal ? `<div class="small" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)"><b>下一餐：</b>${esc(m.nextMeal)}</div>` : ''}</div>`;
}
async function startPhotoMeal(file) {
  if (!file) return;
  let image; try { image = await prepImage(file); } catch (e) { return toast(e.message); }
  const t = nowTime();
  mealEditor({ meal: { date: state.date, time: t, slot: slotFor(t), items: [], note: '' }, image, analyzing: AI.mode() !== 'none' });
  if (AI.mode() === 'none') toast('未配置 AI：请手动填写，或到设置里配置 API key', 4000);
}
function startTextMeal() {
  const t = nowTime();
  mealEditor({ meal: { date: state.date, time: t, slot: slotFor(t), items: [], note: '' }, image: null, analyzing: false });
  setTimeout(() => { $('#mNote').focus(); $('#anaStatus').textContent = '用文字描述你吃了什么，然后点「重新分析」让 AI 估算；或直接手动加项目。'; }, 50);
}

/* ---------------- WHOOP 导入 ---------------- */
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i+1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const norm = s => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const COLS = [ // [key, regex on normalized header, transform]
  ['recovery', /recovery score/], ['rhr', /resting heart rate/], ['hrv', /heart rate variability|hrv/], ['skinTemp', /skin temp/], ['spo2', /blood oxygen|spo2/],
  ['strain', /day strain|^strain/], ['kcalBurned', /energy burned|calories burned/], ['sleepPerf', /sleep performance/], ['respRate', /respiratory rate/],
  ['asleepMin', /asleep duration/], ['inBedMin', /in bed duration/], ['lightMin', /light sleep duration/], ['deepMin', /deep sws duration|sws duration|deep sleep/], ['remMin', /rem duration|rem sleep/], ['awakeMin', /awake duration/],
  ['sleepNeedMin', /sleep need/], ['sleepDebtMin', /sleep debt/], ['efficiency', /sleep efficiency/], ['consistency', /sleep consistency/],
  ['wake', /wake onset/], ['onset', /sleep onset/], ['cycleEnd', /cycle end time/], ['cycleStart', /cycle start time/],
];
function whoopFromCSV(text) {
  const rows = parseCSV(text); if (rows.length < 2) return [];
  const hdr = rows[0].map(norm); const idx = {};
  for (const [k, re] of COLS) { const i = hdr.findIndex(h => re.test(h)); if (i >= 0 && idx[k] === undefined) idx[k] = i; }
  if (idx.cycleStart === undefined && idx.wake === undefined && idx.onset === undefined) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const g = k => idx[k] === undefined ? '' : r[idx[k]];
    const n = k => { const v = parseFloat(g(k)); return isNaN(v) ? null : v; };
    const dateSrc = g('wake') || g('cycleEnd') || g('cycleStart'); if (!dateSrc) continue;
    const d = new Date(dateSrc.replace(' ', 'T')); let date = isNaN(d) ? dateSrc.slice(0, 10) : fmtDate(d);
    if (!g('wake') && !g('cycleEnd') && g('cycleStart') && !isNaN(d)) date = addDays(fmtDate(d), 1); // 周期从前一晚开始 → 记在隔天
    const rec = { date, recovery: n('recovery'), hrv: n('hrv'), rhr: n('rhr'), skinTemp: n('skinTemp'), spo2: n('spo2'), strain: n('strain'), kcalBurned: n('kcalBurned'), sleepPerf: n('sleepPerf'), respRate: n('respRate'), efficiency: n('efficiency'), consistency: n('consistency') };
    const mh = k => n(k) == null ? null : r1(n(k) / 60);
    rec.sleepHours = mh('asleepMin'); rec.inBedHours = mh('inBedMin'); rec.light = mh('lightMin'); rec.deep = mh('deepMin'); rec.rem = mh('remMin'); rec.awake = mh('awakeMin'); rec.sleepNeed = mh('sleepNeedMin'); rec.sleepDebt = mh('sleepDebtMin');
    if (rec.sleepHours == null && rec.light != null) rec.sleepHours = r1((rec.light||0)+(rec.deep||0)+(rec.rem||0));
    out.push(rec);
  }
  return out;
}
function whoopFromJSON(j) {
  const recs = Array.isArray(j) ? j : (j.records || j.data || j.sleep || j.recovery || []);
  const out = [];
  for (const x of recs) {
    if (!x || typeof x !== 'object') continue;
    if (x.date && (x.recovery != null || x.sleepHours != null)) { out.push(x); continue; } // 本 app 自己的格式
    const sc = x.score || {}; const when = x.end || x.updated_at || x.created_at || x.start; if (!when) continue;
    const date = fmtDate(new Date(when));
    const rec = { date };
    if (sc.recovery_score != null) { rec.recovery = sc.recovery_score; rec.hrv = sc.hrv_rmssd_milli; rec.rhr = sc.resting_heart_rate; rec.spo2 = sc.spo2_percentage; rec.skinTemp = sc.skin_temp_celsius; }
    if (sc.stage_summary) { const s = sc.stage_summary, h = v => v == null ? null : r1(v / 3.6e6); rec.inBedHours = h(s.total_in_bed_time_milli); rec.awake = h(s.total_awake_time_milli); rec.light = h(s.total_light_sleep_time_milli); rec.deep = h(s.total_slow_wave_sleep_time_milli); rec.rem = h(s.total_rem_sleep_time_milli); rec.sleepHours = r1((rec.light||0)+(rec.deep||0)+(rec.rem||0)); rec.sleepPerf = sc.sleep_performance_percentage; rec.efficiency = sc.sleep_efficiency_percentage; rec.consistency = sc.sleep_consistency_percentage; rec.respRate = sc.respiratory_rate; if (sc.sleep_needed) rec.sleepNeed = r1((sc.sleep_needed.baseline_milli||0)/3.6e6); }
    if (sc.strain != null) { rec.strain = sc.strain; rec.kcalBurned = sc.kilojoule ? r0(sc.kilojoule / 4.184) : null; }
    out.push(rec);
  }
  return out;
}
const WHOOP_IMG_SYSTEM = `你是数据提取助手。用户会上传 WHOOP app 的截图（可能是 Recovery、Sleep、Strain 或 Overview 页面，也可能是周报/月报）。请把能读到的数字提取成 JSON 数组，每一天一个对象。日期如果截图没有年份，就用用户提供的参考日期推断。字段（读不到就省略）：
[{"date":"YYYY-MM-DD","recovery":0-100,"hrv":ms,"rhr":bpm,"spo2":%,"skinTemp":摄氏,"strain":0-21,"sleepPerf":%,"sleepHours":小时(小数),"inBedHours":小时,"deep":小时,"rem":小时,"light":小时,"awake":小时,"sleepNeed":小时,"sleepDebt":小时,"efficiency":%,"consistency":%,"respRate":rpm,"kcalBurned":kcal}]
只输出 JSON 数组。`;
function mergeWhoop(recs) {
  let n = 0;
  for (const r of recs) { if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue; const ex = DB.whoop.find(x => x.date === r.date); const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && v !== '')); if (ex) Object.assign(ex, clean); else DB.whoop.push({ ...clean }); n++; }
  DB.whoop.sort((a, b) => a.date < b.date ? -1 : 1); save(); return n;
}
async function importWhoopFiles(files) {
  let total = 0;
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) { toast('请先解压 zip，再选择里面的 CSV 文件 (physiological_cycles.csv / sleeps.csv)', 5000); continue; }
    const text = await f.text(); const recs = whoopFromCSV(text);
    if (!recs.length) { toast(`${f.name}：没有识别到 WHOOP 栏位`, 4000); continue; }
    total += mergeWhoop(recs);
  }
  if (total) { toast(`已导入/更新 ${total} 天 WHOOP 数据 ✓`); render(); }
}
async function importWhoopScreenshot(file) {
  if (AI.mode() === 'none') return toast('截图识别需要 AI，请先配置');
  let image; try { image = await prepImage(file, 1400, 0.9); } catch (e) { return toast(e.message); }
  openModal(`<h3>识别 WHOOP 截图</h3><img class="preview" src="${image.dataUrl}"><div class="field"><label class="f">这张截图对应的日期 (参考)</label><input id="wRef" type="date" value="${state.date}"></div><div id="wSt" class="muted small"></div><div class="row" style="margin-top:10px"><button class="btn" id="wC">取消</button><button class="btn primary" id="wGo" style="flex:1">开始识别</button></div>`);
  $('#wC').onclick = closeModal;
  $('#wGo').onclick = async () => {
    $('#wGo').disabled = true; $('#wSt').innerHTML = '<span class="spinner"></span> 读取中…';
    try { const raw = await AI.ask({ system: WHOOP_IMG_SYSTEM, user: `参考日期：${$('#wRef').value}。请提取截图中的数据。`, images: [image] }); let j = parseJSON(raw); if (!Array.isArray(j)) j = [j]; const n = mergeWhoop(j); closeModal(); toast(n ? `已导入 ${n} 天 ✓` : '没有读到可用数据'); render(); }
    catch (e) { $('#wSt').innerHTML = `<span class="pill-bad">${esc(e.message)}</span>`; $('#wGo').disabled = false; }
  };
}

/* ---------------- AI 洞察 ---------------- */
function buildDataset(days) {
  const end = state.date, rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(end, -i); const t = dayTotals(d); const w = DB.weights.find(x => x.date === d); const h = DB.whoop.find(x => x.date === d); const hn = DB.whoop.find(x => x.date === addDays(d, 1));
    const row = { date: d, weekday: weekday(d) };
    const ts = timingStats(d);
    if (t.meals) Object.assign(row, { kcal: r0(t.calories), protein_g: r0(t.protein), carbs_g: r0(t.carbs), fat_g: r0(t.fat), fiber_g: r0(t.fiber), meals: t.meals, first_meal: t.firstTime, last_meal: t.lastTime, eating_window_h: ts?.windowH, late_night_eating: ts ? toMin(ts.last) >= 21.5 * 60 : undefined, foods: DB.meals.filter(m => m.date === d).flatMap(m => m.items.map(i => i.name)).join('、') });
    if (w) Object.assign(row, { weight_kg: w.kg, body_fat: w.bodyFat || undefined, waist_cm: w.waist || undefined });
    if (h) row.whoop_this_morning = h;
    if (hn) row.whoop_next_morning = { recovery: hn.recovery, hrv: hn.hrv, rhr: hn.rhr, sleepPerf: hn.sleepPerf, sleepHours: hn.sleepHours, deep: hn.deep, rem: hn.rem, efficiency: hn.efficiency };
    if (Object.keys(row).length > 2) rows.push(row);
  }
  return rows;
}
const INSIGHT_SYSTEM = `你是一位结合运动营养学与睡眠科学的健康教练，说话直接、具体、有数据支撑，用简体中文（专业名词保留英文，例如 HRV、recovery、deep sleep、protein）。
用户会给你：个人资料与目标、每日饮食 (kcal / macros / 第一餐与最后一餐时间 / 进食窗口 eating_window_h / 是否深夜进食 / 吃了什么)、体重、以及 WHOOP 数据 (recovery、HRV、RHR、睡眠)。注意 "whoop_next_morning" 是「这一天的饮食之后、隔天早上」的 WHOOP 结果，用它来找饮食 → 睡眠/恢复的关系。
请输出 Markdown，结构：
## 总览 (3 句以内)
## 饮食 vs 目标
## 进食时间模式 (进食窗口、最后一餐时间、间隔，对照睡眠)
## 睡眠 & 恢复与饮食的关联 (指出具体日期与数字；样本少就说明是初步观察)
## 体重趋势
## 接下来 7 天的 3 个具体行动
规则：不要编造没有的数据；数据不足要直说；不要给医疗诊断；少讲大道理，多讲可执行的事。`;
async function runInsight(days) {
  const rows = buildDataset(days); const tg = targets(), p = DB.profile;
  if (!rows.length) throw new Error('这段时间没有任何数据，先记录几餐或导入 WHOOP 吧。');
  const user = `个人资料：${p.sex === 'female' ? '女' : '男'}，${p.age} 岁，身高 ${p.heightCm} cm，当前体重 ${r1(tg.weight)} kg，BMI ${r1(tg.bmi)}，目标：${GOAL[p.goal]}。每日目标：${r0(tg.kcal)} kcal，蛋白 ${r0(tg.protein)} g，碳水 ${r0(tg.carbs)} g，脂肪 ${r0(tg.fat)} g。\n统计区间：最近 ${days} 天 (截至 ${state.date})。\n数据 (JSON)：\n${JSON.stringify(rows)}`;
  return AI.ask({ system: INSIGHT_SYSTEM, user, maxTokens: 3000 });
}
function md(t) {
  const lines = String(t || '').split('\n'); let out = '', inUl = false;
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  for (const l of lines) {
    const m = l.match(/^(#{1,3})\s+(.*)/); const li = l.match(/^\s*[-*]\s+(.*)/); const ol = l.match(/^\s*\d+[.)]\s+(.*)/);
    if (li || ol) { if (!inUl) { out += '<ul>'; inUl = true; } out += `<li>${inline((li || ol)[1])}</li>`; continue; }
    if (inUl) { out += '</ul>'; inUl = false; }
    if (m) out += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; else if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  if (inUl) out += '</ul>'; return out;
}

/* ---------------- 图表 (SVG) ---------------- */
function lineChart(series, { height = 170, yMin, yMax, unit = '' } = {}) {
  const W = 600, H = height, pl = 36, pr = 10, pt = 10, pb = 24;
  const all = series.flatMap(s => s.points.map(p => p.y)).filter(v => v != null);
  if (!all.length) return `<div class="empty">暂无数据</div>`;
  let lo = yMin ?? Math.min(...all), hi = yMax ?? Math.max(...all); if (hi - lo < 1) { hi += 1; lo -= 1; } const pad = (hi - lo) * 0.1; if (yMin == null) lo -= pad; if (yMax == null) hi += pad;
  const xs = [...new Set(series.flatMap(s => s.points.map(p => p.x)))].sort();
  const X = x => pl + (xs.length === 1 ? 0.5 : xs.indexOf(x) / (xs.length - 1)) * (W - pl - pr);
  const Y = y => pt + (1 - (y - lo) / (hi - lo)) * (H - pt - pb);
  let g = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">`;
  for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3, y = Y(v); g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#262b36" stroke-width="1"/><text x="${pl - 6}" y="${y + 4}" fill="#8b93a7" font-size="11" text-anchor="end">${r1(v)}${unit}</text>`; }
  const step = Math.ceil(xs.length / 6); xs.forEach((x, i) => { if (i % step === 0 || i === xs.length - 1) g += `<text x="${X(x)}" y="${H - 6}" fill="#8b93a7" font-size="11" text-anchor="middle">${mdLabel(x)}</text>`; });
  for (const s of series) {
    const pts = s.points.filter(p => p.y != null).sort((a, b) => a.x < b.x ? -1 : 1); if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
    pts.forEach(p => g += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="${s.color}"/>`);
  }
  return g + '</svg>';
}
function barChart(points, { color = '#4ade80', target, height = 170 } = {}) {
  const W = 600, H = height, pl = 36, pr = 10, pt = 10, pb = 24;
  if (!points.some(p => p.y)) return `<div class="empty">暂无数据</div>`;
  const hi = Math.max(...points.map(p => p.y || 0), target || 0) * 1.1 || 1;
  const bw = (W - pl - pr) / points.length; const Y = y => pt + (1 - y / hi) * (H - pt - pb);
  let g = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">`;
  for (let i = 0; i <= 3; i++) { const v = hi * i / 3, y = Y(v); g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#262b36"/><text x="${pl - 6}" y="${y + 4}" fill="#8b93a7" font-size="11" text-anchor="end">${r0(v)}</text>`; }
  points.forEach((p, i) => { const x = pl + i * bw + bw * 0.15, w = bw * 0.7; if (p.y) g += `<rect x="${x}" y="${Y(p.y)}" width="${w}" height="${Y(0) - Y(p.y)}" rx="3" fill="${target && p.y > target * 1.1 ? '#f87171' : color}" opacity=".9"/>`; if (points.length <= 14 || i % Math.ceil(points.length / 7) === 0) g += `<text x="${x + w / 2}" y="${H - 6}" fill="#8b93a7" font-size="11" text-anchor="middle">${mdLabel(p.x)}</text>`; });
  if (target) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(target)}" y2="${Y(target)}" stroke="#fbbf24" stroke-dasharray="5 4" stroke-width="1.5"/>`;
  return g + '</svg>';
}

/* ---------------- 页面 ---------------- */
const GOAL = { lose: '减脂 (−500 kcal/天)', lose_slow: '温和减脂 (−300)', maintain: '维持', gain_slow: '温和增肌 (+250)', gain: '增重 (+400)' };
const state = { tab: 'today', date: todayStr(), range: 14, insightRange: 14 };

function render() {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  const v = $('#view'); v.innerHTML = ({ today: vToday, trends: vTrends, body: vBody, whoop: vWhoop, insight: vInsight, settings: vSettings }[state.tab])();
  bind();
}
function ringSVG(pct, color, size = 150) { const r = 62, c = 2 * Math.PI * r, off = c * (1 - clamp(pct, 0, 1)); return `<svg width="${size}" height="${size}" viewBox="0 0 150 150"><circle cx="75" cy="75" r="${r}" stroke="#1e222b" stroke-width="12" fill="none"/><circle cx="75" cy="75" r="${r}" stroke="${pct > 1.1 ? '#f87171' : color}" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" style="transition:stroke-dashoffset .5s"/></svg>`; }

function vToday() {
  const t = dayTotals(state.date), tg = targets(); const left = tg.kcal - t.calories;
  const whoop = DB.whoop.find(x => x.date === state.date);
  const macro = (l, v, g, cls) => `<div><div class="row spread small"><span class="muted">${l}</span><span class="num">${r0(v)} / ${r0(g)} g</span></div><div class="bar"><i style="width:${clamp(v / g * 100, 0, 100)}%;background:var(--${cls})"></i></div></div>`;
  const meals = DB.meals.filter(m => m.date === state.date).sort((a, b) => a.time < b.time ? -1 : 1);
  const ts = timingStats(state.date);
  return `
  <div class="datebar"><button class="btn sm" data-act="prevDay">‹</button><b>${state.date === todayStr() ? '今天' : state.date} · 周${weekday(state.date)}</b><button class="btn sm" data-act="nextDay" ${state.date >= todayStr() ? 'disabled' : ''}>›</button></div>
  <div class="card">
    <div class="row" style="align-items:center;gap:16px">
      <div class="ring">${ringSVG(t.calories / tg.kcal, '#4ade80')}<div class="c"><div class="big num">${r0(Math.abs(left))}</div><div class="small muted">${left >= 0 ? 'kcal 剩余' : 'kcal 超出'}</div></div></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:10px">
        ${macro('蛋白质 Protein', t.protein, tg.protein, 'pro')}${macro('碳水 Carbs', t.carbs, tg.carbs, 'carb')}${macro('脂肪 Fat', t.fat, tg.fat, 'fat')}
      </div>
    </div>
    <div class="row spread small muted" style="margin-top:10px"><span>已摄入 ${r0(t.calories)} / 目标 ${r0(tg.kcal)} kcal</span><span>纤维 ${r0(t.fiber)} g</span></div>
  </div>
  ${whoop ? `<div class="card"><h2>今早 WHOOP</h2><div class="grid3">${stat('Recovery', whoop.recovery != null ? whoop.recovery + '%' : '—', recColor(whoop.recovery))}${stat('睡眠', whoop.sleepHours != null ? whoop.sleepHours + ' h' : '—')}${stat('HRV', whoop.hrv != null ? r0(whoop.hrv) + ' ms' : '—')}</div></div>` : ''}
  <div class="fab-row">
    <button class="btn primary" data-act="photo">📷 拍照记录</button>
    <button class="btn" data-act="gallery">🖼️ 相册</button>
    <button class="btn" data-act="text">✍️ 文字/手动</button>
  </div>
  ${ts ? `<div class="card"><h2>⏰ 进食时间</h2>
    <div class="grid3">${stat('第一餐', ts.first)}${stat('最后一餐', ts.last, +ts.last.slice(0,2) >= 21.5 ? 'pill-warn' : '')}${stat('进食窗口', ts.windowH + ' h', ts.windowH > 12 ? 'pill-warn' : 'pill-ok')}</div>
    ${ts.tips.length ? `<ul style="margin:10px 0 0;padding-left:18px;font-size:13px;line-height:1.5;color:#c9cfdc">${ts.tips.map(([, t]) => `<li>${esc(t)}</li>`).join('')}</ul>` : `<div class="small muted" style="margin-top:8px">${ts.count} 餐，间隔最长 ${ts.maxGap} h · 时间安排不错 👍</div>`}
  </div>` : ''}
  <div class="card"><h2>今日餐食</h2>
    ${meals.length ? meals.map(m => `<div class="meal" data-meal="${m.id}">${m.thumb ? `<img src="${m.thumb}">` : `<div class="ph">${{ breakfast: '🌅', lunch: '☀️', dinner: '🌙', snack: '🍪' }[m.slot] || '🍽️'}</div>`}<div class="t"><b>${esc(m.items.map(i => i.name).join('、'))}</b><div class="small muted">${SLOT[m.slot]} · ${m.time}${m.items[0]?.portion ? ' · ' + esc(m.items.map(i => i.portion).filter(Boolean).slice(0, 2).join('，')) : ''}</div><div style="margin-top:4px"><span class="chip">${r0(sum(m.items, 'calories'))} kcal</span><span class="chip p">P ${r0(sum(m.items, 'protein'))}</span><span class="chip c">C ${r0(sum(m.items, 'carbs'))}</span><span class="chip f">F ${r0(sum(m.items, 'fat'))}</span></div>${m.advice && m.advice.length ? `<div class="small" style="margin-top:6px;color:#a7f3d0">💡 ${esc(m.advice[0])}${m.advice.length > 1 ? ` <span class="muted">(+${m.advice.length - 1}，点开查看)</span>` : ''}</div>` : ''}</div></div>`).join('') : '<div class="empty">还没有记录。拍一张食物照片，AI 会帮你估算卡路里、蛋白质和份量。</div>'}
  </div>`;
}
const sum = (arr, k) => arr.reduce((a, x) => a + (+x[k] || 0), 0);
const stat = (l, v, cls = '') => `<div class="stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`;
const recColor = r => r == null ? '' : r >= 67 ? 'pill-ok' : r >= 34 ? 'pill-warn' : 'pill-bad';

function vTrends() {
  const tg = targets(); const days = state.range; const xs = []; for (let i = days - 1; i >= 0; i--) xs.push(addDays(state.date, -i));
  const tots = xs.map(d => ({ d, t: dayTotals(d) }));
  const logged = tots.filter(x => x.t.meals); const avg = k => logged.length ? logged.reduce((a, x) => a + x.t[k], 0) / logged.length : 0;
  return `
  <div class="seg" style="margin-bottom:12px">${[7, 14, 30, 90].map(n => `<button data-range="${n}" class="${state.range === n ? 'on' : ''}">${n} 天</button>`).join('')}</div>
  <div class="card"><h2>每日热量 (虚线 = 目标 ${r0(tg.kcal)})</h2>${barChart(tots.map(x => ({ x: x.d, y: r0(x.t.calories) })), { target: tg.kcal })}
    <div class="grid3" style="margin-top:10px">${stat('平均 kcal', r0(avg('calories')))}${stat('平均蛋白', r0(avg('protein')) + ' g')}${stat('记录天数', logged.length + '/' + days)}</div></div>
  <div class="card"><h2>宏量营养 (g)</h2>${lineChart([{ color: '#60a5fa', points: tots.map(x => ({ x: x.d, y: x.t.meals ? r0(x.t.protein) : null })) }, { color: '#fbbf24', points: tots.map(x => ({ x: x.d, y: x.t.meals ? r0(x.t.carbs) : null })) }, { color: '#f472b6', points: tots.map(x => ({ x: x.d, y: x.t.meals ? r0(x.t.fat) : null })) }], { yMin: 0 })}
    <div class="legend"><span><i style="background:#60a5fa"></i>蛋白</span><span><i style="background:#fbbf24"></i>碳水</span><span><i style="background:#f472b6"></i>脂肪</span></div></div>
  <div class="card"><h2>进食时间 (第一餐 / 最后一餐，小时)</h2>${lineChart([{ color: '#fbbf24', points: xs.map(d => { const t = timingStats(d); return { x: d, y: t ? r1(toMin(t.first) / 60) : null }; }) }, { color: '#a78bfa', points: xs.map(d => { const t = timingStats(d); return { x: d, y: t ? r1(toMin(t.last) / 60) : null }; }) }], { yMin: 4, yMax: 24 })}
    <div class="legend"><span><i style="background:#fbbf24"></i>第一餐</span><span><i style="background:#a78bfa"></i>最后一餐</span></div>
    ${(() => { const w = xs.map(d => timingStats(d)).filter(Boolean); if (!w.length) return ''; const avgW = r1(w.reduce((a, t) => a + t.windowH, 0) / w.length); const late = w.filter(t => toMin(t.last) >= 21.5 * 60).length; return `<div class="grid3" style="margin-top:10px">${stat('平均窗口', avgW + ' h', avgW > 12 ? 'pill-warn' : 'pill-ok')}${stat('21:30 后进食', late + ' 天', late ? 'pill-warn' : 'pill-ok')}${stat('平均餐数', r1(w.reduce((a, t) => a + t.count, 0) / w.length))}</div>`; })()}</div>
  <div class="card"><h2>热量 vs 隔天 Recovery</h2>${lineChart([{ color: '#4ade80', points: tots.map(x => ({ x: x.d, y: x.t.meals ? r0(x.t.calories / 50) : null })) }, { color: '#a78bfa', points: xs.map(d => { const h = DB.whoop.find(w => w.date === addDays(d, 1)); return { x: d, y: h?.recovery ?? null }; }) }])}
    <div class="legend"><span><i style="background:#4ade80"></i>kcal ÷ 50</span><span><i style="background:#a78bfa"></i>隔天 Recovery %</span></div>
    <div class="small muted" style="margin-top:6px">两条线放一起看：高热量 / 晚吃的日子，隔天 recovery 是否偏低。要 AI 帮你解读请到「洞察」。</div></div>`;
}

function vBody() {
  const tg = targets(), p = DB.profile; const [cat, cls] = bmiCat(tg.bmi);
  const ws = [...DB.weights].sort((a, b) => a.date < b.date ? -1 : 1); const recent = ws.slice(-state.range);
  const first = recent[0], last = recent[recent.length - 1]; const delta = first && last && first !== last ? r1(last.kg - first.kg) : null;
  return `
  <div class="card"><h2>身体状况</h2>
    <div class="grid3">${stat('体重', r1(tg.weight) + ' kg')}${stat('BMI', `<span class="${cls}">${r1(tg.bmi)}</span>`)}${stat('分类', `<span class="${cls}" style="font-size:14px">${cat}</span>`)}</div>
    <div class="grid3" style="margin-top:10px">${stat('BMR', r0(tg.bmr))}${stat('TDEE', r0(tg.tdee))}${stat('目标 kcal', r0(tg.kcal))}</div>
    ${last?.bodyFat || last?.waist ? `<div class="grid2" style="margin-top:10px">${last.bodyFat ? stat('体脂率', last.bodyFat + ' %') : ''}${last.waist ? stat('腰围', last.waist + ' cm') : ''}</div>` : ''}
    <div class="small muted" style="margin-top:8px">BMI 分类采用亚洲人标准 (WHO 亚太)：&lt;18.5 偏瘦，18.5–22.9 正常，23–27.4 超重，≥27.5 肥胖。目标热量 = TDEE (Mifflin-St Jeor × 活动系数) ± 目标调整，可在设置手动覆盖。</div>
  </div>
  <div class="card"><h2>记录今天</h2>
    <div class="grid3"><div><label class="f">体重 kg</label><input id="wKg" type="number" step="0.1" inputmode="decimal" value="${last?.date === state.date ? last.kg : ''}" placeholder="${r1(tg.weight)}"></div><div><label class="f">体脂 % (选填)</label><input id="wBf" type="number" step="0.1" inputmode="decimal" value="${last?.date === state.date ? (last.bodyFat ?? '') : ''}"></div><div><label class="f">腰围 cm (选填)</label><input id="wWa" type="number" step="0.1" inputmode="decimal" value="${last?.date === state.date ? (last.waist ?? '') : ''}"></div></div>
    <div class="row" style="margin-top:10px"><input id="wDate" type="date" value="${state.date}" style="flex:1"><button class="btn primary" data-act="saveWeight">保存</button></div>
  </div>
  <div class="card"><div class="row spread"><h2>体重趋势</h2><div class="seg" style="width:auto">${[30, 90, 365].map(n => `<button data-range="${n}" class="${state.range === n ? 'on' : ''}">${n}天</button>`).join('')}</div></div>
    ${lineChart([{ color: '#4ade80', points: recent.map(w => ({ x: w.date, y: w.kg })) }], { unit: '' })}
    ${delta != null ? `<div class="small muted" style="margin-top:6px">区间变化：<b class="${delta < 0 ? 'pill-ok' : delta > 0 ? 'pill-warn' : ''}">${delta > 0 ? '+' : ''}${delta} kg</b> (${first.date} → ${last.date})</div>` : ''}
  </div>
  ${ws.length ? `<div class="card"><h2>历史</h2><table class="tbl"><tr><th>日期</th><th>体重</th><th>体脂</th><th>腰围</th><th></th></tr>${[...ws].reverse().slice(0, 20).map(w => `<tr><td>${w.date}</td><td>${w.kg} kg</td><td>${w.bodyFat ?? '—'}</td><td>${w.waist ?? '—'}</td><td><button class="link" data-delw="${w.date}">删</button></td></tr>`).join('')}</table></div>` : ''}`;
}

function vWhoop() {
  const list = [...DB.whoop].sort((a, b) => a.date < b.date ? 1 : -1); const recent = [...list].reverse().slice(-state.range);
  return `
  <div class="card"><h2>导入 WHOOP 数据</h2>
    <div class="grid3"><button class="btn" data-act="whoopCsv">📄 CSV</button><button class="btn" data-act="whoopImg" ${AI.mode() === 'none' ? 'disabled' : ''}>📸 截图</button><button class="btn" data-act="whoopJson">{ } JSON</button></div>
    <details style="margin-top:10px"><summary>怎么拿到 WHOOP 数据？</summary><div class="small muted" style="margin-top:6px;line-height:1.6">
      <b>方法 1 · CSV (最完整)</b>：WHOOP app → More → App Settings → Data Export → 邮件会收到 zip，解压后选 <code>physiological_cycles.csv</code> (含 recovery + sleep) 或 <code>sleeps.csv</code>。<br>
      <b>方法 2 · 截图</b>：直接截 WHOOP 的 Recovery / Sleep / Overview 页面，AI 会读数字。<br>
      <b>方法 3 · JSON</b>：WHOOP Developer API v2 (developer.whoop.com) 的 recovery / sleep records 原始 JSON，或本 app 导出的 JSON。<br>
      WHOOP 的数据以「早上醒来的那天」记录，之后在「洞察」里会跟「前一天的饮食」配对分析。</div></details>
  </div>
  ${recent.length ? `
  <div class="seg" style="margin-bottom:12px">${[7, 14, 30, 90].map(n => `<button data-range="${n}" class="${state.range === n ? 'on' : ''}">${n} 天</button>`).join('')}</div>
  <div class="card"><h2>Recovery % / Sleep performance %</h2>${lineChart([{ color: '#4ade80', points: recent.map(w => ({ x: w.date, y: w.recovery ?? null })) }, { color: '#a78bfa', points: recent.map(w => ({ x: w.date, y: w.sleepPerf ?? null })) }], { yMin: 0, yMax: 100 })}<div class="legend"><span><i style="background:#4ade80"></i>Recovery</span><span><i style="background:#a78bfa"></i>Sleep performance</span></div></div>
  <div class="card"><h2>睡眠时长 (h) · 深睡 · REM</h2>${lineChart([{ color: '#a78bfa', points: recent.map(w => ({ x: w.date, y: w.sleepHours ?? null })) }, { color: '#60a5fa', points: recent.map(w => ({ x: w.date, y: w.deep ?? null })) }, { color: '#f472b6', points: recent.map(w => ({ x: w.date, y: w.rem ?? null })) }], { yMin: 0 })}<div class="legend"><span><i style="background:#a78bfa"></i>总睡眠</span><span><i style="background:#60a5fa"></i>Deep (SWS)</span><span><i style="background:#f472b6"></i>REM</span></div></div>
  <div class="card"><h2>HRV (ms) / 静息心率 (bpm)</h2>${lineChart([{ color: '#4ade80', points: recent.map(w => ({ x: w.date, y: w.hrv != null ? r0(w.hrv) : null })) }, { color: '#f87171', points: recent.map(w => ({ x: w.date, y: w.rhr ?? null })) }])}<div class="legend"><span><i style="background:#4ade80"></i>HRV</span><span><i style="background:#f87171"></i>RHR</span></div></div>
  <div class="card"><h2>记录 (${list.length} 天)</h2><div style="overflow:auto"><table class="tbl"><tr><th>日期</th><th>Rec</th><th>HRV</th><th>RHR</th><th>睡眠</th><th>Perf</th><th>Strain</th><th></th></tr>${list.slice(0, 30).map(w => `<tr><td>${mdLabel(w.date)}</td><td class="${recColor(w.recovery)}">${w.recovery ?? '—'}</td><td>${w.hrv != null ? r0(w.hrv) : '—'}</td><td>${w.rhr ?? '—'}</td><td>${w.sleepHours ?? '—'}</td><td>${w.sleepPerf ?? '—'}</td><td>${w.strain != null ? r1(w.strain) : '—'}</td><td><button class="link" data-delwh="${w.date}">删</button></td></tr>`).join('')}</table></div></div>` : '<div class="empty">还没有 WHOOP 数据。导入后这里会显示 recovery、睡眠、HRV 趋势。</div>'}`;
}

function vInsight() {
  const his = [...DB.insights].sort((a, b) => b.id < a.id ? -1 : 1);
  const none = AI.mode() === 'none';
  return `
  <div class="card"><h2>AI 洞察 · 饮食 × 睡眠 × 身体</h2>
    <div class="small muted" style="margin-bottom:10px">AI 会把最近的饮食 (热量、macros、进食时间)、体重、与隔天的 WHOOP recovery / HRV / 睡眠放在一起分析，找出关联并给出接下来 7 天的行动建议。</div>
    <div class="seg" style="margin-bottom:10px">${[7, 14, 30].map(n => `<button data-irange="${n}" class="${state.insightRange === n ? 'on' : ''}">最近 ${n} 天</button>`).join('')}</div>
    <button class="btn primary block" data-act="insight" ${none ? 'disabled' : ''}>${none ? '请先在设置配置 AI' : '🧠 生成分析'}</button>
    <div id="insOut" class="md" style="margin-top:12px"></div>
  </div>
  ${his.map(h => `<div class="card"><div class="row spread"><h2>${h.date} · 最近 ${h.range} 天</h2><button class="link" data-delins="${h.id}">删除</button></div><div class="md">${md(h.text)}</div></div>`).join('')}`;
}

function vSettings() {
  const p = DB.profile, s = DB.settings, tg = targets(); const claude = AI.mode() === 'claude';
  return `
  <div class="card"><h2>个人资料 & 目标</h2>
    <div class="grid3"><div class="field"><label class="f">性别</label><select id="pSex"><option value="male" ${p.sex === 'male' ? 'selected' : ''}>男</option><option value="female" ${p.sex === 'female' ? 'selected' : ''}>女</option></select></div><div class="field"><label class="f">年龄</label><input id="pAge" type="number" inputmode="numeric" value="${p.age}"></div><div class="field"><label class="f">身高 cm</label><input id="pH" type="number" inputmode="decimal" value="${p.heightCm}"></div></div>
    <div class="grid2"><div class="field"><label class="f">起始体重 kg (之后以「身体」页记录为准)</label><input id="pW" type="number" step="0.1" inputmode="decimal" value="${p.weightKg}"></div><div class="field"><label class="f">蛋白质目标 g/kg</label><input id="pPro" type="number" step="0.1" inputmode="decimal" value="${p.proteinPerKg}"></div></div>
    <div class="field"><label class="f">活动量</label><select id="pAct">${[[1.2, '久坐 (几乎不运动)'], [1.375, '轻度 (每周 1–3 次)'], [1.55, '中度 (每周 3–5 次)'], [1.725, '高度 (每周 6–7 次)'], [1.9, '非常高 (体力工作 / 一天两练)']].map(([v, l]) => `<option value="${v}" ${+p.activity === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label class="f">目标</label><select id="pGoal">${Object.entries(GOAL).map(([k, v]) => `<option value="${k}" ${p.goal === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label class="f">手动指定每日 kcal (0 = 自动计算，目前自动 = ${r0(tg.kcal)})</label><input id="pKcal" type="number" inputmode="numeric" value="${p.manualKcal || 0}"></div>
    <button class="btn primary block" data-act="saveProfile">保存资料</button>
  </div>
  <div class="card"><h2>AI 设置</h2>
    ${claude ? `<div class="small" style="margin-bottom:10px"><span class="pill-ok">✓ 目前在 claude.ai 上运行，直接使用内置 Claude，不需要 API key。</span><br><span class="muted">下面的设置只在你把这个 app 部署到自己的网站 (例如 GitHub Pages) 时才会用到。</span></div>` : `<div class="small muted" style="margin-bottom:10px">填入你自己的 API key (BYOK)。Key 只存在这台设备的浏览器里，直接从浏览器呼叫 provider，不经过任何第三方 server。</div>`}
    <div class="field"><label class="f">Provider</label><select id="sProv">${[['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI (GPT)'], ['gemini', 'Google Gemini (有免费额度)'], ['custom', 'OpenAI-compatible (OpenRouter / Ollama / LM Studio)']].map(([v, l]) => `<option value="${v}" ${s.provider === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label class="f">API key</label><input id="sKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="sk-…"></div>
    <div class="field"><label class="f">模型 (留空用默认：${esc(AI.defaultModel(s.provider))})</label><input id="sModel" value="${esc(s.model)}" placeholder="${esc(AI.defaultModel(s.provider))}"></div>
    <div class="field ${s.provider === 'custom' ? '' : 'hidden'}" id="baseWrap"><label class="f">Base URL (OpenAI-compatible)</label><input id="sBase" value="${esc(s.baseUrl)}" placeholder="https://openrouter.ai/api/v1 或 http://localhost:11434/v1"></div>
    <div class="row"><button class="btn" data-act="testAI">测试连线</button><button class="btn primary" data-act="saveAI" style="flex:1">保存 AI 设置</button></div>
    <div id="aiTest" class="small muted" style="margin-top:8px"></div>
  </div>
  <div class="card"><h2>数据</h2>
    <div class="small muted" style="margin-bottom:10px">所有数据保存在这台设备的浏览器。换设备或清除浏览器数据前，请先导出备份。餐食 ${DB.meals.length} 笔 · 体重 ${DB.weights.length} 笔 · WHOOP ${DB.whoop.length} 天</div>
    <div class="grid2"><button class="btn" data-act="export">⬇️ 导出 JSON</button><button class="btn" data-act="import">⬆️ 导入 JSON</button></div>
    <button class="btn danger block" data-act="wipe" style="margin-top:10px">清除全部数据</button>
  </div>
  <div class="small muted" style="text-align:center;padding:10px">NutriSync · 估算仅供参考，不构成医疗建议</div>`;
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  const v = $('#view');
  v.onclick = async e => {
    const b = e.target.closest('[data-act],[data-range],[data-irange],[data-meal],[data-delw],[data-delwh],[data-delins]'); if (!b) return;
    if (b.dataset.range) { state.range = +b.dataset.range; return render(); }
    if (b.dataset.irange) { state.insightRange = +b.dataset.irange; return render(); }
    if (b.dataset.meal) { const m = DB.meals.find(x => x.id === b.dataset.meal); return mealEditor({ meal: structuredClone(m), image: null, analyzing: false }); }
    if (b.dataset.delw) { DB.weights = DB.weights.filter(w => w.date !== b.dataset.delw); save(); return render(); }
    if (b.dataset.delwh) { DB.whoop = DB.whoop.filter(w => w.date !== b.dataset.delwh); save(); return render(); }
    if (b.dataset.delins) { DB.insights = DB.insights.filter(x => x.id !== b.dataset.delins); save(); return render(); }
    const act = b.dataset.act;
    if (act === 'prevDay') { state.date = addDays(state.date, -1); render(); }
    else if (act === 'nextDay') { state.date = addDays(state.date, 1); render(); }
    else if (act === 'photo') $('#photoInput').click();
    else if (act === 'gallery') $('#galleryInput').click();
    else if (act === 'text') startTextMeal();
    else if (act === 'saveWeight') {
      const kg = +$('#wKg').value; if (!kg) return toast('请输入体重'); const date = $('#wDate').value || state.date;
      const rec = { date, kg: r1(kg), bodyFat: +$('#wBf').value || null, waist: +$('#wWa').value || null };
      const i = DB.weights.findIndex(w => w.date === date); if (i >= 0) DB.weights[i] = rec; else DB.weights.push(rec); save(); render(); toast('已保存 ✓');
    }
    else if (act === 'whoopCsv') $('#whoopCsvInput').click();
    else if (act === 'whoopImg') $('#whoopImgInput').click();
    else if (act === 'whoopJson') {
      openModal(`<h3>导入 JSON</h3><div class="small muted" style="margin-bottom:8px">贴上 WHOOP API 回传的 JSON，或选择文件。</div><textarea id="wj" placeholder='{"records":[...]}'></textarea><div class="row" style="margin-top:10px"><button class="btn" id="wjFile">选文件</button><button class="btn" id="wjC">取消</button><button class="btn primary" id="wjGo" style="flex:1">导入</button></div>`);
      $('#wjC').onclick = closeModal; $('#wjFile').onclick = () => $('#whoopJsonInput').click();
      $('#wjGo').onclick = () => { try { const n = mergeWhoop(whoopFromJSON(JSON.parse($('#wj').value))); closeModal(); toast(`已导入 ${n} 天 ✓`); render(); } catch (err) { toast('JSON 解析失败：' + err.message, 4000); } };
    }
    else if (act === 'insight') {
      b.disabled = true; const out = $('#insOut'); out.innerHTML = '<span class="spinner"></span> 分析中，约需 20–40 秒…';
      try { const text = await runInsight(state.insightRange); DB.insights.unshift({ id: uid(), date: todayStr(), range: state.insightRange, text }); DB.insights = DB.insights.slice(0, 12); save(); render(); window.scrollTo(0, 0); toast('分析完成 ✓'); }
      catch (err) { out.innerHTML = `<span class="pill-bad">${esc(err.message)}</span>`; b.disabled = false; }
    }
    else if (act === 'saveProfile') {
      Object.assign(DB.profile, { sex: $('#pSex').value, age: +$('#pAge').value || 30, heightCm: +$('#pH').value || 170, weightKg: +$('#pW').value || 70, proteinPerKg: +$('#pPro').value || 1.8, activity: +$('#pAct').value, goal: $('#pGoal').value, manualKcal: +$('#pKcal').value || 0 });
      save(); render(); toast('资料已保存，目标已重新计算 ✓');
    }
    else if (act === 'saveAI') { Object.assign(DB.settings, { provider: $('#sProv').value, apiKey: $('#sKey').value.trim(), model: $('#sModel').value.trim(), baseUrl: ($('#sBase')?.value || '').trim() }); save(); renderBadge(); render(); toast('AI 设置已保存 ✓'); }
    else if (act === 'testAI') {
      Object.assign(DB.settings, { provider: $('#sProv').value, apiKey: $('#sKey').value.trim(), model: $('#sModel').value.trim(), baseUrl: ($('#sBase')?.value || '').trim() }); save(); renderBadge();
      const o = $('#aiTest'); o.innerHTML = '<span class="spinner"></span> 测试中…';
      try { const t = await AI.ask({ system: '你是测试助手。', user: '请只回答两个字：成功', maxTokens: 20 }); o.innerHTML = `<span class="pill-ok">✓ 连线成功 (${AI.label()})：${esc(t.slice(0, 40))}</span>`; }
      catch (err) { o.innerHTML = `<span class="pill-bad">✗ ${esc(err.message)}</span>`; }
    }
    else if (act === 'export') exportJSON();
    else if (act === 'import') $('#importInput').click();
    else if (act === 'wipe') { if (await confirmBox('确定清除全部数据？此操作无法复原。建议先导出备份。', '清除')) { DB = structuredClone(DEFAULT); save(); render(); toast('已清除'); } }
  };
  v.onchange = e => { if (e.target.id === 'sProv') { $('#baseWrap').classList.toggle('hidden', e.target.value !== 'custom'); $('#sModel').placeholder = AI.defaultModel(e.target.value); } };
}
async function exportJSON() {
  const data = JSON.stringify({ app: 'NutriSync', exportedAt: new Date().toISOString(), ...DB, settings: { ...DB.settings, apiKey: '' } }, null, 1);
  const filename = `nutrisync-backup-${todayStr()}.json`;
  try { if (window.claude?.use) { const dl = await window.claude.use('downloads'); if (dl) { await dl.save({ filename, data }); return toast('已导出 ✓'); } } } catch (e) { if (e && e.code && e.code !== 'not_granted') console.warn(e); }
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); toast('已导出 ✓'); }
  catch { openModal(`<h3>导出</h3><div class="small muted">此环境不允许下载，请复制下面内容保存：</div><textarea style="min-height:200px;margin-top:8px">${esc(data)}</textarea><button class="btn primary block" id="cp" style="margin-top:10px">复制</button>`); $('#cp').onclick = async () => { try { await navigator.clipboard.writeText(data); toast('已复制 ✓'); } catch { toast('请手动长按选择复制'); } }; }
}

$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.tab = b.dataset.tab; if (state.tab === 'body') state.range = Math.max(state.range, 30); if (['trends', 'whoop'].includes(state.tab) && state.range > 90) state.range = 30; render(); window.scrollTo(0, 0); });
$('#photoInput').addEventListener('change', e => { startPhotoMeal(e.target.files[0]); e.target.value = ''; });
$('#galleryInput').addEventListener('change', e => { startPhotoMeal(e.target.files[0]); e.target.value = ''; });
$('#whoopCsvInput').addEventListener('change', e => { importWhoopFiles([...e.target.files]); e.target.value = ''; });
$('#whoopImgInput').addEventListener('change', e => { importWhoopScreenshot(e.target.files[0]); e.target.value = ''; });
$('#whoopJsonInput').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const n = mergeWhoop(whoopFromJSON(JSON.parse(await f.text()))); closeModal(); toast(`已导入 ${n} 天 ✓`); render(); } catch (err) { toast('JSON 解析失败：' + err.message, 4000); } });
$('#importInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const j = JSON.parse(await f.text()); if (!j.meals && !j.weights && !j.whoop) throw new Error('不是 NutriSync 备份文件');
    if (await confirmBox(`导入将合并 ${j.meals?.length || 0} 餐、${j.weights?.length || 0} 笔体重、${j.whoop?.length || 0} 天 WHOOP。继续？`, '导入')) {
      for (const m of j.meals || []) if (!DB.meals.find(x => x.id === m.id)) DB.meals.push(m);
      for (const w of j.weights || []) if (!DB.weights.find(x => x.date === w.date)) DB.weights.push(w);
      mergeWhoop(j.whoop || []); for (const i of j.insights || []) if (!DB.insights.find(x => x.id === i.id)) DB.insights.push(i);
      if (j.profile) DB.profile = { ...DB.profile, ...j.profile }; save(); render(); toast('导入完成 ✓'); } }
  catch (err) { toast('导入失败：' + err.message, 4000); }
});

/* PWA service worker（在 claude.ai 沙箱里会被拒绝，忽略即可） */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) { window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); }); }

render(); renderBadge(); AI.init();
})();
