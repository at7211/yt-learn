/* 純函式。globalThis.ytLearnParseVtt(text) -> {events, dropped}；t/d 為整數毫秒，每個 cue 一個 seg [[null, text]]。
   略過 BOM、WEBVTT 標頭區、NOTE/STYLE/REGION 區塊、cue 識別行與時間後的 settings。
   空文字、end<=start、起點早於前一個「保留的」cue 的 cue 丟掉並計入 dropped；d 以下一個保留 cue 的 t 截短。 */
globalThis.ytLearnParseVtt = function (text) {
  const TS = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/;
  const toMs = (s) => {
    const m = TS.exec(s);
    if (!m) return NaN;
    return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  };
  const ENT = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '', quot: '"' };
  const decode = (s) => s.replace(/&(#39|amp|lt|gt|nbsp|lrm|rlm|quot);/g, (_, k) => (k === '#39' ? "'" : ENT[k]));
  const clean = (lines) => decode(
    lines.join(' ').replace(/<\/?[^>]*>/g, ''),
  ).replace(/\s+/g, ' ').trim();

  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n{2,}|\n[ \t]*\n/);
  const kept = [];
  let dropped = 0;
  blocks.forEach((block, bi) => {
    const lines = block.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) return;
    if (bi === 0 && /^WEBVTT/.test(lines[0])) return;
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) return;
    let i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0 || i > 1) return;
    const m = /^\s*(\S+)\s+-->\s+(\S+)/.exec(lines[i]);
    if (!m) return;
    const start = toMs(m[1]);
    const end = toMs(m[2]);
    const body = clean(lines.slice(i + 1));
    const prev = kept[kept.length - 1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !body || end <= start || (prev && start < prev.t)) {
      dropped++;
      return;
    }
    kept.push({ t: start, d: end - start, segs: [[null, body]] });
  });
  for (let k = 0; k + 1 < kept.length; k++) kept[k].d = Math.min(kept[k].d, kept[k + 1].t - kept[k].t);
  return { events: kept, dropped };
};
