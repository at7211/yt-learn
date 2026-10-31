/* 純函式，無 DOM。globalThis.ytLearnParseTtml(text) -> {events:[{t, d, text}], dropped}；t/d 為整數毫秒。
   Netflix 的 TTML（imsc1.1 / dfxp-ls-sdh）的封閉子集：自寫 tokenizer，只認下面這些結構，其它一律
   throw new Error('不支援的字幕檔結構：<原因>')，不猜。
   - 輸入：建樹前整份掃一次——UTF-8 大小 ≤ 2 MB（超過即停）、只允許合法的 Unicode scalar 且是 XML 字元
     （不成對的 surrogate、tab/LF/CR 以外的 C0 控制字元、U+FFFE/U+FFFF → 拒絕）。
   - 文件：可選 BOM、可選 <?xml version encoding="utf-8"?>（只在檔頭）、註解 <!-- --> 可出現在任何地方並略過
     （內容不能有 --、不能以 - 結尾）；
     DOCTYPE／實體宣告、CDATA、其它處理指令 → 拒絕。單一根元素，本地名 tt，namespace 為 TTML（新或舊 URI）。
     標籤成對（可自閉合）、屬性值加引號、屬性之間有空白、不重複；實體只有 &amp; &lt; &gt; &quot; &apos; &#N; &#xN;。
     上限：節點 50,000、深度 16、p 10,000（三者都在 tokenizer 讀屬性之前就檢查）。屬性重複用 Set 檢查；namespace
     每個元素只存自己的宣告，前綴往上找（深度 ≤ 16）。
   - 元素：tt > head?（整個略過，只要求格式正確）, body? > div* > p*；p 內只有文字、span（可巢狀）、br（空元素）。
     body/div/span/br（與 tt）上的 begin/end/dur/timeContainer → 拒絕；p 必須有 begin 與 end 或 dur，
     兩者都有時 end 優先、dur 必須一致（±1 ms）；p 上 timeContainer → 拒絕。
   - 時間參數（tt 上、以 namespace URI 認 #parameter）：timeBase 只接受 media；frameRate（30）、subFrameRate（1）、
     frameRateMultiplier（"1 1"）、tickRate（有 frameRate 時 = 有效 frameRate × subFrameRate，否則 1）先驗證為正整數再換算。
     時間：hh:mm:ss(.fff)、hh:mm:ss:ff(.sub)、N(.N)?(h|m|s|ms|f|t)。
   - 內文：br → 換行、span 剝掉、實體解開、空白合併；刪 [..]（單次掃描，巢狀一起刪；多出的 ] 保留為文字，沒關上的 [
     刪到句尾）、刪 ♪、刪行首 -；只剩 (..) 的整句丟掉；空的丟掉（計入 dropped）。
   - 時間正規化：同 begin 合併（文件順序、end 取大）→ 穩定排序 → end<=begin 丟（計入 dropped）→ d 截到下一句 begin
     → d < token 數 × 2 ms 的句子併入下一句（可連鎖；最後一句併入前一句）→ t 嚴格遞增。合併後整組丟掉時，dropped 加上
     組內的來源 cue 數。全部是線性時間：token 數每句只算一次，文字最後才串接。 */
(function (g) {
  const PREFIX = '不支援的字幕檔結構：';
  const TT_NS = ['http://www.w3.org/ns/ttml', 'http://www.w3.org/2006/10/ttaf1'];
  const PARAM_NS = TT_NS.map((u) => u + '#parameter');
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const MAX_BYTES = 2 * 1024 * 1024; // UTF-8 bytes
  const MAX_NODES = 50000;
  const MAX_DEPTH = 16;
  const MAX_CUES = 10000;
  const TIMING = ['begin', 'end', 'dur', 'timeContainer'];
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const NAME = /[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?/y;
  const WS = /[ \t\r\n]*/y;
  const ENTITY = /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,15});/y;
  const XML_DECL = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.[0-9]+\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(?:yes|no)\4)?[ \t\r\n]*\?>/;

  function fail(why) { throw new Error(PREFIX + why); }

  const xmlChar = (cp) => cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF)
    || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);

  // Raw character data (text or attribute value) -> decoded string; only the five XML entities and char refs.
  function decode(s) {
    let out = '';
    let at = 0;
    for (;;) {
      const amp = s.indexOf('&', at);
      if (amp < 0) return out + s.slice(at);
      out += s.slice(at, amp);
      ENTITY.lastIndex = amp;
      const m = ENTITY.exec(s);
      if (!m) fail('& 後面不是合法的實體（' + s.slice(amp, amp + 12) + '）');
      const k = m[1];
      if (k[0] === '#') {
        const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        if (!xmlChar(cp)) fail('不允許的字元參照 &' + k + ';');
        out += String.fromCodePoint(cp);
      } else {
        if (!Object.prototype.hasOwnProperty.call(ENT, k)) fail('不認得的實體 &' + k + ';');
        out += ENT[k];
      }
      at = ENTITY.lastIndex;
    }
  }

  /* ---------- tokenizer + tree ---------- */

  const splitQName = (qn) => { const c = qn.indexOf(':'); return c < 0 ? ['', qn] : [qn.slice(0, c), qn.slice(c + 1)]; };
  function resolve(el, prefix) {
    for (let e = el; e; e = e.up) if (e.decl && prefix in e.decl) return e.decl[prefix];
    return undefined;
  }

  // Whole input, before any tree is built: UTF-8 size <= 2 MB (early exit), only Unicode scalar values that are
  // XML characters (no lone surrogates, no C0 controls other than tab/LF/CR, no U+FFFE/U+FFFF).
  function checkInput(text) {
    if (text.length > MAX_BYTES) fail('字幕檔超過 2 MB'); // every UTF-16 unit is at least one UTF-8 byte
    let bytes = 0;
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (c < 0x80) {
        if (c < 0x20 && c !== 0x9 && c !== 0xA && c !== 0xD) fail('含有不允許的控制字元');
        bytes += 1;
      } else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) {
        const d = k + 1 < text.length ? text.charCodeAt(k + 1) : 0;
        if (!(d >= 0xDC00 && d <= 0xDFFF)) fail('含有不成對的 surrogate（不是合法的 Unicode 字元）');
        bytes += 4;
        k++;
      } else if (c >= 0xDC00 && c <= 0xDFFF) fail('含有不成對的 surrogate（不是合法的 Unicode 字元）');
      else if (c === 0xFFFE || c === 0xFFFF) fail('含有不允許的控制字元');
      else bytes += 3;
      if (bytes > MAX_BYTES) fail('字幕檔超過 2 MB');
    }
  }

  // -> root element {name, prefix, local, ns, attrs:[{name, local, ns, value}], kids:[element | {text}]}
  function parseXml(src) {
    let i = 0;
    const n = src.length;
    let nodes = 0;
    const count = () => { if (++nodes > MAX_NODES) fail('節點超過 ' + MAX_NODES + ' 個'); };
    const skipWs = () => { WS.lastIndex = i; WS.exec(src); const moved = WS.lastIndex > i; i = WS.lastIndex; return moved; };
    const readName = () => {
      NAME.lastIndex = i;
      const m = NAME.exec(src);
      if (!m) return null;
      i = NAME.lastIndex;
      return m[0];
    };
    const comment = () => {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) fail('註解沒有結束');
      const body = src.slice(i + 4, end);
      if (body.includes('--') || body.endsWith('-')) fail('註解裡不能有 --（也不能以 - 結尾）');
      i = end + 3;
      count();
    };
    // Markup that is never allowed: say which.
    const forbidden = () => {
      if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!ENTITY', i)) fail('不接受 DOCTYPE／實體宣告');
      if (src.startsWith('<![CDATA[', i)) fail('不接受 CDATA 區段');
      if (src.startsWith('<?xml', i)) fail('XML 宣告必須在檔案開頭');
      if (src.startsWith('<?', i)) fail('不接受處理指令 <?…?>');
      if (src.startsWith('<!', i)) fail('不接受 <! 宣告');
    };
    // Outside the root: whitespace and comments only.
    const misc = (where) => {
      for (;;) {
        skipWs();
        if (i >= n) return;
        if (src.startsWith('<!--', i)) { comment(); continue; }
        forbidden();
        if (src[i] === '<') return;
        fail(where === 'after' ? '根元素之後還有內容' : '根元素之前有文字');
      }
    };

    if (src.startsWith('<?xml', 0)) {
      const m = XML_DECL.exec(src);
      if (!m) fail('XML 宣告格式不對');
      if (m[3] && !/^utf-?8$/i.test(m[3])) fail('XML 宣告的編碼不是 UTF-8（' + m[3] + '）');
      i = m[0].length;
    }
    misc('before');
    if (i >= n) fail('沒有根元素');

    const stack = []; // open elements
    let root = null;
    let cueCount = 0;
    // Start tag at src[i] === '<'. Budgets (depth, nodes, cues) are checked before the attributes are read.
    const startTag = () => {
      i++;
      const name = readName();
      if (!name) fail('標籤名稱不合法（' + src.slice(i - 1, i + 15) + '）');
      if (stack.length + 1 > MAX_DEPTH) fail('巢狀深度超過 ' + MAX_DEPTH);
      count();
      const attrs = [];
      const names = new Set();
      let selfClose = false;
      for (;;) {
        const ws = skipWs();
        if (i >= n) fail('標籤 <' + name + '> 沒有結束');
        if (src[i] === '>') { i++; break; }
        if (src.startsWith('/>', i)) { i += 2; selfClose = true; break; }
        if (!ws) fail('<' + name + '> 的屬性之間要有空白');
        const an = readName();
        if (!an) fail('<' + name + '> 的屬性名稱不合法');
        skipWs();
        if (src[i] !== '=') fail('<' + name + '> 的屬性 ' + an + ' 沒有值');
        i++;
        skipWs();
        const q = src[i];
        if (q !== '"' && q !== "'") fail('<' + name + '> 的屬性 ' + an + ' 沒有加引號');
        const end = src.indexOf(q, i + 1);
        if (end < 0) fail('<' + name + '> 的屬性 ' + an + ' 的值沒有結束');
        const rawVal = src.slice(i + 1, end);
        if (rawVal.includes('<')) fail('<' + name + '> 的屬性 ' + an + ' 的值裡有 <');
        if (names.has(an)) fail('<' + name + '> 的屬性 ' + an + ' 重複');
        names.add(an);
        attrs.push({ name: an, value: decode(rawVal).replace(/[\t\r\n]/g, ' ') });
        i = end + 1;
      }

      // Namespaces: only this element's own declarations; prefixes resolve by walking up (depth <= 16).
      const parent = stack[stack.length - 1] || null;
      let decl = null;
      for (const a of attrs) {
        if (a.name === 'xmlns') (decl || (decl = Object.create(null)))[''] = a.value;
        else if (a.name.startsWith('xmlns:')) {
          const p = a.name.slice(6);
          if (p === 'xmlns' || (p === 'xml' && a.value !== XML_NS)) fail('不能重新宣告前綴 ' + p);
          if (a.value === '') fail('前綴 ' + p + ' 的 namespace 是空的');
          (decl || (decl = Object.create(null)))[p] = a.value;
        }
      }
      const el = { name, prefix: '', local: '', ns: null, attrs: [], kids: [], decl, up: parent };
      const [prefix, local] = splitQName(name);
      if (prefix === 'xmlns') fail('元素不能用 xmlns 前綴');
      const ns = prefix === 'xml' ? XML_NS : resolve(el, prefix);
      if (prefix && ns === undefined) fail('未宣告的前綴 ' + prefix + '（<' + name + '>）');
      el.prefix = prefix;
      el.local = local;
      el.ns = ns === undefined ? null : ns;
      if (local === 'p' && TT_NS.includes(el.ns) && ++cueCount > MAX_CUES) fail('cue（p）超過 ' + MAX_CUES + ' 個');
      const seen = new Set();
      for (const a of attrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const [ap, al] = splitQName(a.name);
        const ans = ap === '' ? null : (ap === 'xml' ? XML_NS : resolve(el, ap));
        if (ans === undefined) fail('未宣告的前綴 ' + ap + '（屬性 ' + a.name + '）');
        const key = (ans || '') + ' ' + al;
        if (seen.has(key)) fail('<' + name + '> 的屬性 ' + a.name + ' 重複');
        seen.add(key);
        el.attrs.push({ name: a.name, local: al, ns: ans, value: a.value });
      }
      if (parent) parent.kids.push(el);
      else root = el;
      if (!selfClose) stack.push(el);
    };

    startTag();
    while (stack.length) {
      if (i >= n) fail('標籤沒有結束（<' + stack[stack.length - 1].name + '>）');
      if (src[i] === '<') {
        if (src.startsWith('<!--', i)) { comment(); continue; }
        forbidden();
        if (src.startsWith('</', i)) {
          i += 2;
          const name = readName();
          skipWs();
          if (!name || src[i] !== '>') fail('結束標籤格式不對');
          i++;
          const top = stack.pop();
          if (top.name !== name) fail('標籤沒有配對（<' + top.name + '> 遇到 </' + name + '>）');
          continue;
        }
        startTag();
        continue;
      }
      let end = src.indexOf('<', i);
      if (end < 0) end = n;
      const raw = src.slice(i, end);
      if (raw.includes(']]>')) fail('文字裡不能有 ]]>');
      stack[stack.length - 1].kids.push({ text: decode(raw) });
      count();
      i = end;
    }
    misc('after');
    if (i < n) fail('根元素之後還有內容');
    return root;
  }

  /* ---------- time ---------- */

  const POS_INT = /^[0-9]+$/;
  function posInt(v, what) {
    const s = String(v).trim();
    const x = POS_INT.test(s) ? Number(s) : NaN;
    if (!(Number.isSafeInteger(x) && x > 0)) fail(what + ' 必須是正整數（' + v + '）');
    return x;
  }

  function timeParams(tt) {
    const p = {};
    for (const a of tt.attrs) if (PARAM_NS.includes(a.ns)) p[a.local] = a.value;
    if (p.timeBase !== undefined && p.timeBase.trim() !== 'media') fail('timeBase 只接受 media（' + p.timeBase + '）');
    const frameRate = p.frameRate !== undefined ? posInt(p.frameRate, 'frameRate') : 30;
    const subFrameRate = p.subFrameRate !== undefined ? posInt(p.subFrameRate, 'subFrameRate') : 1;
    let num = 1;
    let den = 1;
    if (p.frameRateMultiplier !== undefined) {
      const parts = p.frameRateMultiplier.trim().split(/[ \t\r\n]+/);
      if (parts.length !== 2) fail('frameRateMultiplier 必須是兩個正整數（' + p.frameRateMultiplier + '）');
      num = posInt(parts[0], 'frameRateMultiplier');
      den = posInt(parts[1], 'frameRateMultiplier');
    }
    const fps = frameRate * num / den; // effective frame rate
    let tickRate;
    if (p.tickRate !== undefined) tickRate = posInt(p.tickRate, 'tickRate');
    else tickRate = p.frameRate !== undefined ? fps * subFrameRate : 1;
    return { fps, subFrameRate, tickRate };
  }

  const CLOCK = /^([0-9]{2,}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?$/;
  const FRAMES = /^([0-9]{2,}):([0-9]{2}):([0-9]{2}):([0-9]{2,})(?:\.([0-9]+))?$/;
  const OFFSET = /^([0-9]+(?:\.[0-9]+)?)(h|ms|m|s|f|t)$/;
  // Time expression -> integer ms.
  function toMs(expr, tp, what) {
    const bad = () => fail(what + ' 的時間格式不對（' + expr + '）');
    let ms;
    let m;
    if ((m = CLOCK.exec(expr))) {
      const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mi >= 60 || s >= 60) bad();
      ms = ((h * 60 + mi) * 60 + s) * 1000 + (m[4] ? Number('0' + m[4]) * 1000 : 0);
    } else if ((m = FRAMES.exec(expr))) {
      const [h, mi, s, f] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      const sub = m[5] === undefined ? 0 : Number(m[5]);
      if (mi >= 60 || s >= 60 || f >= Math.ceil(tp.fps) || sub >= tp.subFrameRate) bad();
      ms = ((h * 60 + mi) * 60 + s) * 1000 + (f + sub / tp.subFrameRate) * 1000 / tp.fps;
    } else if ((m = OFFSET.exec(expr))) {
      const v = Number(m[1]);
      const unit = m[2];
      if (unit === 'h') ms = v * 3600000;
      else if (unit === 'm') ms = v * 60000;
      else if (unit === 's') ms = v * 1000;
      else if (unit === 'ms') ms = v;
      else if (unit === 'f') ms = v * 1000 / tp.fps;
      else ms = v * 1000 / tp.tickRate;
    } else bad();
    ms = Math.round(ms);
    if (!Number.isSafeInteger(ms) || ms < 0) bad();
    return ms;
  }

  /* ---------- structure + text ---------- */

  const attr = (el, local) => {
    const a = el.attrs.find((x) => x.ns === null && x.local === local);
    return a ? a.value.trim() : undefined;
  };
  const isWs = (k) => k.text !== undefined && /^[ \t\r\n]*$/.test(k.text);
  function noTiming(el) {
    for (const a of el.attrs) if (a.ns === null && TIMING.includes(a.local)) fail('<' + el.name + '> 上不允許時間屬性 ' + a.local);
  }

  // p content -> raw text with '\n' at each br.
  function pText(el, ttNs, out) {
    for (const k of el.kids) {
      if (k.text !== undefined) { out.push(k.text.replace(/\s+/g, ' ')); continue; }
      if (k.ns !== ttNs || (k.local !== 'span' && k.local !== 'br')) fail('p 裡不允許 <' + k.name + '>');
      noTiming(k);
      if (k.local === 'br') {
        if (k.kids.length) fail('br 不能有內容');
        out.push('\n');
      } else pText(k, ttNs, out);
    }
    return out;
  }

  // One left-to-right pass over the whole cue (SDH tags do wrap across br lines): everything inside [...] goes,
  // nested brackets included. An unmatched ']' is kept as text; an unmatched '[' drops the rest of the cue.
  function stripBrackets(s) {
    let out = '';
    let depth = 0;
    let from = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c === 0x5B) {
        if (depth === 0) out += s.slice(from, k);
        depth++;
      } else if (c === 0x5D && depth > 0) {
        depth--;
        if (depth === 0) from = k + 1;
      }
    }
    return depth === 0 ? out + s.slice(from) : out;
  }

  // SDH cleanup -> the sentence, or '' to drop it.
  function clean(raw) {
    // brackets over the whole cue, then ♪, then per line every run of leading dashes ("-[tag] -[tag]" ends empty)
    const lines = stripBrackets(raw).replace(/♪/g, '').split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim().replace(/^(?:-+\s*)+/, '').trim())
      .filter(Boolean);
    let s = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (/^(?:\([^()]*\)\s*)+$/.test(s)) return '';
    return s;
  }

  function cues(root) {
    if (root.local !== 'tt') fail('根元素不是 tt（是 <' + root.name + '>）');
    if (!TT_NS.includes(root.ns)) fail('tt 的 namespace 不是 TTML（' + (root.ns || '沒有 namespace') + '）');
    const ttNs = root.ns;
    noTiming(root);
    const tp = timeParams(root);
    const out = [];
    let head = false;
    let body = null;
    for (const k of root.kids) {
      if (k.text !== undefined) { if (!isWs(k)) fail('tt 底下不允許文字'); continue; }
      if (k.ns === ttNs && k.local === 'head' && !head && !body) { head = true; continue; }
      if (k.ns === ttNs && k.local === 'body' && !body) { body = k; continue; }
      fail('tt 底下不允許 <' + k.name + '>（只接受一個 head 與其後一個 body）');
    }
    if (!body) return { out, tp };
    noTiming(body);
    for (const div of body.kids) {
      if (div.text !== undefined) { if (!isWs(div)) fail('body 底下不允許文字'); continue; }
      if (div.ns === ttNs && div.local === 'p') fail('body 底下直接放 p（沒有 div）');
      if (div.ns !== ttNs || div.local !== 'div') fail('body 底下不允許 <' + div.name + '>');
      noTiming(div);
      for (const p of div.kids) {
        if (p.text !== undefined) { if (!isWs(p)) fail('div 底下不允許文字'); continue; }
        if (p.ns !== ttNs || p.local !== 'p') fail('div 底下不允許 <' + p.name + '>');
        if (out.length >= MAX_CUES) fail('cue（p）超過 ' + MAX_CUES + ' 個');
        if (attr(p, 'timeContainer') !== undefined) fail('p 上不允許 timeContainer');
        const b = attr(p, 'begin');
        const e = attr(p, 'end');
        const d = attr(p, 'dur');
        if (b === undefined) fail('p 缺少 begin');
        if (e === undefined && d === undefined) fail('p 缺少 end 或 dur');
        const begin = toMs(b, tp, 'begin');
        let end;
        if (e !== undefined) {
          end = toMs(e, tp, 'end');
          if (d !== undefined && Math.abs(begin + toMs(d, tp, 'dur') - end) > 1) fail('p 的 end 與 dur 不一致（' + e + '、' + d + '）');
        } else end = begin + toMs(d, tp, 'dur');
        out.push({ t: begin, e: end, text: clean(pText(p, ttNs, []).join('')) });
      }
    }
    return { out, tp };
  }

  // Cleaned text is single-spaced and trimmed: tokens = spaces + 1. Counted once per source cue.
  function tokens(s) {
    let n = 1;
    for (let k = s.indexOf(' '); k >= 0; k = s.indexOf(' ', k + 1)) n++;
    return n;
  }
  // A group {t, e, tokens, parts, n}: parts are joined once at the end (no repeated split/splice/concat).
  const short = (g) => g.e - g.t < g.tokens * 2;
  const absorb = (into, g) => {
    for (const x of g.parts) into.parts.push(x);
    into.tokens += g.tokens;
    into.n += g.n;
  };

  function normalize(list) {
    let dropped = 0;
    const cs = [];
    list.forEach((c, i) => {
      if (c.text) cs.push({ t: c.t, e: c.e, tokens: tokens(c.text), parts: [c.text], n: 1, i });
      else dropped++;
    });
    // same begin -> one sentence (document order; stable sort keeps it), end = max; n = source cues in it
    cs.sort((a, b) => a.t - b.t || a.i - b.i);
    const merged = [];
    for (const c of cs) {
      const last = merged[merged.length - 1];
      if (last && last.t === c.t) { absorb(last, c); last.e = Math.max(last.e, c.e); } else merged.push(c);
    }
    const gs = merged.filter((g) => (g.e > g.t ? true : (dropped += g.n, false)));
    for (let k = 0; k + 1 < gs.length; k++) gs[k].e = Math.min(gs[k].e, gs[k + 1].t);
    // too short for its words -> into the next (chains); one linear pass with an accumulator
    const out = [];
    let acc = null;
    gs.forEach((g, k) => {
      if (acc) { absorb(acc, g); acc.e = g.e; } else acc = { t: g.t, e: g.e, tokens: g.tokens, parts: g.parts.slice(), n: g.n };
      if (k + 1 < gs.length && short(acc)) return;
      out.push(acc);
      acc = null;
    });
    // the last one still too short -> into the previous (end = max), repeatedly
    const tail = [];
    while (out.length > 1 && short(out[out.length - 1])) {
      const last = out.pop();
      const prev = out[out.length - 1];
      prev.e = Math.max(prev.e, last.e);
      prev.tokens += last.tokens;
      tail.push(last);
    }
    for (let k = tail.length - 1; k >= 0; k--) for (const x of tail[k].parts) out[out.length - 1].parts.push(x);
    // t strictly increasing (holds by construction; merge if it ever does not)
    const events = [];
    let lastG = null;
    for (const g of out) {
      if (lastG && g.t <= lastG.t) { for (const x of g.parts) lastG.parts.push(x); lastG.e = Math.max(lastG.e, g.e); continue; }
      lastG = g;
      events.push(g);
    }
    return { events: events.map((g) => ({ t: g.t, d: g.e - g.t, text: g.parts.join(' ') })), dropped };
  }

  g.ytLearnParseTtml = function (text) {
    if (typeof text !== 'string') fail('不是文字');
    checkInput(text);
    const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const root = parseXml(src);
    return normalize(cues(root).out);
  };
})(globalThis);
