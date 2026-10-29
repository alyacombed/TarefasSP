// resolvedor heurístico (sem IA) — fallback por questão.
// portado de buildAnswers() de js/api.js. usado quando a IA falha ou retorna shape inválido.

function rand(n) { return Math.floor(Math.random() * n); }

// o site grava a questão como: question_type = q.rawType || q.type (2025+).
// mandar só "type" quando rawType é o campo real derruba a nota (NaN).
function tipoQuestao(q) {
  return (q.rawType && String(q.rawType).trim() && String(q.rawType).trim() !== 'undefined') ? q.rawType : q.type;
}

export function buildAnswers(task, essayText) {
  const out = {};
  for (const q of (task.questions || [])) {
    if (q.type === 'info' || q.type === 'media') {
      out[q.id] = { question_id: q.id, question_type: tipoQuestao(q) };
      continue;
    }

    const a = { question_id: q.id, question_type: tipoQuestao(q), answer: {} };

    switch (q.type) {
      case 'single':
      case 'single-choice': {
        const opts = q.options || {};
        const keys = Object.keys(opts);
        const gab = keys.filter(k => opts[k] && opts[k].answer === true);
        const pick = gab.length ? gab[0] : (keys.length ? keys[rand(keys.length)] : null);
        a.answer = {};
        for (const k of keys) a.answer[k] = (k === pick);
        break;
      }

      case 'multi':
      case 'multiple-choice': {
        const opts = q.options || {};
        const keys = Object.keys(opts);
        const gab = keys.filter(k => opts[k] && opts[k].answer === true);
        a.answer = {};
        if (gab.length) {
          for (const k of keys) a.answer[k] = gab.includes(k);
        } else {
          const idxs = keys.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, Math.min(2, keys.length));
          for (let i = 0; i < keys.length; i++) a.answer[keys[i]] = idxs.includes(i);
          if (!Object.values(a.answer).some(v => v) && keys.length) a.answer[keys[0]] = true;
        }
        break;
      }

      case 'true-false': {
        const opts = q.options || {};
        const keys = Object.keys(opts);
        a.answer = {};
        const hasGab = keys.some(k => opts[k] && typeof opts[k].answer === 'boolean');
        for (const k of keys) {
          if (hasGab) a.answer[k] = !!(opts[k] && opts[k].answer);
          else a.answer[k] = (Math.random() < 0.5);
        }
        break;
      }

      case 'fill-words': {
        const phrase = (q.options && q.options.phrase) || [];
        const pool = Array.isArray(q.options?.items) ? q.options.items : [];
        const isBlank = s => (typeof s === 'string' && /^[_…\s]+$/.test(s))
          || (s && (s.type === 'select' || s.type === 'input' || s.type === 'blank' || s.type === 'gap' || s.answer != null));
        const blanks = phrase.filter(isBlank);
        // se a plataforma vazou o gabarito em `slot.answer`, usa ele — resposta
        // determinística (sem chute). só cai no banco por ordem quando falta.
        const usadas = new Set();
        a.answer = blanks.map(s => {
          const gab = s && s.answer != null ? String(s.answer).trim() : '';
          if (gab) { usadas.add(gab.toLowerCase()); return gab; }
          if (pool.length) {
            const w = pool.find(x => !usadas.has(String(x).toLowerCase())) || pool[0];
            usadas.add(String(w).toLowerCase());
            return String(w);
          }
          return '';
        });
        break;
      }

      case 'fill-letters': {
        const n = (q.options && typeof q.options.letters === 'number') ? q.options.letters : 0;
        const embutido = q.options && typeof q.options.answer === 'string' ? q.options.answer : '';
        // referência (saladopassado/app.py) envia STRING simples pra fill-letters
        a.answer = embutido || ' '.repeat(n);
        break;
      }

      case 'order-sentences': {
        const sents = (q.options && q.options.sentences) || [];
        const incs = (q.options && q.options.incorrects) || [];
        const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '');
        const incByText = new Map();
        for (const it of incs) if (it && it.id) incByText.set(norm(it.value), it.id);
        const usados = new Set();
        a.answer = sents.map(s => {
          const id = incByText.get(norm(s));
          if (id && !usados.has(id)) { usados.add(id); return id; }
          const livre = incs.find(it => it && it.id && !usados.has(it.id));
          if (livre) { usados.add(livre.id); return livre.id; }
          return '';
        });
        break;
      }

      case 'cloud': {
        const words = (q.options && Array.isArray(q.options.words)) ? q.options.words : [];
        a.answer = words.slice();
        break;
      }

      case 'text':
      case 'text_ai':
      case 'text-ai':
      case 'free-text':
      case 'essay':
      case 'reflection': {
        let texto = essayText && essayText.trim().length ? essayText : '';
        if (!texto) {
          const kws = Array.isArray(q.options?.ai_grading_keywords) ? q.options.ai_grading_keywords : [];
          const stmt = String(q.statement || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const palavras = stmt.toLowerCase().split(/\s+/).filter(w => w.length > 5).slice(0, 3);
          const tema = palavras.length ? palavras.join(' ') : 'o tema apresentado';
          const kwBloco = kws.length
            ? ` Os conceitos de ${kws.join(', ')} sao centrais nesse contexto e ajudam a explicar o que esta sendo observado.`
            : '';
          texto = `A questao sobre ${tema} envolve aspectos importantes que merecem analise cuidadosa.${kwBloco} O assunto se conecta com situacoes praticas discutidas em aula e exige raciocinio critico para identificar suas implicacoes teoricas e cotidianas, demonstrando que nao pode ser compreendido isoladamente mas sim dentro de um contexto mais amplo.`;
        }
        // redação/texto longo: referência (saladopassado/app.py) envia {title, body}
        // e o site valida essay (title,body). o essay-check e o grader fazem split
        // por essas chaves — {0: texto} era grafado como corpo sem título → NaN.
        const ehEssay = ['essay', 'reflection', 'text_ai', 'text-ai', 'free-text'].includes(tipoQuestao(q));
        if (ehEssay) {
          const [titulo, ...resto] = String(texto).split(/\n{2,}/).filter(Boolean);
          a.answer = { title: (titulo || texto).slice(0, 300), body: (resto.join('\n\n') || texto).slice(0, 8000) };
        } else {
          a.answer = { 0: texto };
        }
        break;
      }

      default: {
        const opts = q.options || {};
        if (Array.isArray(opts)) {
          a.answer = opts.length ? [opts[0]] : [];
        } else if (opts && typeof opts === 'object') {
          const keys = Object.keys(opts);
          if (keys.length) {
            const first = opts[keys[0]];
            if (first && typeof first === 'object' && (first.id !== undefined || first.key !== undefined)) {
              a.answer = [first.id ?? first.key];
            } else {
              a.answer = {};
              for (const k of keys) a.answer[k] = (k === keys[0]);
            }
          } else {
            a.answer = {};
          }
        } else {
          a.answer = {};
        }
      }
    }
    out[q.id] = a;
  }
  return out;
}
