(function () {
  'use strict';

  const STORAGE_KEY = 'qc_kentei_stats';
  const CATEGORY_LABELS = {
    doe: '実験計画法',
    multivariate: '多変量解析',
    statistics: '統計的手法',
    all: '総合演習'
  };

  // ---------- State ----------
  let state = {
    category: null,
    questions: [],
    index: 0,
    score: 0,
    answered: false,
    wrongItems: [],
    stats: loadStats()
  };

  // ---------- DOM helpers ----------
  const $ = id => document.getElementById(id);

  function show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(screenId).classList.add('active');
  }

  // ---------- Stats persistence ----------
  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return s || { answered: 0, correct: 0 };
    } catch { return { answered: 0, correct: 0 }; }
  }

  function saveStats() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.stats));
  }

  // ---------- Home ----------
  function renderHome() {
    const { answered, correct } = state.stats;
    $('stat-answered').textContent = answered;
    $('stat-correct').textContent = correct;
    $('stat-rate').textContent = answered > 0
      ? Math.round(correct / answered * 100) + '%'
      : '-';

    const categories = ['doe', 'multivariate', 'statistics'];
    categories.forEach(cat => {
      const count = QUESTIONS.filter(q => q.category === cat).length;
      $('count-' + cat).textContent = count + '問';
    });
    $('count-all').textContent = QUESTIONS.length + '問';

    show('home-screen');
  }

  // ---------- Quiz setup ----------
  function startQuiz(category) {
    state.category = category;
    let pool = category === 'all'
      ? [...QUESTIONS]
      : QUESTIONS.filter(q => q.category === category);

    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    state.questions = pool;
    state.index = 0;
    state.score = 0;
    state.answered = false;
    state.wrongItems = [];

    $('quiz-category-label').textContent = CATEGORY_LABELS[category];
    show('quiz-screen');
    renderQuestion();
  }

  function renderQuestion() {
    const q = state.questions[state.index];
    const total = state.questions.length;
    const num = state.index + 1;

    $('quiz-counter').textContent = num + ' / ' + total;
    $('quiz-score').textContent = state.score + '点';
    $('progress-fill').style.width = ((num - 1) / total * 100) + '%';
    $('question-text').textContent = q.text;

    const wrap = $('choices-wrap');
    wrap.innerHTML = '';
    q.choices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.innerHTML =
        '<span class="choice-num">' + (i + 1) + '</span>' +
        '<span>' + choice + '</span>';
      btn.addEventListener('click', () => selectAnswer(i));
      wrap.appendChild(btn);
    });

    $('feedback-wrap').classList.add('hidden');
    state.answered = false;
  }

  function selectAnswer(choiceIndex) {
    if (state.answered) return;
    state.answered = true;

    const q = state.questions[state.index];
    const isCorrect = choiceIndex === q.answer;

    if (isCorrect) {
      state.score++;
      state.stats.correct++;
    } else {
      state.wrongItems.push({ q, chosen: choiceIndex });
    }
    state.stats.answered++;
    saveStats();

    // Visual feedback on buttons
    const buttons = $('choices-wrap').querySelectorAll('.choice-btn');
    buttons.forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.answer) btn.classList.add('correct');
      else if (i === choiceIndex && !isCorrect) btn.classList.add('wrong');
    });

    // Show feedback panel
    const fb = $('feedback-wrap');
    const fbHeader = $('feedback-header');
    fbHeader.className = 'feedback-header ' + (isCorrect ? 'correct' : 'wrong');
    $('feedback-icon').textContent = isCorrect ? '✅' : '❌';
    $('feedback-label').textContent = isCorrect ? '正解！' : '不正解...';

    if (!isCorrect) {
      $('correct-hint').classList.remove('hidden');
      $('correct-text').textContent = q.choices[q.answer];
    } else {
      $('correct-hint').classList.add('hidden');
    }

    $('explanation').textContent = q.explanation;

    const isLast = state.index === state.questions.length - 1;
    $('next-btn').textContent = isLast ? '結果を見る' : '次の問題へ →';

    fb.classList.remove('hidden');
    fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function nextQuestion() {
    state.index++;
    if (state.index >= state.questions.length) {
      showResult();
    } else {
      renderQuestion();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---------- Result ----------
  function showResult() {
    const total = state.questions.length;
    const score = state.score;
    const pct = Math.round(score / total * 100);

    let emoji, title, msg;
    if (pct >= 90) {
      emoji = '🏆'; title = '優秀！'; msg = '素晴らしい成績です。合格水準に達しています！';
    } else if (pct >= 70) {
      emoji = '👍'; title = 'よくできました'; msg = 'もう少し！苦手分野を中心に復習しましょう。';
    } else if (pct >= 50) {
      emoji = '📚'; title = 'もう少し'; msg = '基礎の復習と問題演習を繰り返しましょう。';
    } else {
      emoji = '💪'; title = 'がんばろう！'; msg = '解説をしっかり読んで基礎から固め直しましょう。';
    }

    $('result-emoji').textContent = emoji;
    $('result-title').textContent = title;
    $('score-num').textContent = score;
    $('score-denom').textContent = '/ ' + total + '問 (' + pct + '%)';
    $('result-msg').textContent = msg;

    // Wrong answers review
    const section = $('review-section');
    if (state.wrongItems.length > 0) {
      let html = '<div class="review-title">間違えた問題</div>';
      state.wrongItems.forEach(({ q, chosen }) => {
        html += '<div class="review-item">';
        html += '<div class="review-q">' + q.text.slice(0, 60) + (q.text.length > 60 ? '…' : '') + '</div>';
        html += '<div class="review-ans">正解：' + q.choices[q.answer] + '</div>';
        html += '</div>';
      });
      section.innerHTML = html;
    } else {
      section.innerHTML = '<div class="review-title">全問正解！</div>';
    }

    show('result-screen');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Event listeners ----------
  document.querySelectorAll('.cat-card').forEach(btn => {
    btn.addEventListener('click', () => startQuiz(btn.dataset.category));
  });

  $('quit-btn').addEventListener('click', () => renderHome());
  $('next-btn').addEventListener('click', nextQuestion);
  $('retry-btn').addEventListener('click', () => startQuiz(state.category));
  $('home-btn').addEventListener('click', () => renderHome());

  // ---------- Init ----------
  renderHome();

})();
