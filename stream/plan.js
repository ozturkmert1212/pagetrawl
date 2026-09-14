/* Pure manifest planning; no network, Chrome APIs or code from media pages. */
(function (root) {
  'use strict';
  const MAX_SEGMENTS = 10000;
  function fail(code) { throw new Error(code); }
  function url(value, base) {
    const u = new URL(value, base);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('unsupported');
    return u.href;
  }
  function attrs(value) {
    const result = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    for (const m of value.matchAll(re)) result[m[1]] = m[2].replace(/^"|"$/g, '');
    return result;
  }
  function select(items, mode) {
    if (!items.length) fail('unsupported');
    const cap = mode === '720' ? 720 : mode === '1080' ? 1080 : Infinity;
    const sorted = [...items].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    return sorted.find(i => (i.height || 0) <= cap) || sorted[sorted.length - 1];
  }
  function range(value, previous, target) {
    const m = /^(\d+)(?:@(\d+))?$/.exec(value);
    if (!m) fail('unsupported');
    const length = Number(m[1]);
    const start = m[2] === undefined ? (previous?.url === target ? previous.end + 1 : NaN) : Number(m[2]);
    const end = start + length - 1;
    if (!Number.isSafeInteger(end) || !Number.isSafeInteger(start) || length <= 0 || start < 0) fail('unsupported');
    return { start, end };
  }
  function hls(text, base, mode) {
    const lines = text.trim().split(/\r?\n/).map(s => s.trim());
    if (lines[0] !== '#EXTM3U') fail('unsupported');
    const variants = [], audios = [], segments = [];
    let pendingVariant, pendingRange, previous, init, encrypted = false;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) pendingVariant = attrs(line.slice(18));
      else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(line.slice(13));
        if (a.TYPE === 'AUDIO') audios.push(a);
      } else if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
        if (attrs(line.slice(line.indexOf(':') + 1)).METHOD !== 'NONE') encrypted = true;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = attrs(line.slice(11));
        if (!a.URI) fail('unsupported');
        const next = { url: url(a.URI, base) };
        if (a.BYTERANGE) next.range = range(a.BYTERANGE, null, next.url);
        if (!init && segments.length) fail('unsupported');
        if (init && JSON.stringify(init) !== JSON.stringify(next)) fail('unsupported');
        init = next;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(17);
      else if (/^#EXT-X-(DISCONTINUITY|GAP)(:|$)/.test(line)) fail('unsupported');
      else if (line && !line.startsWith('#')) {
        const target = url(line, base);
        if (pendingVariant) {
          variants.push({ url: target, height: Number(pendingVariant.RESOLUTION?.split('x')[1]) || 0,
            bandwidth: Number(pendingVariant.BANDWIDTH) || 0, audio: pendingVariant.AUDIO });
          pendingVariant = null;
        } else {
          const part = { url: target };
          if (pendingRange) part.range = range(pendingRange, previous, target);
          previous = part.range ? { url: target, ...part.range } : null;
          pendingRange = null;
          segments.push(part);
          if (segments.length > MAX_SEGMENTS) fail('limit');
        }
      }
    }
    if (encrypted) fail('encrypted');
    if (variants.length) {
      if (segments.length || pendingVariant) fail('unsupported');
      const video = select(variants, mode);
      const choices = audios.filter(a => a['GROUP-ID'] === video.audio);
      const audio = choices.find(a => a.DEFAULT === 'YES') || choices[0];
      return { type: 'master', video: video.url, audio: audio?.URI ? url(audio.URI, base) : null };
    }
    if (!lines.includes('#EXT-X-ENDLIST')) fail('live');
    if (!segments.length || pendingRange || pendingVariant) fail('unsupported');
    if (segments.length + (init ? 1 : 0) > MAX_SEGMENTS) fail('limit');
    return { type: 'media', segments: init ? [init, ...segments] : segments };
  }
  const children = (el, tag) => Array.from(el?.children || []).filter(e => e.localName === tag);
  const child = (el, tag) => children(el, tag)[0];
  function duration(value) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
    return m ? Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0) : NaN;
  }
  function dash(doc, manifestUrl, mode) {
    if (doc.querySelector('parsererror')) fail('unsupported');
    const mpd = doc.documentElement;
    if (mpd.localName !== 'MPD') fail('unsupported');
    if (mpd.getAttribute('type') === 'dynamic') fail('live');
    if (doc.getElementsByTagNameNS('*', 'ContentProtection').length) fail('encrypted');
    const periods = children(mpd, 'Period');
    if (periods.length !== 1) fail('unsupported');
    const period = periods[0];
    const seconds = duration(period.getAttribute('duration') || mpd.getAttribute('mediaPresentationDuration'));
    const reps = [];
    for (const adaptation of children(period, 'AdaptationSet')) {
      for (const rep of children(adaptation, 'Representation')) {
        const mime = rep.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || '';
        const kind = rep.getAttribute('contentType') || adaptation.getAttribute('contentType') || mime.split('/')[0];
        if (!['video', 'audio'].includes(kind)) continue;
        reps.push({ rep, adaptation, kind, height: Number(rep.getAttribute('height') || adaptation.getAttribute('height')),
          bandwidth: Number(rep.getAttribute('bandwidth')) });
      }
    }
    const video = reps.filter(r => r.kind === 'video'), audio = reps.filter(r => r.kind === 'audio');
    const chosen = mode === 'audio' && audio.length ? [select(audio, 'best')] :
      [...(video.length ? [select(video, mode)] : []), ...(audio.length ? [select(audio, 'best')] : [])];
    if (!chosen.length) fail('unsupported');
    return chosen.map(({ rep, adaptation, kind, bandwidth }) => {
      const levels = [mpd, period, adaptation, rep];
      let base = manifestUrl;
      for (const level of levels) {
        const b = child(level, 'BaseURL');
        if (b) base = url(b.textContent.trim(), base);
      }
      const lists = levels.map(l => child(l, 'SegmentList')).filter(Boolean);
      const templates = levels.map(l => child(l, 'SegmentTemplate')).filter(Boolean);
      const segments = [];
      const parseRange = s => {
        if (!/^\d+-\d+$/.test(s)) fail('unsupported');
        const [start, end] = s.split('-').map(Number);
        if (!Number.isSafeInteger(end) || end < start) fail('unsupported');
        return { start, end };
      };
      if (lists.length) {
        const list = lists[lists.length - 1];
        const init = [...lists].reverse().map(l => child(l, 'Initialization')).find(Boolean);
        if (init) segments.push({ url: url(init.getAttribute('sourceURL') || base, base),
          ...(init.hasAttribute('range') ? { range: parseRange(init.getAttribute('range')) } : {}) });
        for (const s of children(list, 'SegmentURL')) {
          segments.push({ url: url(s.getAttribute('media') || base, base),
            ...(s.hasAttribute('mediaRange') ? { range: parseRange(s.getAttribute('mediaRange')) } : {}) });
        }
      } else if (templates.length) {
        const a = Object.assign({}, ...templates.map(t => Object.fromEntries(Array.from(t.attributes).map(a => [a.name, a.value]))));
        const timescale = Number(a.timescale || 1), offset = Number(a.presentationTimeOffset || 0);
        const start = Number(a.startNumber || 1);
        if (!(timescale > 0) || !Number.isSafeInteger(start)) fail('unsupported');
        const expand = (pattern, number, time) => {
          if (!pattern) fail('unsupported');
          const result = pattern.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (m, key, width) => {
            if (m === '$$') return '\u0000';
            if (Number(width || 0) > 20) fail('unsupported');
            const value = { RepresentationID: rep.getAttribute('id'), Bandwidth: bandwidth, Number: number, Time: time }[key];
            if (value == null) fail('unsupported');
            return String(value).padStart(Number(width || 0), '0');
          });
          if (result.includes('$')) fail('unsupported');
          return url(result.replace(/\u0000/g, '$'), base);
        };
        if (a.initialization) segments.push({ url: expand(a.initialization, start, 0) });
        const timeline = [...templates].reverse().map(t => child(t, 'SegmentTimeline')).find(Boolean);
        if (timeline) {
          let time = 0, number = start;
          const entries = children(timeline, 'S');
          entries.forEach((s, i) => {
            if (s.hasAttribute('t')) time = Number(s.getAttribute('t'));
            const d = Number(s.getAttribute('d'));
            let repeats = Number(s.getAttribute('r') || 0);
            if (!Number.isSafeInteger(time) || !Number.isSafeInteger(d) || d <= 0 || !Number.isInteger(repeats) || repeats < -1) fail('unsupported');
            if (repeats === -1) {
              const next = entries[i + 1];
              const end = next?.hasAttribute('t') ? Number(next.getAttribute('t')) : seconds * timescale + offset;
              repeats = Math.ceil((end - time) / d) - 1;
            }
            if (!Number.isFinite(repeats) || repeats < 0 || segments.length + repeats + 1 > MAX_SEGMENTS) fail('limit');
            for (let r = 0; r <= repeats; r++) { segments.push({ url: expand(a.media, number++, time) }); time += d; }
          });
        } else {
          const d = Number(a.duration);
          const count = Math.ceil(seconds * timescale / d);
          if (!(count > 0) || !Number.isFinite(count) || count > MAX_SEGMENTS) fail('limit');
          for (let i = 0; i < count; i++) segments.push({ url: expand(a.media, start + i, i * d) });
        }
      } else {
        // SegmentBase: download the complete referenced file, including its init/index.
        if (base === manifestUrl || /\/$/.test(new URL(base).pathname)) fail('unsupported');
        segments.push({ url: base });
      }
      if (!segments.length || segments.length > MAX_SEGMENTS) fail('limit');
      return { kind, segments };
    });
  }
  root.StreamPlan = { hls, dash, url, select, MAX_SEGMENTS };
  if (typeof module !== 'undefined') module.exports = root.StreamPlan;
})(globalThis);
