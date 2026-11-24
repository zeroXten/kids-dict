// Word Finder: a talking picture dictionary for children.
// Static, no build step: works on GitHub Pages and offline as a PWA.

const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
  noun: ["noun", "a naming word"],
  verb: ["verb", "a doing word"],
  adjective: ["adjective", "a describing word"],
  adverb: ["adverb", "a word that tells you how, when or how often"],
  preposition: ["preposition", "a word that tells you where or when"],
  conjunction: ["conjunction", "a joining word"],
  pronoun: ["pronoun", "a word used instead of a name"],
  determiner: ["determiner", "a word that tells you which or how many"],
  number: ["number", "a counting word"],
  interjection: ["exclamation", "a word you say on its own"],
};

// Speaking letter names on their own is unreliable ("a" is often read as "uh"),
// so each letter has a spoken form. UK names ("zed", "aitch").
const LETTER_NAMES = {
  a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "jee", h: "aitch",
  i: "eye", j: "jay", k: "kay", l: "ell", m: "em", n: "en", o: "oh", p: "pee",
  q: "cue", r: "ar", s: "ess", t: "tee", u: "you", v: "vee", w: "double you",
  x: "ex", y: "why", z: "zed",
};

let WORDS = [];
let CREDITS = {};
const lookup = new Map(); // word or word form -> entry

// ---------------------------------------------------------------- data

async function loadData() {
  const [words, credits] = await Promise.all([
    fetch("data/words.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/credits.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  WORDS = words.sort((a, b) => a.word.localeCompare(b.word));
  CREDITS = credits;
  for (const entry of WORDS) {
    // Keys are lower case, so "monday" finds "Monday". Headwords beat other words' forms.
    lookup.set(entry.word.toLowerCase(), entry);
    // Speech recognition writes "grown-up" as "grown up".
    if (entry.word.includes("-")) lookup.set(entry.word.toLowerCase().replace(/-/g, " "), entry);
  }
  for (const entry of WORDS) {
    for (const f of entry.forms || []) if (!lookup.has(f.toLowerCase())) lookup.set(f.toLowerCase(), entry);
  }
}

// ---------------------------------------------------------------- matching

const normalise = (s) =>
  s.toLowerCase().replace(/[^a-z'\- ]+/g, " ").replace(/(^|\s)-+|-+(\s|$)/g, " ").replace(/\s+/g, " ").trim();

// Words children wrap around the one they want: "what does frozen mean", "how do you
// spell cat". Inside a longer phrase these are skipped; SOFT ones are dictionary words
// too, so they're tried if nothing else in the phrase matches ("what does up mean").
const FRAME = new Set("what what's whats does do is a an the mean means meaning how you of me it's its i".split(" "));
const SOFT = new Set("spell say word tell about please can find look up".split(" "));

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Find a dictionary word in what the child said or typed.
 * `phrases` are alternative transcripts, best first. Handles
 * "frozen", "what does frozen mean", "frozen." and close misspellings.
 */
function findWord(phrases) {
  const cleaned = phrases.map(normalise).filter(Boolean);
  // 1. Whole phrase is a word or form.
  for (const p of cleaned) if (lookup.has(p)) return { entry: lookup.get(p) };
  // 2. A two-word entry inside the phrase ("what is ice cream"), then any single
  //    word, scanning from the end and skipping question words ("what does frozen mean").
  for (const p of cleaned) {
    const tokens = p.split(" ");
    for (let i = tokens.length - 2; i >= 0; i--) {
      const pair = `${tokens[i]} ${tokens[i + 1]}`;
      if (lookup.has(pair)) return { entry: lookup.get(pair) };
    }
    for (const skip of [(t) => FRAME.has(t) || SOFT.has(t), (t) => FRAME.has(t)]) {
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (!skip(tokens[i]) && lookup.has(tokens[i])) return { entry: lookup.get(tokens[i]) };
      }
    }
  }
  // 3. Close matches, for suggestions.
  const target = cleaned[0] || "";
  const tokens = target.split(" ").filter((t) => t.length > 1 && !FRAME.has(t) && !SOFT.has(t));
  const scored = new Map();
  for (const [key, entry] of lookup) {
    for (const t of tokens.length ? tokens : [target]) {
      const d = levenshtein(t, key) / Math.max(t.length, key.length);
      const best = scored.get(entry);
      if (best === undefined || d < best) scored.set(entry, d);
    }
  }
  const ranked = [...scored].filter(([, d]) => d <= 0.4).sort((a, b) => a[1] - b[1]);
  // Only offer guesses about as close as the best one.
  const suggestions = ranked
    .filter(([, d]) => d <= ranked[0][1] + 0.12)
    .slice(0, 3)
    .map(([e]) => e);
  return { suggestions, heard: target };
}

// ---------------------------------------------------------------- speech out

// Voice choice. Devices report languages inconsistently ("en-GB", "en_GB", "en-gb"),
// so compare them normalised. A grown-up can override the choice in Settings.
const VOICE_KEY = "word-finder-voice";
const normLang = (lang = "") => lang.replace("_", "-").toLowerCase();
// Apple's novelty voices (Bubbles, Grandpa…) are fun but hard to understand.
const NOVELTY = /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Eddy|Flo|Good News|Grandma|Grandpa|Jester|Junior|Organ|Ralph|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Kathy/i;
// British voices in order of preference (clear, friendly ones first).
const PREFERRED_GB = ["Google UK English Female", "Sonia", "Libby", "Serena", "Kate", "Martha", "Stephanie", "Google UK", "Daniel", "Arthur"];

let voices = [];
let voice = null; // null = let the browser choose its own British English voice

function englishVoices() {
  return voices.filter((v) => normLang(v.lang).startsWith("en") && !NOVELTY.test(v.name));
}

function defaultVoice() {
  const gb = englishVoices().filter((v) => normLang(v.lang) === "en-gb");
  const score = (v) => {
    const i = PREFERRED_GB.findIndex((n) => v.name.includes(n));
    return (i === -1 ? 100 : i) - (/Premium|Enhanced|Natural/i.test(v.name) ? 0.5 : 0);
  };
  return gb.sort((x, y) => score(x) - score(y))[0] || null;
}

function pickVoice() {
  voices = speechSynthesis.getVoices();
  const saved = localStorage.getItem(VOICE_KEY);
  voice = (saved && voices.find((v) => v.voiceURI === saved)) || defaultVoice();
  if (!$("settings").hidden) renderSettings();
}
if ("speechSynthesis" in window) {
  pickVoice();
  // Chrome loads voices late; Safari may never fire this, so speak() also retries.
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

let speechRun = 0; // bumped to cancel any sequence in progress

function stopSpeaking() {
  speechRun++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  document.querySelectorAll(".act.playing").forEach((b) => b.classList.remove("playing"));
  clearLetterHighlight();
}

function speak(text, { rate = 0.85, pitch = 1.05 } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    if (!voices.length) pickVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang.replace("_", "-") : "en-GB";
    u.rate = rate;
    u.pitch = pitch;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a spoken sequence; returns false if another action cancelled it. */
async function sequence(button, steps) {
  stopSpeaking();
  const run = speechRun;
  button?.classList.add("playing");
  for (const step of steps) {
    if (run !== speechRun) return false;
    await step();
  }
  if (run === speechRun) button?.classList.remove("playing");
  return run === speechRun;
}

// ---------------------------------------------------------------- speech in

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recogniser = null;
let listening = false;

function setPrompt(text) { $("prompt").textContent = text; }

function startListening() {
  if (!Recognition) {
    setPrompt("Talking isn't available here. Spell it with the letters below.");
    return;
  }
  if (listening) { recogniser.stop(); return; }
  stopSpeaking();

  recogniser = new Recognition();
  recogniser.lang = "en-GB";
  recogniser.interimResults = true;
  recogniser.maxAlternatives = 5;
  recogniser.continuous = false;

  let finalAlternatives = null;

  recogniser.onstart = () => {
    listening = true;
    $("micBtn").classList.add("listening");
    setPrompt("I'm listening…");
    $("heard").textContent = "";
    $("suggestions").innerHTML = "";
  };
  recogniser.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    $("heard").textContent = result[0].transcript;
    if (result.isFinal) finalAlternatives = Array.from(result, (alt) => alt.transcript);
  };
  recogniser.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setPrompt("Ask a grown-up to let me use the microphone.");
    } else if (e.error === "no-speech") {
      setPrompt("I didn't hear anything. Tap and try again!");
    } else if (e.error === "network") {
      setPrompt("I need the internet to listen. Spell it with the letters below.");
    }
  };
  recogniser.onend = () => {
    listening = false;
    $("micBtn").classList.remove("listening");
    if (finalAlternatives) handleSearch(finalAlternatives, true);
    else if ($("prompt").textContent === "I'm listening…") setPrompt("Tap and say a word");
  };
  recogniser.start();
}

function handleSearch(phrases, spoken) {
  const { entry, suggestions, heard } = findWord(phrases);
  if (entry) {
    location.hash = `#/word/${encodeURIComponent(entry.word)}`;
    return;
  }
  const box = $("suggestions");
  box.innerHTML = "";
  setPrompt("Tap and say a word");
  const msg = document.createElement("p");
  if (suggestions.length) {
    msg.textContent = `I don't know "${heard}" yet. Did you mean…`;
    box.append(msg, ...suggestions.map(wordChip));
    if (spoken) speak(`I don't know that word yet. Did you mean ${suggestions.map((s) => s.word).join(", or ")}?`);
  } else {
    msg.textContent = heard ? `I don't know "${heard}" yet. Try another word!` : "Try another word!";
    box.append(msg);
    if (spoken) speak("I don't know that word yet. Try another one!");
  }
}

// ---------------------------------------------------------------- views

function wordChip(entry) {
  const a = document.createElement("a");
  a.className = "chip";
  a.href = `#/word/${encodeURIComponent(entry.word)}`;
  a.innerHTML = `<span aria-hidden="true"></span>`;
  a.firstChild.textContent = entry.emoji || "";
  a.append(entry.word);
  return a;
}

// Letters tapped so far: the word list shows only words starting with them.
let prefix = "";

function renderHome() {
  const alphabet = $("alphabet");
  if (!alphabet.childElementCount) {
    for (const ch of "abcdefghijklmnopqrstuvwxyz") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = ch;
      b.dataset.ch = ch;
      b.setAttribute("aria-label", `letter ${ch}`);
      b.onclick = () => {
        prefix += ch;
        stopSpeaking();
        speak(LETTER_NAMES[ch]);
        renderGrid();
      };
      alphabet.append(b);
    }
  }
  renderGrid();
}

function renderGrid() {
  const matches = WORDS.filter((w) => w.word.toLowerCase().startsWith(prefix));
  // Only letters that can come next stay tappable, so a child can't spell a dead end.
  const next = new Set(matches.map((w) => w.word[prefix.length]?.toLowerCase()));
  for (const b of $("alphabet").children) b.disabled = !next.has(b.dataset.ch);

  $("spelled").hidden = !prefix;
  $("spelledLetters").replaceChildren(
    ...[...prefix].map((ch) => Object.assign(document.createElement("span"), { className: "spelled-letter", textContent: ch })),
  );
  $("spelledLetters").setAttribute("aria-label", prefix ? `Spelled so far: ${prefix}` : "");

  const list = prefix ? matches : shuffled(WORDS).slice(0, 12);
  $("grid").replaceChildren(...list.map(wordChip));
}

$("backBtn").onclick = () => { prefix = prefix.slice(0, -1); renderGrid(); };
$("resetBtn").onclick = () => { prefix = ""; renderGrid(); };

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let current = null;

function renderCard(entry) {
  current = entry;
  document.title = `${entry.word} – Word Finder`;

  const img = $("cardImg");
  const credit = CREDITS[entry.word];
  if (entry.image) {
    img.src = entry.image;
    img.alt = entry.word;
    img.hidden = false;
    $("cardEmoji").textContent = "";
    img.onerror = () => { img.hidden = true; $("cardEmoji").textContent = entry.emoji || "📘"; $("credit").textContent = ""; };
  } else {
    img.hidden = true;
    img.removeAttribute("src");
    $("cardEmoji").textContent = entry.emoji || "📘";
  }
  $("credit").innerHTML = "";
  if (entry.image && credit) $("credit").append(creditLine(credit));

  const spelling = $("spelling");
  spelling.className = "spelling";
  spelling.setAttribute("aria-label", entry.word);
  spelling.style.setProperty("--n", entry.word.length);
  spelling.replaceChildren(
    ...[...entry.word].map((ch, i) => {
      // Spaces and hyphens ("ice cream", "grown-up") are shown but not spoken.
      if (!LETTER_NAMES[ch.toLowerCase()]) {
        const gap = document.createElement("span");
        gap.className = "letter gap";
        gap.textContent = ch === " " ? "\u00a0" : ch;
        gap.setAttribute("aria-hidden", "true");
        return gap;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "letter";
      b.textContent = ch;
      b.dataset.i = i;
      b.setAttribute("aria-label", `letter ${ch}`);
      b.onclick = () => {
        const spoken = LETTER_NAMES[ch.toLowerCase()];
        if (!spoken) return;
        sequence(null, [async () => { highlightLetter(i); await speak(spoken); clearLetterHighlight(); }]);
      };
      return b;
    }),
  );

  const [name, kid] = TYPE_LABELS[entry.type] || [entry.type, ""];
  $("typeTag").innerHTML = "";
  const b = document.createElement("b");
  b.textContent = name;
  $("typeTag").append(b, kid ? ` · ${kid}` : "");

  $("definition").textContent = entry.definition;
  $("example").replaceChildren(...highlightWord(entry.example || "", entry));
}

function creditLine(c) {
  const frag = document.createDocumentFragment();
  const a = document.createElement("a");
  a.href = c.url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = c.title || "Picture";
  frag.append(a, ` by ${c.creator || "unknown"} · ${c.license}`);
  return frag;
}

/** Wrap the word (or one of its forms) in the example sentence in a highlight. */
function highlightWord(sentence, entry) {
  const forms = [entry.word, ...(entry.forms || [])].sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const m = sentence.match(re);
  if (!m) return [sentence];
  const mark = document.createElement("mark");
  mark.className = "word-hl";
  mark.textContent = m[0];
  return [sentence.slice(0, m.index), mark, sentence.slice(m.index + m[0].length)];
}

function highlightLetter(i) {
  document.querySelectorAll(".letter").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === i));
}
function clearLetterHighlight() {
  document.querySelectorAll(".letter.on").forEach((el) => el.classList.remove("on"));
  $("spelling")?.classList.remove("all-on");
}

// ---------------------------------------------------------------- card actions

function sayWord() {
  return sequence($("sayBtn"), [() => speak(current.word, { rate: 0.75 })]);
}

function spellWord() {
  const letters = [...current.word];
  const steps = [];
  letters.forEach((ch, i) => {
    const spoken = LETTER_NAMES[ch.toLowerCase()];
    if (!spoken) return;
    steps.push(async () => { highlightLetter(i); await speak(spoken, { rate: 0.8 }); await pause(180); });
  });
  steps.push(async () => {
    clearLetterHighlight();
    $("spelling").classList.add("all-on");
    await pause(150);
    await speak(current.word, { rate: 0.75 });
    $("spelling").classList.remove("all-on");
  });
  return sequence($("spellBtn"), steps);
}

function sayMeaning() {
  return sequence($("meanBtn"), [
    () => speak(current.word, { rate: 0.75 }),
    () => pause(250),
    () => speak(current.definition),
    () => pause(400),
    () => (current.example ? speak(current.example) : null),
  ]);
}

$("sayBtn").onclick = sayWord;
$("spellBtn").onclick = spellWord;
$("meanBtn").onclick = sayMeaning;
$("micBtn").onclick = startListening;

// ---------------------------------------------------------------- credits

function renderCredits() {
  const items = WORDS.filter((w) => w.image && CREDITS[w.word]).map((w) => {
    const li = document.createElement("li");
    li.append(`${w.word}: `, creditLine(CREDITS[w.word]));
    return li;
  });
  if (!items.length) items.push(Object.assign(document.createElement("li"), { textContent: "No downloaded pictures yet." }));
  $("creditList").replaceChildren(...items);
}

// ---------------------------------------------------------------- settings

const regionName = (() => {
  try {
    const names = new Intl.DisplayNames(["en-GB"], { type: "region" });
    return (lang) => names.of(normLang(lang).split("-")[1]?.toUpperCase() || "") || lang;
  } catch {
    return (lang) => lang;
  }
})();

function renderSettings() {
  const select = $("voiceSelect");
  const list = englishVoices().sort(
    (a, b) => (normLang(a.lang) === "en-gb" ? 0 : 1) - (normLang(b.lang) === "en-gb" ? 0 : 1) ||
      regionName(a.lang).localeCompare(regionName(b.lang)) || a.name.localeCompare(b.name),
  );
  const auto = new Option(`Automatic${defaultVoice() ? ` (${defaultVoice().name})` : ""}`, "");
  select.replaceChildren(auto, ...list.map((v) => new Option(`${v.name} · ${regionName(v.lang)}`, v.voiceURI)));
  select.value = localStorage.getItem(VOICE_KEY) || "";
  $("voiceNote").textContent = list.length
    ? ""
    : "This device hasn't shared its voices yet. Try again in a moment, or add English voices in the device's settings.";
}

$("voiceSelect").onchange = (e) => {
  if (e.target.value) localStorage.setItem(VOICE_KEY, e.target.value);
  else localStorage.removeItem(VOICE_KEY);
  pickVoice();
  stopSpeaking();
  speak("Hello! This is how I sound.");
};
$("voiceTry").onclick = () => { stopSpeaking(); speak("Hello! This is how I sound."); };

// ---------------------------------------------------------------- routing

function route() {
  stopSpeaking();
  if (listening) recogniser.abort();
  const hash = decodeURIComponent(location.hash.slice(1));
  const wordMatch = hash.match(/^\/word\/(.+)$/);
  const entry = wordMatch && lookup.get(wordMatch[1].toLowerCase());

  const page = ["/credits", "/settings"].includes(hash) ? hash : null;
  $("home").hidden = !!entry || !!page;
  $("card").hidden = !entry;
  $("credits").hidden = page !== "/credits";
  $("settings").hidden = page !== "/settings";
  $("homeBtn").hidden = !entry && !page;

  if (entry) {
    prefix = ""; // next time the start screen opens, spelling starts fresh
    renderCard(entry);
    window.scrollTo(0, 0);
    // Say the word as the card opens: speech synthesis is allowed here because the
    // child has just tapped or spoken, and some browsers quietly skip it otherwise.
    setTimeout(() => { if (current === entry) sayWord(); }, 250);
  } else if (page === "/credits") {
    renderCredits();
  } else if (page === "/settings") {
    renderSettings();
  } else {
    document.title = "Word Finder";
    setPrompt(Recognition ? "Tap and say a word" : "Spell your word with the letters");
    $("micBtn").classList.toggle("unsupported", !Recognition);
    $("heard").textContent = "";
    $("suggestions").innerHTML = "";
    renderHome();
  }
}

window.addEventListener("hashchange", route);

await loadData();
route();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered", err));
}
