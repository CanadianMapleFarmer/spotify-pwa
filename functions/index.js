// Spotify TV PWA — Scene library (Cloud Functions).
//
// Why this exists: a <video> WITH AN AUDIO TRACK engages the VIDAA firmware
// audio pipeline and pauses Spotify. In-browser stripping (mp4box+MSE) was
// flaky, and the JPG image-sequence workaround performed terribly on the TV
// (per-frame decode + huge decoded-bitmap memory). The fix is server-side:
// produce SILENT MP4s (no audio track at all → nothing to contend over) and
// let the TV's hardware H.264 decoder play them with a plain <video src>.
//
// To keep the system inside Firebase's free tier we don't transcode on demand.
// Instead a single scheduled function runs once a week, picks fresh Pexels
// clips, strips/transcodes them to silent MP4s, and writes the metadata to
// Firestore. The client reads the current library and plays the clips.
//
// Layout in Storage:    gs://<bucket>/scene-clips-v3/<id>.mp4
//                       (legacy: scene-frames-v2/<id>/frame_NNNN.jpg)
// Metadata in Firestore: collection "sceneClips", doc id = <id>
//   { id, category, kind: "video", videoUrl, sourceUrl, addedAt }
//   (legacy frame docs: { id, category, frames: [url...], fps, sourceUrl })
//
// Endpoints:
//   - refreshSceneLibrary  (Pub/Sub scheduled, weekly): fetch + convert + GC
//   - listSceneClips        (HTTPS): return current library by category
//   - convertSceneClip      (HTTPS, on-demand fallback / manual trigger)

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");

admin.initializeApp();
ffmpeg.setFfmpegPath(ffmpegPath);

const db = admin.firestore();

// Pexels API key as a Secret (set via: firebase functions:secrets:set PEXELS_KEY).
// Pulled in at function deploy time; never inlined in code or git.
const PEXELS_KEY = defineSecret("PEXELS_KEY");

const FPS = 10; // legacy frame-doc fps, still reported by listSceneClips
// Target width for the silent MP4s. We pick the Pexels rendition closest to
// (and at most) this wide so the common case is a free stream-copy; anything
// wider gets transcoded down so the TV's hardware decoder stays comfortable.
const MAX_WIDTH = 1920;
// Cap clip length so a single Pexels long-take can't bloat storage/bandwidth.
const MAX_CLIP_SECONDS = 45;
// Silent MP4s live under -v3; the retired image-sequence frames stayed under
// -v2 and are garbage-collected by pruneObsolete as video docs replace them.
const STORAGE_PREFIX = "scene-clips-v3";
const LEGACY_FRAME_PREFIX = "scene-frames-v2";
const COLLECTION = "sceneClips";
// Once a category has at least this many fresh silent-video clips, its legacy
// frame docs are no longer a useful fallback and get pruned first.
const MIN_VIDEOS_TO_DROP_FRAMES = 3;

// How many clips to keep per category. The Scene UI cycles through them randomly.
const TARGET_PER_CATEGORY = 10;
const CATEGORIES = {
  nature: "nature landscape mountain forest",
  skyline: "city skyline urban night",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveClipId(url) {
  const match = url.match(/\/(\d+)\/(\d+)-/);
  if (match) return `pexels-${match[1]}`;
  const slug = url.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  return `url-${slug}`;
}

function publicUrl(bucketName, objectPath) {
  return `https://storage.googleapis.com/${bucketName}/${encodeURI(objectPath)}`;
}

async function downloadToTmp(url, dest) {
  const fetched = await fetch(url);
  if (!fetched.ok) throw new Error(`Source fetch failed: ${fetched.status}`);
  const buf = Buffer.from(await fetched.arrayBuffer());
  await fs.writeFile(dest, buf);
}

// Strip the audio track (and, if the source is bigger than 1080p, transcode
// down to TV-friendly H.264). The common case — Pexels gives us a ≤1080p
// rendition — is a pure stream-copy: no decode, runs in a couple of seconds.
async function makeSilentMp4(inputPath, outPath, source) {
  const canCopy = source.width > 0
    && source.width <= MAX_WIDTH
    && (source.height || 0) <= 1080;
  const outputOptions = canCopy
    ? [
        "-an",
        "-c:v", "copy",
        "-t", String(MAX_CLIP_SECONDS),
        "-movflags", "+faststart",
      ]
    : [
        "-an",
        "-vf", `scale=${MAX_WIDTH}:-2`,
        "-c:v", "libx264",
        "-profile:v", "main",
        "-level", "4.0",
        "-b:v", "5M",
        "-maxrate", "6M",
        "-bufsize", "10M",
        "-r", "30",
        "-t", String(MAX_CLIP_SECONDS),
        "-movflags", "+faststart",
      ];
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// source: { link, width, height } from fetchPexelsClips. Strings (manual
// convertSceneClip calls) are normalized to width 0 — dimensions unknown — so
// they take the transcode path, which is safe for any input size.
async function convertOneClip(source, category, bucket) {
  if (typeof source === "string") source = { link: source, width: 0, height: 0 };
  const sourceUrl = source.link;
  const id = deriveClipId(sourceUrl);
  const dest = `${STORAGE_PREFIX}/${id}.mp4`;
  const file = bucket.file(dest);

  // Already converted — just (re-)write the Firestore doc so this clip stays
  // in the current week's library.
  const [exists] = await file.exists();
  const videoUrl = publicUrl(bucket.name, dest);
  if (exists) {
    await db.collection(COLLECTION).doc(id).set({
      id, category, kind: "video", videoUrl, sourceUrl,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { id, videoUrl, cached: true };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `scene-${id}-`));
  try {
    const inputPath = path.join(tmpDir, "input.mp4");
    const outPath = path.join(tmpDir, "silent.mp4");
    await downloadToTmp(sourceUrl, inputPath);
    await makeSilentMp4(inputPath, outPath, source);

    const stat = await fs.stat(outPath);
    if (!stat.size) throw new Error("ffmpeg produced an empty file");

    await bucket.upload(outPath, {
      destination: dest,
      public: true,
      metadata: { contentType: "video/mp4", cacheControl: "public, max-age=604800" },
    });

    await db.collection(COLLECTION).doc(id).set({
      id, category, kind: "video", videoUrl, sourceUrl,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { id, videoUrl, cached: false };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function fetchPexelsClips(category, key, limit) {
  // The Pexels Videos API returns landscape MP4s at several resolutions per
  // video. We want the rendition *closest to (and at most) MAX_WIDTH wide*: at
  // ≤1080p the conversion is a free stream-copy and the TV's hardware decoder
  // is comfortable. Only if every rendition is wider do we take the narrowest
  // one and transcode it down.
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", CATEGORIES[category] || category);
  url.searchParams.set("per_page", String(Math.max(limit * 2, 10)));
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("size", "medium"); // medium = at least Full HD source, so a near-MAX_WIDTH file exists
  const resp = await fetch(url.toString(), { headers: { Authorization: key } });
  if (!resp.ok) throw new Error(`Pexels API ${resp.status}`);
  const data = await resp.json();
  const picks = [];
  for (const video of data.videos || []) {
    const mp4s = (video.video_files || []).filter((f) => f.file_type === "video/mp4" && f.width && f.link);
    if (!mp4s.length) continue;
    const atOrBelow = mp4s.filter((f) => f.width <= MAX_WIDTH).sort((a, b) => b.width - a.width);
    const file = atOrBelow[0] || mp4s.slice().sort((a, b) => a.width - b.width)[0];
    if (file) picks.push({ link: file.link, width: file.width || 0, height: file.height || 0 });
    if (picks.length >= limit) break;
  }
  return picks;
}

async function pruneObsolete(currentIdsByCategory) {
  // Drop sceneClips docs (and their Storage objects) that aren't in this week's
  // current set, so we don't accumulate storage forever. Legacy frame docs are
  // kept as a fallback only while their category is still short on silent
  // video clips; once a category has enough, its frame docs go first.
  const bucket = admin.storage().bucket();
  const allDocs = await db.collection(COLLECTION).get();
  const keep = new Set();
  const videoCount = {};
  for (const [cat, ids] of Object.entries(currentIdsByCategory)) {
    videoCount[cat] = ids.length;
    ids.forEach((id) => keep.add(id));
  }
  for (const docSnap of allDocs.docs) {
    const id = docSnap.id;
    if (keep.has(id)) continue;
    const data = docSnap.data() || {};
    const isLegacyFrames = data.kind !== "video";
    if (isLegacyFrames && (videoCount[data.category] || 0) < MIN_VIDEOS_TO_DROP_FRAMES) {
      continue; // category not yet healthy on video clips — keep the fallback
    }
    // Delete Storage objects (silent MP4 + any legacy frames), then the doc.
    try {
      await bucket.file(`${STORAGE_PREFIX}/${id}.mp4`).delete({ ignoreNotFound: true });
    } catch (e) {
      console.warn(`Storage prune (video) failed for ${id}:`, e.message);
    }
    try {
      await bucket.deleteFiles({ prefix: `${LEGACY_FRAME_PREFIX}/${id}/` });
    } catch (e) {
      console.warn(`Storage prune (frames) failed for ${id}:`, e.message);
    }
    await docSnap.ref.delete();
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// HTTPS: list the current library. Client calls this at Scene entry.
exports.listSceneClips = onRequest(
  { cors: true, region: "us-central1", memory: "256MiB" },
  async (req, res) => {
    try {
      const snap = await db.collection(COLLECTION).get();
      const byCategory = { nature: [], skyline: [] };
      for (const docSnap of snap.docs) {
        const d = docSnap.data();
        if (byCategory[d.category]) byCategory[d.category].push({
          id: d.id, kind: d.kind || "frames", videoUrl: d.videoUrl || "",
          frames: d.frames || [], fps: d.fps || FPS,
        });
      }
      res.set("Cache-Control", "public, max-age=300"); // 5 min CDN cache; clients keep their own
      res.json({ fps: FPS, categories: byCategory });
    } catch (err) {
      console.error("listSceneClips failed", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

// HTTPS: on-demand conversion (for manual testing). Production traffic should
// hit listSceneClips and use the scheduled library instead.
exports.convertSceneClip = onRequest(
  { cors: true, timeoutSeconds: 540, memory: "1GiB", region: "us-central1" },
  async (req, res) => {
    const url = (req.body && req.body.url) || req.query.url;
    const category = (req.body && req.body.category) || req.query.category || "nature";
    if (!url || typeof url !== "string" || !url.startsWith("http")) {
      return res.status(400).json({ error: "Body { url, category? } required." });
    }
    try {
      const bucket = admin.storage().bucket();
      const out = await convertOneClip(url, category, bucket);
      res.json(out);
    } catch (err) {
      console.error("convertSceneClip failed", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

// Core refresh routine shared by the weekly schedule and the manual trigger:
// fetch fresh Pexels sources per category, convert each to a silent MP4, then
// prune any clips no longer in the current set.
async function runSceneRefresh(key) {
  if (!key) throw new Error("PEXELS_KEY secret not configured");
  const bucket = admin.storage().bucket();
  const idsByCategory = {};
  for (const category of Object.keys(CATEGORIES)) {
    const sources = await fetchPexelsClips(category, key, TARGET_PER_CATEGORY);
    idsByCategory[category] = [];
    for (const source of sources) {
      try {
        const { id } = await convertOneClip(source, category, bucket);
        idsByCategory[category].push(id);
      } catch (err) {
        console.warn(`Clip failed (${category}): ${source.link}`, err.message);
      }
    }
  }
  await pruneObsolete(idsByCategory);
  console.log("Scene library refreshed:", idsByCategory);
  return idsByCategory;
}

// Scheduled (weekly): refresh the library. Runs ~Monday 03:00 UTC to keep
// invocations off the live-traffic windows.
exports.refreshSceneLibrary = onSchedule(
  {
    schedule: "0 3 * * 1",
    timeZone: "UTC",
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [PEXELS_KEY],
  },
  async () => {
    await runSceneRefresh(PEXELS_KEY.value());
  }
);
