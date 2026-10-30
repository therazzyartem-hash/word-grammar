'use strict';

// Свои правила пунктуации для русского — то, что бесплатный LanguageTool пропускает.
// Работают локально и мгновенно. Возвращают ошибки в том же виде, что и LanguageTool.
(function (global) {
  const WORD_RE = /[А-Яа-яЁёA-Za-z]+(?:-[А-Яа-яЁёA-Za-z]+)*/g;

  const PREPS = ['в', 'во', 'на', 'о', 'об', 'обо', 'по', 'с', 'со', 'к', 'ко', 'у', 'из', 'от', 'до', 'за',
    'для', 'без', 'при', 'про', 'над', 'под', 'через', 'между', 'перед', 'из-за', 'из-под', 'среди', 'около', 'вокруг'];
  // После этих слов запятая перед союзом не нужна (она ставится раньше или не ставится вовсе)
  const COMMON_EXCEPT = ['и', 'а', 'но', 'или', 'либо', 'да', 'ни', 'не', 'же', 'ли', 'бы', 'ведь', 'вот', 'ну',
    'ибо', 'даже', 'лишь', 'только', 'именно', 'чем', 'нежели', 'кое', 'тот', 'та'];

  const KOTOR = ['который', 'которая', 'которое', 'которые', 'которого', 'которой', 'которому', 'которым',
    'которых', 'которую', 'которыми', 'котором'];

  // союз -> какие слова перед ним «перешагнуть» (запятая встаёт перед ними) и после каких слов запятая не нужна
  const CONJ = {
    'что': { back: [...PREPS, 'потому', 'оттого', 'благодаря'], except: [...COMMON_EXCEPT, 'так', 'после', 'прежде', 'вместо', 'всё-таки', 'только'] },
    'чтобы': { back: [], except: [...COMMON_EXCEPT, 'того'] },
    'хотя': { back: [], except: COMMON_EXCEPT, notBefore: ['бы'] },
    'будто': { back: ['как'], except: COMMON_EXCEPT },
    'словно': { back: [], except: COMMON_EXCEPT },
    'если': { back: ['даже', 'лишь', 'только', 'особенно', 'разве'], except: COMMON_EXCEPT },
  };
  for (const k of KOTOR) CONJ[k] = { back: PREPS, except: COMMON_EXCEPT };

  const INTRO = ['конечно', 'наверное', 'наверно', 'например', 'во-первых', 'во-вторых', 'в-третьих',
    'к сожалению', 'к счастью', 'к несчастью', 'кстати', 'впрочем', 'видимо', 'безусловно', 'разумеется',
    'пожалуй', 'честно говоря', 'итак', 'во всяком случае', 'таким образом', 'между прочим',
    'кроме того', 'следовательно', 'несомненно', 'по-моему', 'по-видимому', 'вероятно', 'слава богу'];

  function make(offset, bad, repl, message, rule) {
    return { offset, length: bad.length, bad, repl: [repl], message, rule, category: 'PUNCTUATION' };
  }

  // ---------- обороты: распознаём по окончаниям, без настоящего разбора предложения ----------

  const set = s => new Set(s.split(' '));
  const GERUND_WORDS = set('читая думая играя гуляя зная мечтая вспоминая понимая слушая отвечая обнимая прижимая ' +
    'кивая качая открывая закрывая поднимая опуская снимая надевая ожидая наблюдая повторяя теряя бросая толкая ' +
    'хватая желая делая шагая вздыхая моргая мигая вытирая сжимая вдыхая выдыхая представляя оставляя убегая ' +
    'догоняя напевая пожимая глядя сидя стоя лёжа лежа видя слыша неся ведя идя крича дыша держа говоря прося ' +
    'нося ходя любя таща топая зевая сияя тая лая');
  const ALONE_ADVERB = set('сидя стоя лёжа лежа');  // без зависимых слов — наречие, запятые не нужны
  const NOT_GERUND_V = set('лев гнев рев рёв сев хлев посев напев припев запев рукав состав устав сплав нрав прав удав ' +
    'архив мотив актив залив пролив прилив отлив перелив курсив коллектив детектив позитив негатив объектив ' +
    'взрыв порыв отрыв перерыв призыв отзыв срыв нарыв разрыв обрыв прорыв надрыв позыв держав канав забав дубрав ' +
    'отрав приправ переправ оправ расправ красив некрасив ленив ревнив учтив лжив жив правдив спесив плаксив игрив ' +
    'милостив статуя карась трав глав слав здрав');
  const CHIV_GERUNDS = set('закончив окончив кончив огорчив');
  const PART_STOP = ['следующ', 'будущ', 'настоящ', 'предыдущ', 'подходящ', 'блестящ', 'бывш', 'заведующ', 'управляющ',
    'трудящ', 'отдыхающ', 'текущ', 'всемогущ', 'могущ', 'вопиющ', 'соответствующ', 'окружающ', 'присутствующ',
    'грядущ', 'сущ', 'животрепещущ', 'немыслящ', 'работающ'];
  const NOT_PAST = set('стол стола пол пола угол зал зала вокзал вокзала сигнал канал финал журнал генерал материал ' +
    'капитал подвал ангел пепел котел котёл орел орёл осел осёл козел козёл посол футбол глагол укол пенал бокал идеал ' +
    'оригинал интервал шакал стул аул гул тыл пыл вол кол раскол прикол протокол мол весел мил цел бел зол гол ' +
    'дела тела села начала начало дело тело село мыло шило крыло сало жало правило зеркало одеяло светило покрывало ' +
    'мало немало смело умело школа сила могила акула скула кобыла пчела стрела смола скала похвала пила жила ' +
    'цели дали печали детали недели постели метели пыли соли воли боли роли доли пули ели мели вдали издали');
  const NOT_PRES = set('совет ответ привет рассвет предмет портрет секрет бюджет пакет пистолет скелет буфет конфет ' +
    'монет ракет планет кадет паркет балет билет сюжет обет завет запрет полет полёт отчет отчёт расчет расчёт учет ' +
    'учёт переплет самолет самолёт вертолёт пулемёт налёт взлёт аппетит кредит визит бандит гранит магнит динамит ' +
    'иммунитет авторитет факультет университет комитет приоритет амулет кабинет интернет атрибут институт маршрут ' +
    'минут салют приют валют абсолют солдат закат автомат результат аромат халат плакат адвокат кандидат депутат ' +
    'агрегат ребят котят поросят внучат девчат занят понят принят снят взят начат смят одет лишь опять');
  const PRONOUNS = set('я ты он она оно мы вы они');
  const SUBORD = set('что чтобы как который которая которое которые когда где куда откуда если хотя будто словно пока потому');
  const COORD = set('и а но да или');
  const PREP_SET = new Set(PREPS);
  const IDIOMS = ['сломя голову', 'спустя рукава', 'не покладая рук', 'засучив рукава', 'затаив дыхание', 'сложа руки',
    'положа руку', 'скрепя сердце', 'разинув рот', 'высунув язык', 'не переводя дыхания', 'не смыкая глаз', 'очертя голову'];

  function isGerund(lw) {
    if (lw.length < 4) return false;
    if (GERUND_WORDS.has(lw)) return true;
    if (NOT_GERUND_V.has(lw)) return false;
    if (lw.length === 4) return /(ав|яв)$/.test(lw);                 // сняв, взяв, став
    if (/вшись$|вши$/.test(lw)) return true;
    if (/ясь$/.test(lw) || (/ась$/.test(lw) && !/лась$/.test(lw))) return true;
    if (/[ую]я$/.test(lw)) return true;
    if (/(став|дав|знав)ая$/.test(lw)) return true;                     // переставая, давая, узнавая
    if (/яя$/.test(lw) && lw !== 'синяя' && (!/няя$/.test(lw) || /[оеслиа]няя$/.test(lw))) return true; // разгоняя, но не летняя
    if (/ывая$|[гкхшщчж]ивая$/.test(lw)) return true;
    if (/(ав|яв|ев|ив|ыв|ув)$/.test(lw)) {
      if (/[аеёиоуыэюяь]ев$/.test(lw) || /лив$/.test(lw)) return false;       // героев, красив, счастлив
      if (/[^аеёиоуыэюя]чив$/.test(lw) && !CHIV_GERUNDS.has(lw)) return false; // задумчив, настойчив
      return true;
    }
    return false;
  }

  const PART_RE = /(ющ|ящ|ащ|ущ|вш|росш|несш|нёсш|везш|вёзш|умерш|гибш|стигш|влекш|легш|лёгш|пекш)(ий|ая|ее|ие|его|ей|ему|им|их|ую|ими|ем|ого|ому|ой|ым|ых|ыми)(ся|сь)?$/;
  // страдательные: окутанный, освещённый (часть — прилагательные, их отсекаем)
  const PASSIVE_RE = /(анн|янн|енн|ённ)(ый|ая|ое|ые|ого|ой|ому|ым|ых|ую|ыми|ом)$/;
  const PASSIVE_STOP = /(ственн|деревянн|стеклянн|оловянн|военн|временн|туманн|странн|длинн|каменн|пламенн|карманн|ванн|осенн|утренн|старинн)/;
  function isParticiple(lw) {
    if (lw.length < 6) return false;
    if (PASSIVE_RE.test(lw)) return lw.length >= 8 && !PASSIVE_STOP.test(lw);
    return PART_RE.test(lw) && !PART_STOP.some(r => lw.startsWith(r));
  }

  // Подходит ли окончание слова перед причастием к окончанию причастия (род, число, падеж)
  const AGREE = [
    [/(ий|ый)$/, /[бвгджзклмнпрстфхцчшщйь]$/], [/ая$/, /[аяь]$/], [/(ее|ое)$/, /[оеёя]$/],
    [/(ие|ые)$/, /[ыиа]$/], [/(его|ого)$/, /[ая]$/], [/(ей|ой)$/, /(ы|и|е|ой|ей)$/], [/(ему|ому)$/, /[ую]$/],
    [/(ими|ыми)$/, /(ами|ями)$/], [/(им|ым)$/, /(ом|ем|ём|ам|ям)$/],
    [/(их|ых)$/, /(ов|ев|ей|[бвгджзклмнпрстфхцчшщ])$/], [/ую$/, /[уюь]$/], [/(ем|ом)$/, /[еи]$/],
  ];
  const ADJ_END = /(ая|яя|ое|ее|ый|ий|ой|ые|ие|ую|юю|ого|его|ому|ему|ым|им|ых|их|ыми|ими)$/;
  const VERBISH = /(ть|ться|йти|чь|л|ла|ло|ли|лся|лась|лось|лись)$/;
  const NEG_OBJ = set('ничего никого ничем никому ничему никак никуда нигде нисколько');
  const PRON_ADJ = set('такая какая никакая любая другая самая каждая всякая чужая первая вторая иная одна');
  const PARTICLES = set('же ли бы ведь то');

  // «-ая» бывает и у деепричастий (перебирая), и у прилагательных (новая). Деепричастие — если следующее
  // слово не согласуется с ним как существительное женского рода
  function isAyaGerund(tokens, g, spaceOnly) {
    const t = tokens[g], nxt = tokens[g + 1];
    if (!/[^аеёиоуыэюя]ая$/.test(t.lw) || t.lw.length < 6 || PRON_ADJ.has(t.lw)) return false;
    if (!nxt || !spaceOnly(t, nxt) || /^[А-ЯЁA-Z]/.test(nxt.w)) return false;
    if (COORD.has(nxt.lw) || PARTICLES.has(nxt.lw) || PREP_SET.has(nxt.lw)) return false;
    return !/[аяь]$/.test(nxt.lw) && !/(ая|яя)$/.test(nxt.lw);
  }

  function agrees(noun, part) {
    if (ADJ_END.test(noun) || VERBISH.test(noun)) return false;
    const base = part.replace(/(ся|сь)$/, '');
    for (const [pe, ne] of AGREE) if (pe.test(base)) return ne.test(noun);
    return false;
  }

  const PAST_EXTRA = set('лёг лег мог смог помог нёс нес принёс унёс вёз рос вырос умер замер стёр тёр замёрз привык ' +
    'исчез погиб достиг промок засох затих стих');
  const NOT_PAST_CONS = set('игла мгла стекла весла числа масла кресла мысли ясли светла зла смысла промысла умысла ' +
    'орла козла узла осла котла дятла ремесла ремесло число весло масло кресло стекло русло зло');
  const isPast = lw => PAST_EXTRA.has(lw) ||
    (lw.length >= 4 && /[аеёиоуыя]л(а|о|и)?(сь|ся)?$/.test(lw) && !NOT_PAST.has(lw)) ||
    (lw.length >= 5 && /[гзсбкр]л[аои](сь)?$/.test(lw) && !NOT_PAST_CONS.has(lw));   // легла, могла, несла, умерла
  // наречия перед глаголом обычно относятся к нему, а не к обороту: «…, быстро вошёл»
  const MAIN_ADVERBS = set('сразу вдруг уже снова опять тоже также тут затем потом наконец всё ещё вновь тотчас');
  const isMainAdverb = lw => MAIN_ADVERBS.has(lw) || (lw.length >= 4 && /о$/.test(lw) && !/(ого|его)$/.test(lw));
  const isPres = lw => lw.length >= 5 && /(ет|ёт|ит|ут|ют|ат|ят|ется|ётся|ится|утся|ются|атся|ятся|ешь|ёшь|ишь)$/.test(lw) &&
    !NOT_PRES.has(lw) && !isParticiple(lw);

  function phrases(text, tokens, out) {
    const gap = (a, b) => text.slice(a.end, b.start);
    const spaceOnly = (a, b) => /^\s+$/.test(gap(a, b));
    const sentenceStart = i => i === 0
      ? !/[А-Яа-яЁёA-Za-z0-9]/.test(text.slice(0, tokens[0].start))
      : /[.!?…]/.test(gap(tokens[i - 1], tokens[i]));
    const lowerText = text.toLowerCase();

    // Граница оборота: глагол, личное местоимение, имя (не после предлога)
    function boundary(k) {
      const t = tokens[k], prev = tokens[k - 1];
      if (prev && PREP_SET.has(prev.lw)) return null;
      if (PRONOUNS.has(t.lw)) return 'pronoun';
      if (isPast(t.lw) || isPres(t.lw)) return 'verb';
      if (/^[А-ЯЁA-Z]/.test(t.w)) return 'name';
      return null;
    }

    // Конец оборота, начиная со слова g. Возвращает { end, closed, kind } или null, если не уверены
    function scan(g, isPart) {
      let k = g;
      for (;;) {
        const nxt = tokens[k + 1];
        if (!nxt || !spaceOnly(tokens[k], nxt)) return { end: k, closed: true };
        // «слушая, как взрослые разговаривают» — оборот заканчивается перед придаточным
        if (SUBORD.has(nxt.lw)) return COORD.has(tokens[k].lw) ? null : { end: k, closed: false, kind: 'subord' };
        if (isGerund(nxt.lw) && !isPart && !COORD.has(tokens[k].lw)) return null; // два оборота подряд — не берёмся
        let kind = boundary(k + 1);
        // «…читающий книгу, не заметил»
        if (!kind && nxt.lw === 'не' && tokens[k + 2] && spaceOnly(nxt, tokens[k + 2]) && boundary(k + 2) === 'verb') kind = 'verb';
        if (kind) {
          let end = k;
          if (COORD.has(tokens[end].lw)) end--;                   // «…глядя в окно, и думал»
          while (end > g && kind === 'verb' && isMainAdverb(tokens[end].lw) && !PREP_SET.has(tokens[end - 1].lw)) end--;
          if (end < g) return null;
          return { end, closed: false, kind };
        }
        k++;
        if (k - g > 8) return null;                               // слишком длинно — не угадаем
      }
    }

    function emit(s, end, opening, closing, message, auto) {
      if (!opening && !closing) return;
      const from = opening ? tokens[s - 1] : tokens[s];
      const to = tokens[end];
      const bad = text.slice(from.start, to.end);
      if (bad.length > 255) return;
      let repl = opening ? from.w + ',' + text.slice(from.end, to.end) : bad;
      if (closing) repl += ',';
      const m = make(from.start, bad, repl, message, 'KORR_PHRASE');
      if (!auto) {
        m.auto = false;
        m.message += ' Проверь, где заканчивается оборот: сам не исправляю.';
      }
      out.push(m);
    }

    tokens.forEach((t, g) => {
      const gerund = (isGerund(t.lw) || isAyaGerund(tokens, g, spaceOnly)) && (g === 0 || sentenceStart(g) || /^[а-яё]/.test(t.w));
      const part = !gerund && isParticiple(t.lw);
      if (!gerund && !part) return;

      let s = g;
      if (gerund && g > 0 && tokens[g - 1].lw === 'не' && spaceOnly(tokens[g - 1], t)) {
        s = g - 1;
        // «ничего не ответив», «ни слова не сказав» — отрицание с дополнением тоже часть оборота
        if (s > 0 && NEG_OBJ.has(tokens[s - 1].lw) && spaceOnly(tokens[s - 1], tokens[s])) s--;
        else if (s > 1 && tokens[s - 2].lw === 'ни' && spaceOnly(tokens[s - 2], tokens[s - 1])) s -= 2;
      }
      if (IDIOMS.some(idm => lowerText.startsWith(idm, tokens[s].start))) return;

      const atStart = sentenceStart(s);
      const prev = tokens[s - 1];
      const prevPunct = prev && !spaceOnly(prev, tokens[s]);

      const r = scan(g, part);
      if (!r) return;
      if (gerund && ALONE_ADVERB.has(t.lw) && r.end === g) return;

      if (gerund) {
        let opening = !atStart && !prevPunct;
        if (opening && PREP_SET.has(prev.lw)) return;
        if (opening && COORD.has(prev.lw)) {
          if (r.closed) return;                                   // «и улыбаясь вышел.» — не трогаем
          // «Он встал и, оглянувшись, вышел» — запятая после союза
        }
        const closing = !r.closed;
        // В начале предложения перед глаголом может стоять подлежащее («Вернувшись домой мама легла») — не уверены
        const auto = !(atStart && r.kind === 'verb' && r.end > g);
        const phrase = tokens.slice(s, r.end + 1).map(x => x.w).join(' ');
        emit(s, r.end, opening, closing, `Деепричастный оборот «${phrase}» выделяется запятыми.`, auto);
      } else {
        // причастный оборот обособляется, только если стоит после определяемого слова и имеет зависимые слова
        if (atStart || !prev || r.end === g) return;
        if (!prevPunct && !agrees(prev.lw, t.lw)) return;
        if (prevPunct && !/,\s*$/.test(gap(prev, t))) return;
        if (tokens[s - 2] && tokens[s - 2].lw === 'я') return;   // «я вижу сидящую…»
        const opening = !prevPunct;
        const closing = !r.closed;
        const phrase = tokens.slice(s, r.end + 1).map(x => x.w).join(' ');
        emit(s, r.end, opening, closing, `Причастный оборот «${phrase}» после определяемого слова выделяется запятыми.`, true);
      }
    });
  }

  function check(text) {
    const out = [];
    const tokens = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) tokens.push({ w: m[0], lw: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
    const gapIsSpace = (a, b) => /^\s+$/.test(text.slice(a.end, b.start));

    // 1. Запятая перед подчинительными союзами и «который»
    tokens.forEach((t, i) => {
      const rule = CONJ[t.lw];
      if (!rule || i === 0) return;
      const after = text.slice(t.end);
      if (/^[-,]/.test(after)) return;                          // что-то, «он что, дурак?»
      const next = tokens[i + 1];
      if (next && gapIsSpace(t, next) && ['ли', 'иное'].includes(next.lw) && t.lw === 'что') return;
      if (next && rule.notBefore && rule.notBefore.includes(next.lw)) return;

      let j = i - 1;
      if (!gapIsSpace(tokens[j], t)) return;                   // уже стоит знак
      while (j >= 0 && rule.back.includes(tokens[j].lw)) {
        if (j === 0 || !gapIsSpace(tokens[j - 1], tokens[j])) return;
        j--;
      }
      const p = tokens[j];
      if (rule.except.includes(p.lw)) return;
      const lead = tokens.slice(j + 1, i + 1).map(x => x.w).join(' ');
      out.push(make(p.start, p.w, p.w + ',', `Перед «${lead}» обычно нужна запятая.`, 'KORR_COMMA_CONJ'));
    });

    // 1б. Закрывающая запятая после «который»: «Книга, которую она читала, лежала…» —
    // запятая перед вторым глаголом (первый — сказуемое придаточного)
    tokens.forEach((t, i) => {
      if (!KOTOR.includes(t.lw)) return;
      let firstVerb = -1;
      for (let k = i + 1; k < tokens.length && k <= i + 9; k++) {
        if (!gapIsSpace(tokens[k - 1], tokens[k])) return;     // знак уже стоит или конец предложения
        const lw = tokens[k].lw;
        if (SUBORD.has(lw) || COORD.has(lw)) return;
        if (PREP_SET.has(tokens[k - 1].lw) || !(isPast(lw) || isPres(lw))) continue;
        if (firstVerb < 0) { firstVerb = k; continue; }
        let e = k - 1;
        if (tokens[e].lw === 'не') e--;
        while (e > firstVerb && isMainAdverb(tokens[e].lw) && !PREP_SET.has(tokens[e - 1].lw)) e--; // «родился, сильно изменился»
        if (e < firstVerb) return;
        out.push(make(tokens[e].start, tokens[e].w, tokens[e].w + ',', 'Придаточное с «который» закрывается запятой.', 'KORR_KOTOR_END'));
        return;
      }
    });

    // 2. Вводные слова в начале предложения
    const lower = text.toLowerCase();
    for (const w of INTRO) {
      let pos = 0;
      for (;;) {
        const i = lower.indexOf(w, pos);
        if (i < 0) break;
        pos = i + w.length;
        const before = text.slice(0, i).replace(/[\s«"„—–-]+$/, '');
        if (before && !/[.!?…]$/.test(before)) continue;       // не начало предложения
        const rest = text.slice(i + w.length);
        if (!/^\s+[А-Яа-яЁёA-Za-z]/.test(rest)) continue;       // уже есть запятая/конец
        if (/^\s+(ли|же|и|бы)(?![А-Яа-яЁё])/i.test(rest) || /[А-Яа-яЁё]/.test(text[i - 1] || '')) continue;
        const word = text.substr(i, w.length);
        out.push(make(i, word, word + ',', `«${word}» — вводное слово, выделяется запятой.`, 'KORR_INTRO'));
      }
    }

    // 3. Пробел перед знаком препинания: «Привет , как дела ?»
    text.replace(/([^\s])([  ]+)([,.!?;:…]+)/g, (all, ch, sp, punct, off) => {
      const o = off + 1;
      out.push(make(o, sp + punct, punct, 'Перед знаком препинания пробел не ставится.', 'KORR_SPACE_BEFORE'));
      return all;
    });

    // 4. Нет пробела после знака: «да,нет»  «пришёл.Потом»
    text.replace(/([А-Яа-яЁёA-Za-z]{2,}|[»)])([,;:])([А-Яа-яЁёA-Za-z])/g, (all, w, p, n, off) => {
      const o = off + w.length;
      out.push(make(o, p + n, p + ' ' + n, 'После знака препинания нужен пробел.', 'KORR_SPACE_AFTER'));
      return all;
    });
    text.replace(/([а-яё]{2,}|[»)])([.!?…]+)([А-ЯЁ])/g, (all, w, p, n, off) => {
      const o = off + w.length;
      out.push(make(o, p + n, p + ' ' + n, 'После конца предложения нужен пробел.', 'KORR_SPACE_AFTER'));
      return all;
    });

    // 5. Двойные запятые
    text.replace(/,{2,}/g, (all, off) => { out.push(make(off, all, ',', 'Лишняя запятая.', 'KORR_DOUBLE_COMMA')); return all; });

    // 6. Дефис вместо тире: в начале реплики и между словами
    const dl = /^(\s*)([-–])(\s)/.exec(text);
    if (dl) out.push(make(dl[1].length, dl[2] + dl[3], '—' + dl[3], 'Реплика в диалоге начинается с тире (—), а не с дефиса.', 'KORR_DASH'));
    text.replace(/([^\s\d-])( [-–] )(?=\S)/g, (all, ch, d, off) => {
      out.push(make(off + 1, d, ' — ', 'Между словами ставится тире (—), а не дефис.', 'KORR_DASH'));
      return all;
    });

    // 7. Нет точки в конце длинного абзаца
    const trimmed = text.replace(/\s+$/, '');
    if (tokens.length >= 6 && /[А-Яа-яЁёA-Za-z0-9]$/.test(trimmed)) {
      const last = tokens[tokens.length - 1];
      if (last.end === trimmed.length) {
        out.push(make(last.start, last.w, last.w + '.', 'В конце предложения нужен знак препинания.', 'KORR_END'));
      }
    }

    // 8. Деепричастные и причастные обороты
    phrases(text, tokens, out);

    // убираем пересечения своих правил (оставляем первое найденное)
    out.sort((a, b) => a.offset - b.offset);
    const res = [];
    let end = -1;
    for (const x of out) { if (x.offset >= end) { res.push(x); end = x.offset + x.length; } }
    return res;
  }

  global.checkPunctuation = check;
})(typeof window !== 'undefined' ? window : globalThis);
