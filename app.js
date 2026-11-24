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
    lookup.set(entry.word, entry);
    for (const f of entry.forms || []) if (!lookup.has(f)) lookup.set(f, entry);
  }
}

// ---------------------------------------------------------------- matching

const normalise = (s) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();

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
  // 2. Any word in the phrase, scanning from the end ("what does frozen mean").
  for (const p of cleaned) {
    const tokens = p.split(" ");
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (lookup.has(tokens[i])) return { entry: lookup.get(tokens[i]) };
    }
  }
  // 3. Close matches, for suggestions.
  const target = cleaned[0] || "";
  const tokens = target.split(" ").filter((t) => t.length > 1);
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

let voice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const good = /Google UK English Female|Serena|Kate|Martha|Natural|Daniel|Google UK/i;
  voice =
    voices.find((v) => v.lang === "en-GB" && good.test(v.name)) ||
    voices.find((v) => v.lang === "en-GB") ||
    voices.find((v) => v.lang?.startsWith("en")) ||
    null;
}
if ("speechSynthesis" in window) {
  pickVoice();
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
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || "en-GB";
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
    setPrompt("Talking isn't available here. Type a word instead.");
    $("typeInput").focus();
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
      setPrompt("I need the internet to listen. Type a word instead.");
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

let activeLetter = null;

function renderHome() {
  const alphabet = $("alphabet");
  if (!alphabet.childElementCount) {
    const firstLetters = new Set(WORDS.map((w) => w.word[0]));
    for (const ch of "abcdefghijklmnopqrstuvwxyz") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = ch;
      b.disabled = !firstLetters.has(ch);
      b.setAttribute("aria-label", `Words starting with ${ch}`);
      b.onclick = () => {
        activeLetter = activeLetter === ch ? null : ch;
        speak(LETTER_NAMES[ch]);
        renderGrid();
      };
      alphabet.append(b);
    }
  }
  renderGrid();
}

function renderGrid() {
  for (const b of $("alphabet").children) b.classList.toggle("active", b.textContent === activeLetter);
  const list = activeLetter
    ? WORDS.filter((w) => w.word.startsWith(activeLetter))
    : shuffled(WORDS).slice(0, 12);
  $("grid").replaceChildren(...list.map(wordChip));
}

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
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("typeInput").value;
  if (v.trim()) handleSearch([v], false);
};

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

// ---------------------------------------------------------------- routing

function route() {
  stopSpeaking();
  if (listening) recogniser.abort();
  const hash = decodeURIComponent(location.hash.slice(1));
  const wordMatch = hash.match(/^\/word\/(.+)$/);
  const entry = wordMatch && lookup.get(wordMatch[1]);

  $("home").hidden = !!entry || hash === "/credits";
  $("card").hidden = !entry;
  $("credits").hidden = hash !== "/credits";
  $("homeBtn").hidden = !entry && hash !== "/credits";

  if (entry) {
    renderCard(entry);
    window.scrollTo(0, 0);
    // Say the word as the card opens: speech synthesis is allowed here because the
    // child has just tapped or spoken, and some browsers quietly skip it otherwise.
    setTimeout(() => { if (current === entry) sayWord(); }, 250);
  } else if (hash === "/credits") {
    renderCredits();
  } else {
    document.title = "Word Finder";
    setPrompt(Recognition ? "Tap and say a word" : "Type a word to find it");
    $("micBtn").classList.toggle("unsupported", !Recognition);
    $("heard").textContent = "";
    $("suggestions").innerHTML = "";
    $("typeInput").value = "";
    renderHome();
  }
}

window.addEventListener("hashchange", route);

await loadData();
route();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered", err));
}
