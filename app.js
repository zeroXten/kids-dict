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
  name: ["name", "a person's name"],
};

// How to say each letter. Voices read a capital letter on its own as its name ("E" is
// "ee"), except "A", which some read as the word "a" ("uh"), so that one is spelled out.
// Written-out names like "ee" or "eff" don't work: voices spell them letter by letter.
const LETTER_NAMES = Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz"].map((c) => [c, c.toUpperCase()]));
LETTER_NAMES.a = "ay";

let WORDS = [];
let CREDITS = {};
const lookup = new Map(); // word or word form -> entry

// ---------------------------------------------------------------- data

async function loadData() {
  const [words, credits] = await Promise.all([
    fetch("data/words.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/credits.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  CREDITS = credits;
  const byWord = new Map(words.map((w) => [w.word.toLowerCase(), w]));

  // A word can borrow another word's picture ("quack" uses "duck").
  for (const w of words) {
    const from = w.imageFrom && byWord.get(w.imageFrom.toLowerCase());
    if (from) {
      w.image = from.image;
      w.creditKey = from.word;
      w.emoji ||= from.emoji;
    }
  }

  for (const entry of words) {
    // Keys are lower case, so "monday" finds "Monday". Headwords beat other words' forms.
    lookup.set(entry.word.toLowerCase(), entry);
    // Speech recognition writes "grown-up" as "grown up".
    if (entry.word.includes("-")) lookup.set(entry.word.toLowerCase().replace(/-/g, " "), entry);
  }

  // Every other form of a word ("mice", "ran", "quick") is a word to spell in its own
  // right: it gets its own page, sharing the main word's picture and meaning.
  const extra = [];
  for (const base of words) {
    for (const form of base.forms || []) {
      const key = form.toLowerCase();
      if (lookup.has(key)) continue;
      const entry = {
        word: form,
        type: base.type,
        emoji: base.emoji,
        image: base.image,
        creditKey: base.creditKey || base.word,
        definition: base.definition,
        example: base.example,
        forms: [base.word, ...base.forms],
        base,
      };
      lookup.set(key, entry);
      extra.push(entry);
    }
  }
  WORDS = [...words, ...extra].sort((a, b) => a.word.localeCompare(b.word));
}

const creditFor = (entry) => CREDITS[entry.creditKey || entry.word];

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
    // Some voices never report that they've finished, which would stall "Spell it"
    // part-way. Carry on anyway after a generous time for the text's length.
    const done = () => { clearTimeout(timer); speaking.delete(u); resolve(); };
    const timer = setTimeout(done, 1500 + text.length * 180 / rate);
    u.onend = u.onerror = done;
    speaking.add(u); // Chrome can drop the end event of an utterance nothing refers to
    speechSynthesis.speak(u);
  });
}
const speaking = new Set();

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

// ---------------------------------------------------------------- views and state

let view = "home"; // "home" (searching), "card" (a word), or a grown-up page
let prefix = ""; // letters typed so far while searching
let current = null; // the word being shown
let practicePos = 0; // how many letters of the current word have been typed
let celebrateTimer = null;

function setStatus(content) {
  const el = $("status");
  if (typeof content === "string") el.textContent = content;
  else el.replaceChildren(...content);
}

function wordChip(entry) {
  const a = document.createElement("a");
  a.className = "chip";
  a.href = `#/word/${encodeURIComponent(entry.word)}`;
  const emoji = document.createElement("span");
  emoji.setAttribute("aria-hidden", "true");
  emoji.textContent = entry.emoji || "";
  a.append(emoji, entry.word);
  return a;
}

// ---------------------------------------------------------------- keyboard

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function buildKeyboard() {
  const kb = $("keyboard");
  ROWS.forEach((row, r) => {
    const div = document.createElement("div");
    div.className = "kb-row";
    for (const ch of row) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "key";
      b.textContent = ch;
      b.dataset.ch = ch;
      b.setAttribute("aria-label", ch);
      b.onclick = () => pressLetter(ch);
      div.append(b);
    }
    if (r === 2) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "key back";
      back.textContent = "⌫";
      back.setAttribute("aria-label", "Rub out");
      back.onclick = pressBack;
      div.append(back);
    }
    kb.append(div);
  });
}

const keys = () => document.querySelectorAll("#keyboard .key[data-ch]");

function pressLetter(ch) {
  if (view === "home") searchLetter(ch);
  else if (view === "card") practiceLetter(ch);
}

function pressBack() {
  if (view === "home") {
    prefix = prefix.slice(0, -1);
    renderSearch();
  } else if (view === "card" && practicePos > 0) {
    practicePos--;
    renderPractice();
  }
}

// A real keyboard works too (tablet cases, computers).
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /SELECT|INPUT|TEXTAREA/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (/^[a-z]$/.test(k)) {
    const btn = document.querySelector(`#keyboard .key[data-ch="${k}"]`);
    if (btn && !btn.disabled) pressLetter(k);
    e.preventDefault();
  } else if (e.key === "Backspace") {
    pressBack();
    e.preventDefault();
  }
});

// ---------------------------------------------------------------- search

function searchLetter(ch) {
  prefix += ch;
  stopSpeaking();
  speak(LETTER_NAMES[ch]);
  renderSearch();
}

function renderSearch() {
  const matches = prefix ? WORDS.filter((w) => w.word.toLowerCase().startsWith(prefix)) : WORDS;
  // Only letters that can come next stay pressable, so a child can't spell a dead end.
  const next = new Set(matches.map((w) => w.word[prefix.length]?.toLowerCase()));
  for (const k of keys()) {
    k.disabled = !next.has(k.dataset.ch);
    k.classList.remove("hint", "nope");
  }

  $("spelled").replaceChildren(...[...prefix].map((ch) => Object.assign(document.createElement("span"), { textContent: ch })));
  $("spelled").setAttribute("aria-label", prefix ? `Spelled so far: ${prefix}` : "");
  $("clearBtn").hidden = !prefix;

  $("results").hidden = !prefix;
  $("count").textContent = prefix ? `${matches.length} ${matches.length === 1 ? "word" : "words"}` : "";
  if (prefix) {
    setStatus("");
    $("heard").textContent = "";
    $("suggestions").replaceChildren();
    renderList(matches);
  } else {
    $("list").replaceChildren();
    $("index").replaceChildren();
    if (!$("status").textContent && !listening) showHint();
  }
}

/** Words grouped by their next letter ("ha", "he", "hi"…), with a thumb index to jump between groups. */
function renderList(matches) {
  const groups = new Map();
  for (const w of matches) {
    const key = w.word.toLowerCase().slice(0, prefix.length + 1).trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const sections = [];
  const tabs = [];
  for (const [key, words] of groups) {
    const head = document.createElement("h3");
    head.className = "section";
    head.textContent = key;
    sections.push(head, ...words.map(wordRow));
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = key;
    tab.onclick = () => {
      $("results").scrollTo({ top: head.offsetTop - $("list").offsetTop, behavior: "smooth" });
    };
    tab._section = head;
    tabs.push(tab);
  }
  $("list").replaceChildren(...sections);
  $("index").replaceChildren(...tabs);
  $("index").hidden = groups.size < 2;
  $("results").scrollTop = 0;
  updateScrollCues();
}

function wordRow(entry) {
  const a = document.createElement("a");
  a.className = entry.base ? "row form" : "row";
  a.href = `#/word/${encodeURIComponent(entry.word)}`;
  const emoji = Object.assign(document.createElement("span"), { className: "row-emoji", textContent: entry.emoji || "" });
  emoji.setAttribute("aria-hidden", "true");
  const word = Object.assign(document.createElement("span"), { className: "row-word", textContent: entry.word });
  a.append(emoji, word);
  return a;
}

/** Fade the bottom while there's more to scroll, and light up the index tab for the section in view. */
function updateScrollCues() {
  const r = $("results");
  r.classList.toggle("more", r.scrollHeight - r.scrollTop - r.clientHeight > 4);
  const top = r.scrollTop + $("list").offsetTop + 8;
  let currentTab = null;
  for (const tab of $("index").children) if (tab._section.offsetTop <= top) currentTab = tab;
  currentTab ??= $("index").firstElementChild;
  for (const tab of $("index").children) tab.classList.toggle("current", tab === currentTab);
}
$("results").addEventListener("scroll", updateScrollCues, { passive: true });
window.addEventListener("resize", () => { if (view === "home" && prefix) updateScrollCues(); });

function showHint() {
  const arrow = Object.assign(document.createElement("span"), { className: "hint-arrow", textContent: "👇" });
  setStatus([
    Recognition ? "Type a word on the keys, or tap 🎤 and say it" : "Type a word on the keys",
    arrow,
  ]);
}

$("clearBtn").onclick = () => {
  prefix = "";
  setStatus("");
  renderSearch();
};

// ---------------------------------------------------------------- speech in

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recogniser = null;
let listening = false;

function setListening(on) {
  listening = on;
  $("micBtn").classList.toggle("listening", on);
  $("micLabel").textContent = on ? "Listening…" : "Say a word";
}

function startListening() {
  if (view !== "home") {
    // Switch to the search screen straight away (not via hashchange), so the
    // microphone starts within the tap that asked for it.
    history.pushState(null, "", "#/");
    route();
  }
  if (!Recognition) {
    setStatus("Talking isn't available on this device. Type the word on the keys instead.");
    return;
  }
  if (listening) { recogniser.stop(); return; }
  stopSpeaking();
  prefix = "";
  renderSearch();

  recogniser = new Recognition();
  recogniser.lang = "en-GB";
  recogniser.interimResults = true;
  recogniser.maxAlternatives = 5;
  recogniser.continuous = false;

  let finalAlternatives = null;

  recogniser.onstart = () => {
    setListening(true);
    setStatus("I'm listening… say a word!");
    $("heard").textContent = "";
    $("suggestions").replaceChildren();
  };
  recogniser.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    $("heard").textContent = result[0].transcript;
    if (result.isFinal) finalAlternatives = Array.from(result, (alt) => alt.transcript);
  };
  recogniser.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("Ask a grown-up to let me use the microphone.");
    } else if (e.error === "no-speech") {
      setStatus("I didn't hear anything. Tap 🎤 and try again!");
    } else if (e.error === "network") {
      setStatus("I need the internet to listen. Type the word on the keys instead.");
    }
  };
  recogniser.onend = () => {
    setListening(false);
    if (finalAlternatives) handleSpoken(finalAlternatives);
    else if ($("status").textContent.startsWith("I'm listening")) { setStatus(""); renderSearch(); }
  };
  recogniser.start();
}

function handleSpoken(phrases) {
  const { entry, suggestions, heard } = findWord(phrases);
  if (entry) {
    location.hash = `#/word/${encodeURIComponent(entry.word)}`;
    return;
  }
  if (suggestions.length) {
    setStatus(`I don't know "${heard}" yet. Did you mean…`);
    $("suggestions").replaceChildren(...suggestions.map(wordChip));
    speak(`I don't know that word yet. Did you mean ${suggestions.map((s) => s.word).join(", or ")}?`);
  } else {
    setStatus(heard ? `I don't know "${heard}" yet. Try another word!` : "Try another word!");
    speak("I don't know that word yet. Try another one!");
  }
  $("heard").textContent = "";
}

$("micBtn").onclick = startListening;
$("micBtn").classList.toggle("unsupported", !Recognition);

// ---------------------------------------------------------------- word card

function renderCard(entry) {
  current = entry;
  document.title = `${entry.word} – Word Finder`;

  const img = $("cardImg");
  const credit = creditFor(entry);
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
  $("credit").replaceChildren();
  if (entry.image && credit) $("credit").append(creditLine(credit));

  const spelling = $("spelling");
  spelling.className = "spelling";
  spelling.setAttribute("aria-label", entry.word);
  spelling.style.setProperty("--n", entry.word.length);
  spelling.replaceChildren(
    ...[...entry.word].map((ch, i) => {
      // Spaces and hyphens ("ice cream", "grown-up") are shown but not typed or spoken.
      if (!LETTER_NAMES[ch.toLowerCase()]) {
        const gap = document.createElement("span");
        gap.className = "letter gap";
        gap.textContent = ch === " " ? " " : ch;
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
        sequence(null, [async () => { highlightLetter(i); await speak(LETTER_NAMES[ch.toLowerCase()]); clearLetterHighlight(); }]);
      };
      return b;
    }),
  );

  const [name, kid] = TYPE_LABELS[entry.type] || [entry.type, ""];
  const b = document.createElement("b");
  b.textContent = name;
  $("typeTag").replaceChildren(b, kid ? ` · ${kid}` : "");

  $("definition").textContent = entry.definition;
  // A form of another word links back to it: "mice" → "See also: mouse".
  $("related").hidden = !entry.base;
  if (entry.base) {
    const link = document.createElement("a");
    link.href = `#/word/${encodeURIComponent(entry.base.word)}`;
    link.textContent = entry.base.word;
    const plural = [`${entry.base.word}s`, `${entry.base.word}es`].includes(entry.word.toLowerCase());
    $("related").replaceChildren(plural ? "More than one " : "See also: ", link);
  }
  $("example").replaceChildren(...highlightWord(entry.example || "", entry));

  practicePos = 0;
  hideCelebrate();
  renderPractice();
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

// ---------------------------------------------------------------- practice: copy the word

/** Positions in the current word that are letters to type (skips spaces and hyphens). */
const letterPositions = () => [...current.word].flatMap((ch, i) => (LETTER_NAMES[ch.toLowerCase()] ? [i] : []));

function renderPractice() {
  const positions = letterPositions();
  const tiles = [...$("spelling").querySelectorAll(".letter:not(.gap)")];
  tiles.forEach((t, n) => {
    t.classList.toggle("done", n < practicePos);
    t.classList.toggle("todo", n >= practicePos);
    t.classList.toggle("next", n === practicePos);
  });
  const want = practicePos < positions.length ? current.word[positions[practicePos]].toLowerCase() : null;
  for (const k of keys()) {
    k.disabled = false;
    k.classList.toggle("hint", k.dataset.ch === want);
    k.classList.remove("nope");
  }
  $("practiceNote").hidden = practicePos > 0;
}

function practiceLetter(ch) {
  const positions = letterPositions();
  if (practicePos >= positions.length) return;
  const i = positions[practicePos];
  const tile = $("spelling").querySelector(`.letter[data-i="${i}"]`);
  if (ch === current.word[i].toLowerCase()) {
    practicePos++;
    renderPractice();
    if (practicePos === positions.length) celebrate();
    else sequence(null, [() => speak(LETTER_NAMES[ch])]);
  } else {
    // Not that one: wiggle the letter they're on, and flash the key they pressed.
    tile.classList.remove("wrong");
    void tile.offsetWidth; // restart the animation
    tile.classList.add("wrong");
    const key = document.querySelector(`#keyboard .key[data-ch="${ch}"]`);
    key.classList.add("nope");
    setTimeout(() => key.classList.remove("nope"), 300);
  }
}

function celebrate() {
  const entry = current;
  $("celebrate").hidden = false;
  sequence(null, [
    () => speak(entry.word, { rate: 0.75 }),
    () => speak("Well done!", { pitch: 1.2 }),
  ]);
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => {
    if (current !== entry) return;
    hideCelebrate();
    practicePos = 0; // ready to have another go
    renderPractice();
  }, 2600);
}

function hideCelebrate() {
  clearTimeout(celebrateTimer);
  $("celebrate").hidden = true;
}

// ---------------------------------------------------------------- card actions

function sayWord() {
  return sequence($("sayBtn"), [() => speak(current.word, { rate: 0.75 })]);
}

function spellWord() {
  const steps = [];
  [...current.word].forEach((ch, i) => {
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

// ---------------------------------------------------------------- credits

function renderCredits() {
  const items = WORDS.filter((w) => !w.base && !w.imageFrom && w.image && CREDITS[w.word]).map((w) => {
    const li = document.createElement("li");
    li.append(`${w.word}: `, creditLine(CREDITS[w.word]));
    return li;
  });
  if (!items.length) items.push(Object.assign(document.createElement("li"), { textContent: "No downloaded pictures yet." }));
  $("creditList").replaceChildren(...items);
}

// ---------------------------------------------------------------- settings

// Installing: Chrome, Edge and Android offer a prompt the page can trigger; Safari on
// iPhone and iPad doesn't, so there we explain the Share menu instead.
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => { installEvent = e; renderInstall(); });
window.addEventListener("appinstalled", () => { installEvent = null; renderInstall(); });

function renderInstall() {
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const iosSafari = ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

  $("installBtn").hidden = installed || !installEvent;
  $("installNote").textContent = installed
    ? "✓ Word Finder is installed on this device."
    : installEvent
      ? "Puts Word Finder on the home screen, so it opens like an app and works offline."
      : iosSafari
        ? "Tap the Share button (the square with an arrow) at the bottom or top of Safari, then Add to Home Screen, then Add."
        : ios
          ? "On iPhone and iPad, open this page in Safari, then tap Share → Add to Home Screen."
          : "Open your browser's menu and choose Install app or Add to Home screen.";
}

$("installBtn").onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  renderInstall();
};

const regionName = (() => {
  try {
    const names = new Intl.DisplayNames(["en-GB"], { type: "region" });
    return (lang) => names.of(normLang(lang).split("-")[1]?.toUpperCase() || "") || lang;
  } catch {
    return (lang) => lang;
  }
})();

function renderSettings() {
  renderInstall();
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
  hideCelebrate();
  const hash = decodeURIComponent(location.hash.slice(1));
  const wordMatch = hash.match(/^\/word\/(.+)$/);
  const entry = wordMatch && lookup.get(wordMatch[1].toLowerCase());
  const page = ["/credits", "/settings"].includes(hash) ? hash : null;
  if (listening && (entry || page)) recogniser.abort();

  view = entry ? "card" : page || "home";
  $("home").hidden = view !== "home";
  $("card").hidden = view !== "card";
  $("credits").hidden = page !== "/credits";
  $("settings").hidden = page !== "/settings";
  $("dock").hidden = !!page;
  $("backLink").hidden = !page;
  $("settingsLink").hidden = !!page;
  $("newBtn").hidden = view !== "card";
  $("clearBtn").hidden = true;
  $("stage").scrollTop = 0;

  if (entry) {
    prefix = ""; // the next search starts fresh
    renderCard(entry);
    // Say the word as the card opens: the child has just tapped or spoken, so
    // browsers allow speech here.
    setTimeout(() => { if (current === entry && view === "card") sayWord(); }, 250);
  } else if (page === "/credits") {
    renderCredits();
  } else if (page === "/settings") {
    renderSettings();
  } else {
    document.title = "Word Finder";
    if (!listening) { setStatus(""); $("heard").textContent = ""; }
    $("suggestions").replaceChildren();
    renderSearch();
  }
}

window.addEventListener("hashchange", route);

buildKeyboard();
await loadData();
route();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered", err));
}
