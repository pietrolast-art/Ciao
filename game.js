/* ═══════════════════════════════════════════════
   AniGuessr — game.js
   Uses the free Jikan v4 API (MyAnimeList data)
═══════════════════════════════════════════════ */

const JIKAN = 'https://api.jikan.moe/v4';
const TOTAL_ROUNDS   = 5;
const MAX_GUESSES    = 5;
// Points for solving on guess 1→5
const POINTS_TABLE   = [5, 4, 3, 2, 1];

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
let animePool    = [];   // array of anime objects from Jikan
let roundOrder   = [];   // shuffled indices into animePool
let currentRound = 0;
let totalScore   = 0;
let roundResults = [];   // { title, pts, status: 'correct'|'skipped'|'wrong' }

let guessCount   = 0;
let roundActive  = false;

let suggTimeout  = null;
let selectedSuggIdx = -1;

// ──────────────────────────────────────────────
// DOM refs
// ──────────────────────────────────────────────
const $ = id => document.getElementById(id);

const splashScreen   = $('splash');
const gameScreen     = $('game');
const endScreen      = $('end');
const startBtn       = $('start-btn');
const loadingMsg     = $('loading-msg');

const roundNumEl     = $('round-num');
const scoreEl        = $('score');
const imageContainer = document.querySelector('.image-container');
const animeImg       = $('anime-image');
const attemptDots    = $('attempt-dots');
const guessList      = $('guesses-list');
const guessInput     = $('guess-input');
const suggestionsEl  = $('suggestions');
const guessBtn       = $('guess-btn');
const skipBtn        = $('skip-btn');

const roundResultEl  = $('round-result');
const resultIcon     = $('result-icon');
const resultTitle    = $('result-title');
const resultAnswer   = $('result-answer');
const resultPoints   = $('result-points');
const resultImg      = $('result-image');
const nextBtn        = $('next-btn');
const nextBtnLabel   = $('next-btn-label');

const finalScoreEl   = $('final-score');
const endGradeEl     = $('end-grade');
const roundSummaryEl = $('round-summary');
const playAgainBtn   = $('play-again-btn');

// ──────────────────────────────────────────────
// Screen helpers
// ──────────────────────────────────────────────
function showScreen(el) {
  [splashScreen, gameScreen, endScreen].forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

// ──────────────────────────────────────────────
// Jikan API helpers
// ──────────────────────────────────────────────
async function jikanGet(path) {
  const res = await fetch(JIKAN + path);
  if (!res.ok) throw new Error(`Jikan ${res.status}: ${path}`);
  return res.json();
}

/** Fetch ~100 top anime across multiple pages and pick ones with images */
async function fetchAnimePool() {
  const pages = [1, 2, 3, 4, 5]; // 5 pages × 25 = 125 entries
  const results = [];

  for (const page of pages) {
    try {
      const data = await jikanGet(`/top/anime?page=${page}&limit=25&filter=bypopularity`);
      for (const a of data.data) {
        const img = a.images?.jpg?.large_image_url || a.images?.jpg?.image_url;
        if (!img) continue;
        results.push({
          mal_id: a.mal_id,
          title:  a.title,
          titleEn: a.title_english || a.title,
          image:  img,
          year:   a.year || (a.aired?.from ? new Date(a.aired.from).getFullYear() : null),
        });
      }
      // Small delay to respect Jikan rate limit (3 req/s)
      await sleep(350);
    } catch (e) {
      console.warn('Pool fetch error page', page, e);
    }
  }
  return results;
}

/** Search anime by query for autocomplete */
async function searchAnime(query) {
  if (!query || query.length < 2) return [];
  try {
    const data = await jikanGet(`/anime?q=${encodeURIComponent(query)}&limit=8&sfw=true`);
    return (data.data || []).map(a => ({
      mal_id: a.mal_id,
      title:  a.title,
      titleEn: a.title_english || a.title,
      image:  a.images?.jpg?.image_url || '',
      year:   a.year || (a.aired?.from ? new Date(a.aired.from).getFullYear() : null),
    }));
  } catch (e) {
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────
// Game flow
// ──────────────────────────────────────────────
async function initGame() {
  startBtn.disabled = true;
  loadingMsg.classList.remove('hidden');

  try {
    animePool = await fetchAnimePool();
  } catch (e) {
    loadingMsg.textContent = 'Failed to load anime. Check your connection.';
    startBtn.disabled = false;
    return;
  }

  if (animePool.length < TOTAL_ROUNDS) {
    loadingMsg.textContent = 'Not enough anime loaded. Please refresh.';
    startBtn.disabled = false;
    return;
  }

  // Shuffle pool and pick TOTAL_ROUNDS entries
  roundOrder = shuffle([...Array(animePool.length).keys()]).slice(0, TOTAL_ROUNDS);

  currentRound = 0;
  totalScore   = 0;
  roundResults = [];

  showScreen(gameScreen);
  startRound();
}

function startRound() {
  guessCount  = 0;
  roundActive = true;

  const anime = currentAnime();

  // Header
  roundNumEl.textContent = currentRound + 1;
  scoreEl.textContent    = totalScore;

  // Image
  animeImg.src = anime.image;
  animeImg.alt = 'Guess this anime';
  imageContainer.dataset.blur = String(MAX_GUESSES);

  // Dots
  renderDots();

  // Clear previous guesses
  guessList.innerHTML = '';

  // Input
  guessInput.value = '';
  guessInput.disabled  = false;
  guessBtn.disabled    = false;
  skipBtn.disabled     = false;
  hideSuggestions();
  guessInput.focus();
}

function currentAnime() {
  return animePool[roundOrder[currentRound]];
}

// ──────────────────────────────────────────────
// Guessing logic
// ──────────────────────────────────────────────
function submitGuess(title) {
  if (!roundActive || !title.trim()) return;

  const anime    = currentAnime();
  const correct  = isCorrect(title, anime);

  guessCount++;
  renderDots();
  addGuessItem(title, correct);
  guessInput.value = '';
  hideSuggestions();

  if (correct) {
    const pts = POINTS_TABLE[guessCount - 1];
    totalScore += pts;
    endRound('correct', pts);
    return;
  }

  // Reduce blur
  const remaining = MAX_GUESSES - guessCount;
  imageContainer.dataset.blur = String(remaining);

  if (guessCount >= MAX_GUESSES) {
    endRound('wrong', 0);
  }
}

/** Flexible correctness: match on original or English title (case-insensitive, trim) */
function isCorrect(input, anime) {
  const norm  = s => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const guess = norm(input);
  return norm(anime.title) === guess || norm(anime.titleEn) === guess;
}

function endRound(status, pts) {
  roundActive = false;
  guessInput.disabled = true;
  guessBtn.disabled   = true;
  skipBtn.disabled    = true;

  const anime = currentAnime();
  roundResults.push({ title: anime.titleEn || anime.title, pts, status });

  // Show unblurred image briefly
  imageContainer.dataset.blur = '0';

  // Populate overlay
  if (status === 'correct') {
    resultIcon.textContent  = '🎉';
    resultTitle.textContent = 'Correct!';
    resultPoints.textContent = `+${pts} point${pts !== 1 ? 's' : ''}`;
    resultPoints.style.color = 'var(--yellow)';
  } else if (status === 'skipped') {
    resultIcon.textContent  = '⏭️';
    resultTitle.textContent = 'Skipped';
    resultPoints.textContent = '+0 points';
    resultPoints.style.color = 'var(--muted)';
  } else {
    resultIcon.textContent  = '😔';
    resultTitle.textContent = 'Out of guesses!';
    resultPoints.textContent = '+0 points';
    resultPoints.style.color = 'var(--red)';
  }

  resultAnswer.innerHTML = `The answer was <strong>${anime.titleEn || anime.title}</strong>`;
  resultImg.src = anime.image;

  const isLast = (currentRound + 1 >= TOTAL_ROUNDS);
  nextBtnLabel.textContent = isLast ? 'See Results' : 'Next Round';

  scoreEl.textContent = totalScore;

  roundResultEl.classList.remove('hidden');
}

function skipRound() {
  if (!roundActive) return;
  endRound('skipped', 0);
}

function nextRound() {
  roundResultEl.classList.add('hidden');
  currentRound++;

  if (currentRound >= TOTAL_ROUNDS) {
    showEndScreen();
  } else {
    startRound();
  }
}

// ──────────────────────────────────────────────
// End screen
// ──────────────────────────────────────────────
function showEndScreen() {
  showScreen(endScreen);
  finalScoreEl.textContent = totalScore;

  const maxPts = TOTAL_ROUNDS * POINTS_TABLE[0];
  $('final-max').textContent = `/ ${maxPts}`;

  const pct = totalScore / maxPts;
  let grade;
  if (pct >= 0.9)      grade = '🏆 Anime Master!';
  else if (pct >= 0.7) grade = '⭐ Anime Expert';
  else if (pct >= 0.5) grade = '👍 Decent Otaku';
  else if (pct >= 0.3) grade = '📺 Keep Watching!';
  else                  grade = '🌱 Just Getting Started';

  endGradeEl.textContent = grade;

  roundSummaryEl.innerHTML = roundResults.map((r, i) => `
    <div class="summary-row">
      <span class="summary-title">${i + 1}. ${escHtml(r.title)}</span>
      <span class="summary-result ${r.status}">
        ${r.status === 'correct' ? `+${r.pts} pts` : r.status === 'skipped' ? 'skipped' : 'missed'}
      </span>
    </div>
  `).join('');
}

function resetGame() {
  showScreen(splashScreen);
  startBtn.disabled = false;
  loadingMsg.classList.add('hidden');
  loadingMsg.textContent = 'Loading anime data…';
  animePool = [];
  roundOrder = [];
}

// ──────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────
function renderDots() {
  attemptDots.innerHTML = '';
  for (let i = 0; i < MAX_GUESSES; i++) {
    const dot = document.createElement('div');
    dot.className = 'dot';
    if (i < guessCount) dot.classList.add('wrong');
    attemptDots.appendChild(dot);
  }
}

function addGuessItem(title, correct) {
  const item = document.createElement('div');
  item.className = `guess-item ${correct ? 'correct' : 'wrong'}`;
  item.innerHTML = `
    <span class="guess-icon">${correct ? '✓' : '✗'}</span>
    <span>${escHtml(title)}</span>
  `;
  guessList.appendChild(item);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ──────────────────────────────────────────────
// Autocomplete / suggestions
// ──────────────────────────────────────────────
function hideSuggestions() {
  suggestionsEl.classList.add('hidden');
  suggestionsEl.innerHTML = '';
  selectedSuggIdx = -1;
}

function renderSuggestions(items) {
  if (!items.length) { hideSuggestions(); return; }

  suggestionsEl.innerHTML = '';
  selectedSuggIdx = -1;

  items.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.dataset.index = i;
    div.innerHTML = `
      <img class="suggestion-img" src="${a.image || ''}" alt="" loading="lazy"
           onerror="this.style.display='none'" />
      <span class="suggestion-title">
        ${escHtml(a.titleEn || a.title)}
        ${a.year ? `<br><span class="suggestion-year">${a.year}</span>` : ''}
      </span>
    `;
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      guessInput.value = a.titleEn || a.title;
      hideSuggestions();
      submitGuess(guessInput.value);
    });
    suggestionsEl.appendChild(div);
  });

  suggestionsEl.classList.remove('hidden');
}

guessInput.addEventListener('input', () => {
  clearTimeout(suggTimeout);
  const q = guessInput.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }

  suggTimeout = setTimeout(async () => {
    const results = await searchAnime(q);
    renderSuggestions(results);
  }, 350);
});

guessInput.addEventListener('keydown', e => {
  const items = suggestionsEl.querySelectorAll('.suggestion-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedSuggIdx = Math.min(selectedSuggIdx + 1, items.length - 1);
    highlightSugg(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedSuggIdx = Math.max(selectedSuggIdx - 1, -1);
    highlightSugg(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedSuggIdx >= 0 && items[selectedSuggIdx]) {
      guessInput.value = items[selectedSuggIdx].querySelector('.suggestion-title').textContent
        .split('\n')[0].trim();
      hideSuggestions();
    }
    submitGuess(guessInput.value);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

guessInput.addEventListener('blur', () => {
  // Delay so mousedown on suggestion fires first
  setTimeout(hideSuggestions, 150);
});

function highlightSugg(items) {
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedSuggIdx);
  });
  if (selectedSuggIdx >= 0 && items[selectedSuggIdx]) {
    const title = items[selectedSuggIdx].querySelector('.suggestion-title');
    guessInput.value = title.textContent.split('\n')[0].trim();
  }
}

// ──────────────────────────────────────────────
// Event listeners
// ──────────────────────────────────────────────
startBtn.addEventListener('click', initGame);

guessBtn.addEventListener('click', () => submitGuess(guessInput.value));

skipBtn.addEventListener('click', skipRound);

nextBtn.addEventListener('click', nextRound);

playAgainBtn.addEventListener('click', () => {
  // Re-use already loaded pool, just re-shuffle
  if (animePool.length >= TOTAL_ROUNDS) {
    roundOrder   = shuffle([...Array(animePool.length).keys()]).slice(0, TOTAL_ROUNDS);
    currentRound = 0;
    totalScore   = 0;
    roundResults = [];
    showScreen(gameScreen);
    startRound();
  } else {
    resetGame();
  }
});

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
