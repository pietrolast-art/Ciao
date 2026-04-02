/* ═══════════════════════════════════════════════════
   AniGuessr clone — game.js
   Data source: AniList GraphQL API (free, no auth)
═══════════════════════════════════════════════════ */

const ANILIST = 'https://graphql.anilist.co';

/* ── Scoring ──────────────────────────────────── */
const MAX_SCORE_PER_ROUND = 20000;
const CLUE_PENALTY        = [0, 5000, 8000, 12000]; // penalty for unlocking clue 1/2/3
const WRONG_PENALTY       = 2000;
const TOTAL_ROUNDS        = 5;

/* ── State ───────────────────────────────────── */
let pool         = [];       // anime with bannerImage
let roundOrder   = [];       // shuffled pool indices
let currentRound = 0;
let totalScore   = 0;
let roundResults = [];

let currentAnime  = null;
let roundScore    = 0;       // this round's current max
let cluesUnlocked = 0;       // 0-3
let guessCount    = 0;
let roundDone     = false;

let suggTimer     = null;
let selectedSugg  = -1;

/* ── DOM ─────────────────────────────────────── */
const $ = id => document.getElementById(id);

const screens = {
  home:       $('screen-home'),
  screenshot: $('screen-screenshot'),
  result:     $('screen-result'),
  gameover:   $('screen-gameover'),
  soon:       $('screen-soon'),
};

/* ── Show screen ─────────────────────────────── */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
}

/* ── AniList queries ─────────────────────────── */
async function anilistQuery(query, variables = {}) {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  return res.json();
}

const POOL_QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false,
          status_in: [FINISHED, RELEASING], format_in: [TV, MOVIE, OVA]) {
      id
      title { romaji english }
      bannerImage
      coverImage { large }
      genres
      seasonYear
      episodes
      averageScore
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

const SEARCH_QUERY = `
query ($search: String) {
  Page(perPage: 10) {
    media(type: ANIME, search: $search, isAdult: false) {
      id
      title { romaji english }
      bannerImage
      coverImage { large medium }
      seasonYear
    }
  }
}`;

/* ── Fetch pool ──────────────────────────────── */
async function fetchPool() {
  const results = [];
  // Fetch 4 pages of top anime
  for (let page = 1; page <= 4; page++) {
    try {
      const data = await anilistQuery(POOL_QUERY, { page });
      for (const m of data.data.Page.media) {
        if (m.bannerImage) results.push(normalise(m));
      }
      await sleep(250);
    } catch (e) {
      console.warn('Pool page', page, e);
    }
  }
  return results;
}

function normalise(m) {
  return {
    id:       m.id,
    title:    m.title.english || m.title.romaji,
    romaji:   m.title.romaji,
    banner:   m.bannerImage,
    cover:    m.coverImage?.large || m.coverImage?.medium || '',
    genres:   m.genres || [],
    year:     m.seasonYear,
    episodes: m.episodes,
    score:    m.averageScore,
    studio:   m.studios?.nodes?.[0]?.name || null,
  };
}

/* ── Search for autocomplete ─────────────────── */
async function searchAnime(q) {
  if (!q || q.length < 2) return [];
  try {
    const data = await anilistQuery(SEARCH_QUERY, { search: q });
    return (data.data?.Page?.media || []).map(normalise);
  } catch { return []; }
}

/* ── Helpers ─────────────────────────────────── */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isMatch(input, anime) {
  const norm = s => s.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
  const g = norm(input);
  return norm(anime.title) === g || norm(anime.romaji) === g;
}

function titleMask(title) {
  // Reveal first letter of each word, mask rest
  return title.split(' ').map(w => {
    if (!w) return '';
    return w[0] + '_ '.repeat(w.length - 1).trimEnd();
  }).join('  ');
}

/* ── Clue content ────────────────────────────── */
function getClueHtml(clueIndex, anime) {
  if (clueIndex === 1) {
    const parts = [];
    if (anime.year)     parts.push(`<strong>Year:</strong> ${anime.year}`);
    if (anime.episodes) parts.push(`<strong>Episodes:</strong> ${anime.episodes}`);
    if (anime.genres.length) parts.push(`<strong>Genres:</strong> ${escHtml(anime.genres.slice(0,3).join(', '))}`);
    return parts.join('&emsp;|&emsp;') || 'No data available.';
  }
  if (clueIndex === 2) {
    const parts = [];
    if (anime.score)  parts.push(`<strong>Score:</strong> ${anime.score / 10}/10`);
    if (anime.studio) parts.push(`<strong>Studio:</strong> ${escHtml(anime.studio)}`);
    return parts.join('&emsp;|&emsp;') || 'No data available.';
  }
  if (clueIndex === 3) {
    return `<strong>Title hint:</strong> <span style="font-family:monospace;letter-spacing:2px">${escHtml(titleMask(anime.title))}</span>`;
  }
  return '';
}

/* ══════════════════════════════════════════════
   GAME FLOW
══════════════════════════════════════════════ */

async function startGame() {
  // Show loading state in home
  document.querySelectorAll('.mode-card').forEach(c => c.style.opacity = '0.5');

  if (pool.length < TOTAL_ROUNDS) {
    pool = await fetchPool();
  }

  document.querySelectorAll('.mode-card').forEach(c => c.style.opacity = '');

  if (pool.length < TOTAL_ROUNDS) {
    alert('Failed to load anime. Please check your connection and try again.');
    return;
  }

  roundOrder   = shuffle([...Array(pool.length).keys()]).slice(0, TOTAL_ROUNDS);
  currentRound = 0;
  totalScore   = 0;
  roundResults = [];

  $('sidebar-score').textContent = '0';
  startRound();
}

function startRound() {
  currentAnime  = pool[roundOrder[currentRound]];
  roundScore    = MAX_SCORE_PER_ROUND;
  cluesUnlocked = 0;
  guessCount    = 0;
  roundDone     = false;

  // Header
  $('round-num').textContent = currentRound + 1;

  // Difficulty badge
  const badge = $('difficulty-badge');
  if (currentRound < 2)      { badge.textContent = 'Easy';   badge.className = 'badge badge-easy'; }
  else if (currentRound < 4) { badge.textContent = 'Medium'; badge.className = 'badge badge-medium'; }
  else                       { badge.textContent = 'Hard';   badge.className = 'badge badge-hard'; }

  // Image
  const imgEl    = $('screenshot-img');
  const loadEl   = $('screenshot-loading');
  const overlayEl= $('clue-overlay');

  imgEl.classList.add('hidden');
  loadEl.style.display = 'flex';
  overlayEl.classList.add('hidden');

  imgEl.onload = () => {
    loadEl.style.display = 'none';
    imgEl.classList.remove('hidden');
  };
  imgEl.onerror = () => {
    loadEl.textContent = '⚠ Image failed to load';
  };
  imgEl.src = currentAnime.banner;

  // Reset clue tabs
  const tabs = document.querySelectorAll('.clue-tab');
  tabs.forEach((t, i) => {
    t.classList.remove('active', 'unlocked');
    if (i === 0) t.classList.add('active');
    else         t.classList.add('locked');
    // Re-add lock icons that may have been removed
    if (i > 0 && !t.querySelector('.lock-icon')) {
      t.insertAdjacentHTML('afterbegin', '<svg class="lock-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>');
    }
  });

  // Reset clue info
  const clueInfo = $('clue-info');
  clueInfo.classList.add('hidden');
  clueInfo.innerHTML = '';

  // Reset feedback & history
  hideFeedback();
  $('guess-history').innerHTML = '';

  // Input
  $('guess-input').value   = '';
  $('guess-input').disabled = false;
  $('guess-btn').disabled   = false;
  $('give-up-btn').disabled = false;
  hideSuggestions();
  $('guess-input').focus();

  showScreen('screenshot');
}

/* ── Clue tab clicks ─────────────────────────── */
document.querySelectorAll('.clue-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const idx = parseInt(tab.dataset.clue);
    if (roundDone) return;

    if (idx === 0) {
      // show original screenshot, hide overlay
      document.querySelectorAll('.clue-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('clue-overlay').classList.add('hidden');
      $('clue-info').classList.add('hidden');
      return;
    }

    // Unlock clue
    if (idx > cluesUnlocked) {
      // Unlock all previous clues too
      for (let i = cluesUnlocked + 1; i <= idx; i++) {
        roundScore = Math.max(0, roundScore - CLUE_PENALTY[i]);
        cluesUnlocked = i;
        const btn = document.querySelector(`.clue-tab[data-clue="${i}"]`);
        if (btn) {
          btn.classList.remove('locked');
          btn.classList.add('unlocked');
          const lock = btn.querySelector('.lock-icon');
          if (lock) lock.remove();
        }
      }
    }

    // Show this clue
    document.querySelectorAll('.clue-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const clueInfo = $('clue-info');
    clueInfo.innerHTML = getClueHtml(idx, currentAnime);
    clueInfo.classList.remove('hidden');

    $('clue-overlay').classList.add('hidden');
  });
});

/* ── Guess submission ────────────────────────── */
function submitGuess(title) {
  if (roundDone || !title.trim()) return;

  const correct = isMatch(title, currentAnime);
  guessCount++;
  hideSuggestions();
  $('guess-input').value = '';

  if (correct) {
    addHistory(title, true);
    endRound(true);
  } else {
    roundScore = Math.max(0, roundScore - WRONG_PENALTY);
    addHistory(title, false);
    showFeedback('✗  Wrong answer', 'wrong');
  }
}

function addHistory(title, correct) {
  const div = document.createElement('div');
  div.className = `history-item ${correct ? 'correct' : 'wrong'}`;
  div.innerHTML = `<span class="history-icon">${correct ? '✓' : '✗'}</span><span>${escHtml(title)}</span>`;
  $('guess-history').appendChild(div);
}

function showFeedback(msg, type) {
  const el = $('guess-feedback');
  el.textContent = msg;
  el.className   = `guess-feedback ${type}`;
  el.classList.remove('hidden');
  clearTimeout(showFeedback._t);
  showFeedback._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function hideFeedback() {
  $('guess-feedback').classList.add('hidden');
}

/* ── End round ───────────────────────────────── */
function endRound(won) {
  roundDone = true;
  $('guess-input').disabled = true;
  $('guess-btn').disabled   = true;
  $('give-up-btn').disabled = true;

  const pts = won ? roundScore : 0;
  totalScore += pts;
  roundResults.push({ title: currentAnime.title, pts, won });

  $('sidebar-score').textContent = totalScore.toLocaleString();

  // Result screen
  $('result-status-icon').textContent = won ? '🎉' : '😔';
  $('result-heading').textContent     = won ? 'Correct!' : 'Out of guesses!';
  $('result-subtitle').textContent    = won
    ? `You got it in ${guessCount} guess${guessCount !== 1 ? 'es' : ''}!`
    : 'Better luck next round.';

  $('result-img').src           = currentAnime.banner || currentAnime.cover;
  $('result-title-badge').textContent = currentAnime.title;

  $('result-score-delta').textContent = won
    ? `+${pts.toLocaleString()} points`
    : '+0 points';
  $('result-score-delta').style.color = won ? 'var(--pink)' : 'var(--text-muted)';

  const isLast = (currentRound + 1 >= TOTAL_ROUNDS);
  $('result-next-btn').textContent = isLast ? 'See Results' : 'Next Round →';

  showScreen('result');
}

/* ── Give up ─────────────────────────────────── */
$('give-up-btn').addEventListener('click', () => {
  if (roundDone) return;
  endRound(false);
});

/* ── Next round ──────────────────────────────── */
$('result-next-btn').addEventListener('click', () => {
  currentRound++;
  if (currentRound >= TOTAL_ROUNDS) {
    showGameOver();
  } else {
    startRound();
  }
});

/* ── Game over ───────────────────────────────── */
function showGameOver() {
  $('gameover-score').textContent = totalScore.toLocaleString();

  const max = TOTAL_ROUNDS * MAX_SCORE_PER_ROUND;
  $('gameover-grade').textContent = gradeText(totalScore / max);

  $('gameover-summary').innerHTML = roundResults.map((r, i) => `
    <div class="summary-row">
      <span class="summary-name">${i + 1}. ${escHtml(r.title)}</span>
      <span class="summary-pts ${r.pts > 0 ? 'pos' : 'zero'}">
        ${r.pts > 0 ? '+' + r.pts.toLocaleString() : '0'}
      </span>
    </div>
  `).join('');

  showScreen('gameover');
}

function gradeText(pct) {
  if (pct >= 0.9) return '🏆 Anime Master!';
  if (pct >= 0.7) return '⭐ Anime Expert';
  if (pct >= 0.5) return '👍 Decent Otaku';
  if (pct >= 0.3) return '📺 Keep Watching!';
  return '🌱 Just Getting Started';
}

/* ── Play again ──────────────────────────────── */
$('play-again-btn').addEventListener('click', () => {
  roundOrder   = shuffle([...Array(pool.length).keys()]).slice(0, TOTAL_ROUNDS);
  currentRound = 0;
  totalScore   = 0;
  roundResults = [];
  $('sidebar-score').textContent = '0';
  startRound();
});

/* ══════════════════════════════════════════════
   AUTOCOMPLETE
══════════════════════════════════════════════ */

const guessInput   = $('guess-input');
const suggestionsEl = $('suggestions');

guessInput.addEventListener('input', () => {
  clearTimeout(suggTimer);
  const q = guessInput.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }
  suggTimer = setTimeout(async () => {
    const items = await searchAnime(q);
    renderSuggestions(items);
  }, 320);
});

guessInput.addEventListener('keydown', e => {
  const items = suggestionsEl.querySelectorAll('.sugg-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedSugg = Math.min(selectedSugg + 1, items.length - 1);
    highlightSugg(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedSugg = Math.max(selectedSugg - 1, -1);
    highlightSugg(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedSugg >= 0 && items[selectedSugg]) {
      guessInput.value = items[selectedSugg].dataset.title;
      hideSuggestions();
    }
    submitGuess(guessInput.value);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

guessInput.addEventListener('blur', () => setTimeout(hideSuggestions, 160));

$('guess-btn').addEventListener('click', () => submitGuess(guessInput.value));

function renderSuggestions(items) {
  if (!items.length) { hideSuggestions(); return; }
  selectedSugg = -1;
  suggestionsEl.innerHTML = '';
  items.forEach(a => {
    const title = a.title || a.romaji;
    const div   = document.createElement('div');
    div.className   = 'sugg-item';
    div.dataset.title = title;
    div.innerHTML = `
      <img class="sugg-thumb" src="${a.banner || a.cover || ''}" alt=""
           onerror="this.style.display='none'" loading="lazy" />
      <div class="sugg-text">
        <div class="sugg-title">${escHtml(title)}</div>
        ${a.year ? `<div class="sugg-year">${a.year}</div>` : ''}
      </div>`;
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      guessInput.value = title;
      hideSuggestions();
      submitGuess(title);
    });
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.classList.remove('hidden');
}

function highlightSugg(items) {
  items.forEach((el, i) => el.classList.toggle('selected', i === selectedSugg));
  if (selectedSugg >= 0 && items[selectedSugg]) {
    guessInput.value = items[selectedSugg].dataset.title;
  }
}

function hideSuggestions() {
  suggestionsEl.classList.add('hidden');
  suggestionsEl.innerHTML = '';
  selectedSugg = -1;
}

/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */

// Logo → home
document.querySelectorAll('#logo-link, .logo').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    showScreen('home');
    setActiveNav(null);
  });
});

// Nav items
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    const mode = item.dataset.mode;
    setActiveNav(mode);

    if (mode === 'screenshot') {
      startGame();
    } else {
      showScreen('soon');
    }
  });
});

// Home mode cards
document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    const target = card.dataset.target;
    setActiveNav(target);

    if (target === 'screenshot') {
      startGame();
    } else {
      showScreen('soon');
    }
  });
});

// Back from soon
$('soon-back-btn').addEventListener('click', () => {
  showScreen('home');
  setActiveNav(null);
});

function setActiveNav(mode) {
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.mode === mode);
  });
}
