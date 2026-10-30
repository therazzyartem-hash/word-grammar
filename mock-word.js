// Имитация Office/Word API для test.html: «документ» — textarea в родительском окне, абзацы — строки
(function () {
  const ta = () => parent.document.getElementById('doc');
  const getParas = () => ta().value.split('\n');
  const settings = {};

  function findAll(text, needle) {
    needle = needle.replace(/\^\^/g, '^');
    const out = [];
    let pos = 0;
    for (;;) {
      const i = text.indexOf(needle, pos);
      if (i < 0 || !needle) return out;
      out.push({ start: i, len: needle.length });
      pos = i + needle.length;
    }
  }

  function makeRange(pi, start, len) {
    return {
      text: getParas()[pi].substr(start, len),
      insertText(t) {
        const ps = getParas();
        ps[pi] = ps[pi].slice(0, start) + t + ps[pi].slice(start + len);
        ta().value = ps.join('\n');
      },
      select() {
        const ps = getParas();
        let abs = 0;
        for (let i = 0; i < pi; i++) abs += ps[i].length + 1;
        ta().focus();
        ta().setSelectionRange(abs + start, abs + start + len);
      },
    };
  }

  function makeParagraphs() {
    const items = getParas().map((text, pi) => ({
      text,
      search(s) { return { load() {}, items: findAll(getParas()[pi], s).map(r => makeRange(pi, r.start, r.len)) }; },
    }));
    return { load() {}, items };
  }

  window.Office = {
    HostType: { Word: 'Word' },
    onReady(cb) { setTimeout(() => cb && cb({ host: 'Word' }), 0); },
    context: {
      requirements: { isSetSupported: () => true },
      document: { settings: { get: k => settings[k], set: (k, v) => { settings[k] = v; }, saveAsync() {} } },
    },
  };
  window.Word = {
    ChangeTrackingMode: { trackAll: 'TrackAll', off: 'Off' },
    async run(fn) {
      // режим исправлений: текущее значение и история смен — для проверки в test.html
      const doc = {
        body: { get paragraphs() { return makeParagraphs(); } },
        load() {},
        get changeTrackingMode() { return parent.trackMode || 'Off'; },
        set changeTrackingMode(v) { parent.trackMode = v; (parent.trackLog = parent.trackLog || []).push(v); },
      };
      const ctx = { document: doc, sync: async () => {} };
      return fn(ctx);
    },
  };
})();
