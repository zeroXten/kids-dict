#!/usr/bin/env node
// Download a freely licensed picture for each word from Openverse (https://openverse.org),
// record its attribution in data/credits.json, and set `image` in data/words.json.
//
//   node scripts/fetch-images.mjs                 # every word that has no picture yet
//   node scripts/fetch-images.mjs frozen moon     # just these words (replaces their pictures)
//   node scripts/fetch-images.mjs moon --pick=2   # use the 3rd search result instead of the 1st
//   node scripts/fetch-images.mjs moon --remove   # drop the picture, go back to the emoji
//   node scripts/fetch-images.mjs moon --candidates  # save the top 8 results to candidates/moon/
//                                                    # (0.jpg, 1.jpg…) to choose a --pick number
//
// Words marked "noImage": true are skipped unless named. "imageQuery" overrides the search
// text (e.g. "frozen icicles", so "frozen" doesn't find film posters).
//
// Afterwards, open review.html and check every picture before publishing: search
// results are not hand-picked, and this app is for children.

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORDS = path.join(ROOT, "data/words.json");
const CREDITS = path.join(ROOT, "data/credits.json");
const IMAGES = path.join(ROOT, "images");
const API = "https://api.openverse.org/v1/images/";
// Licences that allow reuse in a published app with attribution.
const LICENSES = "cc0,pdm,by,by-sa";
const DELAY_MS = 3500; // anonymous Openverse requests are rate limited

const args = process.argv.slice(2);
const named = args.filter((a) => !a.startsWith("--"));
const pick = Number((args.find((a) => a.startsWith("--pick=")) || "--pick=0").split("=")[1]);
const remove = args.includes("--remove");
const candidates = args.includes("--candidates");
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

const words = JSON.parse(await readFile(WORDS, "utf8"));
const credits = existsSync(CREDITS) ? JSON.parse(await readFile(CREDITS, "utf8")) : {};
await mkdir(IMAGES, { recursive: true });

const targets = named.length
  ? words.filter((w) => named.includes(w.word))
  : words.filter((w) => !w.noImage && !w.image);

if (named.length && targets.length !== named.length) {
  const missing = named.filter((n) => !words.some((w) => w.word === n));
  console.warn(`Not in words.json: ${missing.join(", ")}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save() {
  await writeFile(WORDS, toJson(words));
  await writeFile(CREDITS, JSON.stringify(credits, null, 2) + "\n");
}

// One entry per line keeps words.json easy to read and diff.
function toJson(list) {
  return "[\n" + list.map((w) => "  " + JSON.stringify(w)).join(",\n") + "\n]\n";
}

async function search(query) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    q: query,
    license: LICENSES,
    mature: "false",
    page_size: "20",
    aspect_ratio: "square,wide",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "kids-dictionary-image-fetch/1.0" } });
    if (res.status === 429) {
      console.log("  rate limited, waiting a minute…");
      await sleep(60_000);
      continue;
    }
    if (!res.ok) throw new Error(`Openverse search failed: ${res.status}`);
    const data = await res.json();
    // Skip results with no creator or tiny originals; they tend to be poor.
    return data.results.filter((r) => r.width >= 300 && r.height >= 300);
  }
  throw new Error("Openverse kept rate limiting; try again later.");
}

/**
 * Download a result's thumbnail as `<base>-<content hash>.<ext>` and return that path.
 * The hash gives a replaced picture a new URL, so no browser or offline cache can keep
 * showing the old one.
 */
async function download(result, base) {
  // Openverse serves a resized thumbnail for every result: smaller and more reliable
  // than fetching the original from its host.
  const res = await fetch(`${API}${result.id}/thumb/`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const type = res.headers.get("content-type") || "";
  const ext = EXT[type.split(";")[0].trim()];
  if (!ext) throw new Error(`unexpected image type: ${type}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const file = `${base}-${createHash("sha1").update(bytes).digest("hex").slice(0, 8)}.${ext}`;
  await writeFile(file, bytes);
  return file;
}

for (const [i, entry] of targets.entries()) {
  const oldFile = entry.image && path.join(ROOT, entry.image);

  if (remove) {
    delete entry.image;
    delete credits[entry.word];
    if (oldFile && existsSync(oldFile)) await unlink(oldFile);
    console.log(`${entry.word}: picture removed`);
    continue;
  }

  const query = entry.imageQuery || entry.word;
  process.stdout.write(`${entry.word} ("${query}")… `);
  try {
    const results = await search(query);
    if (candidates) {
      const dir = path.join(ROOT, "candidates", entry.word);
      await mkdir(dir, { recursive: true });
      const saved = await Promise.allSettled(results.slice(0, 8).map((r, n) => download(r, path.join(dir, String(n)))));
      console.log(`${saved.filter((r) => r.status === "fulfilled").length} candidates in candidates/${entry.word}/`);
      if (i < targets.length - 1) await sleep(DELAY_MS);
      continue;
    }
    const result = results[pick];
    if (!result) {
      console.log(`no result #${pick}, keeping emoji`);
    } else {
      const saved = await download(result, path.join(ROOT, "images", entry.word.toLowerCase().replace(/[^a-z0-9]+/g, "-")));
      const file = path.relative(ROOT, saved);
      if (oldFile && oldFile !== saved && existsSync(oldFile)) await unlink(oldFile);
      entry.image = file;
      credits[entry.word] = {
        title: result.title,
        creator: result.creator,
        license: `${result.license.toUpperCase()} ${result.license_version || ""}`.trim(),
        licenseUrl: result.license_url,
        url: result.foreign_landing_url,
      };
      console.log(`ok (${credits[entry.word].license}, ${result.creator || "unknown"})`);
      await save();
    }
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
  if (i < targets.length - 1) await sleep(DELAY_MS);
}

if (candidates) process.exit(0);
await save();
await writeReview();
console.log(`\nDone. Open review.html to check the pictures before publishing.`);

async function writeReview() {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cards = words
    .filter((w) => w.image)
    .map((w) => {
      const c = credits[w.word] || {};
      return `<figure><img src="${esc(w.image)}" alt="" loading="lazy"><figcaption><b>${esc(w.word)}</b><br>
        <a href="${esc(c.url)}" target="_blank">${esc(c.title)}</a><br>${esc(c.creator)} · ${esc(c.license)}<br>
        <code>node scripts/fetch-images.mjs ${esc(w.word)} --pick=1</code></figcaption></figure>`;
    })
    .join("\n");
  const html = `<!DOCTYPE html><meta charset="utf-8"><title>Picture review</title>
<style>body{font-family:system-ui;margin:20px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
figure{margin:0;background:#f6f6f6;border-radius:12px;overflow:hidden}img{width:100%;aspect-ratio:1;object-fit:cover}
figcaption{padding:8px;font-size:12px;line-height:1.4}code{font-size:11px;user-select:all}</style>
<h1>Picture review</h1><p>Check each picture is suitable. To try the next search result for a word, run the command under it
(--pick=2, 3… for later ones). To go back to the emoji, use --remove.</p><main>${cards}</main>`;
  await writeFile(path.join(ROOT, "review.html"), html);
}
