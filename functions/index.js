// Spotify TV PWA — Scene library (Cloud Functions).
//
// Why this exists: VIDAA OS pauses other media whenever ANY <video> decoder
// engages. Audio-stripping doesn't help (we tried). The only workaround that
// can keep Spotify playing while a "scene" plays is to NOT use a <video>
// element — instead we render a JPG image sequence on the client.
//
// To keep the system inside Firebase's free tier we don't transcode on demand.
// Instead a single scheduled function runs once a week, picks fresh Pexels
// clips, converts them to JPG sequences, and writes the metadata to Firestore.
// The client reads the current library list and animates client-side.
//
// Layout in Storage:    gs://<bucket>/scene-frames/<id>/frame_NNNN.jpg
// Metadata in Firestore: collection "sceneClips", doc id = <id>
//   { category, frames: [url...], fps, addedAt, sourceUrl }
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

const FPS = 10;
const WIDTH = 1024;
const JPEG_QUALITY = 6; // ffmpeg -q:v 2 (best) → 31 (worst); 6 is a good ambient sweet spot
const STORAGE_PREFIX = "scene-frames";
const COLLECTION = "sceneClips";

// How many clips to keep per category. The Scene UI cycles through them randomly.
const TARGET_PER_CATEGORY = 6;
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

async function extractFrames(inputPath, outPattern) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf", `fps=${FPS},scale=${WIDTH}:-2`,
        "-q:v", String(JPEG_QUALITY),
      ])
      .output(outPattern)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function convertOneClip(sourceUrl, category, bucket) {
  const id = deriveClipId(sourceUrl);
  const prefix = `${STORAGE_PREFIX}/${id}`;

  // Already converted — just (re-)write the Firestore doc so this clip stays
  // in the current week's library.
  const existing = await bucket.getFiles({ prefix });
  if (existing[0].length) {
    const frames = existing[0]
      .filter((f) => f.name.endsWith(".jpg"))
      .map((f) => publicUrl(bucket.name, f.name))
      .sort();
    await db.collection(COLLECTION).doc(id).set({
      id, category, frames, fps: FPS, sourceUrl,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { id, frames, cached: true };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `scene-${id}-`));
  try {
    const inputPath = path.join(tmpDir, "input.mp4");
    const outPattern = path.join(tmpDir, "frame_%04d.jpg");
    await downloadToTmp(sourceUrl, inputPath);
    await extractFrames(inputPath, outPattern);

    const frameFiles = (await fs.readdir(tmpDir))
      .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
      .sort();
    if (!frameFiles.length) throw new Error("ffmpeg produced no frames");

    const uploads = frameFiles.map(async (file) => {
      const localFile = path.join(tmpDir, file);
      const dest = `${prefix}/${file}`;
      await bucket.upload(localFile, {
        destination: dest,
        public: true,
        metadata: { contentType: "image/jpeg", cacheControl: "public, max-age=604800" },
      });
      return publicUrl(bucket.name, dest);
    });
    const frames = (await Promise.all(uploads)).sort();

    await db.collection(COLLECTION).doc(id).set({
      id, category, frames, fps: FPS, sourceUrl,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { id, frames, cached: false };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function fetchPexelsClips(category, key, limit) {
  // The Pexels Videos API returns ~portrait/landscape MP4s of varying sizes.
  // We pick the lowest-resolution landscape file per video to keep the
  // downstream transcode + storage small.
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", CATEGORIES[category] || category);
  url.searchParams.set("per_page", String(Math.max(limit * 2, 10)));
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("size", "medium");
  const resp = await fetch(url.toString(), { headers: { Authorization: key } });
  if (!resp.ok) throw new Error(`Pexels API ${resp.status}`);
  const data = await resp.json();
  const picks = [];
  for (const video of data.videos || []) {
    const file = (video.video_files || [])
      .filter((f) => f.file_type === "video/mp4" && f.width && f.width <= 1280)
      .sort((a, b) => a.width - b.width)[0];
    if (file && file.link) picks.push(file.link);
    if (picks.length >= limit) break;
  }
  return picks;
}

async function pruneObsolete(currentIdsByCategory) {
  // Drop sceneClips docs (and their Storage objects) that aren't in this week's
  // current set, so we don't accumulate storage forever.
  const bucket = admin.storage().bucket();
  const allDocs = await db.collection(COLLECTION).get();
  const keep = new Set();
  for (const ids of Object.values(currentIdsByCategory)) ids.forEach((id) => keep.add(id));
  for (const docSnap of allDocs.docs) {
    const id = docSnap.id;
    if (keep.has(id)) continue;
    // Delete frames in Storage, then the doc.
    try {
      await bucket.deleteFiles({ prefix: `${STORAGE_PREFIX}/${id}/` });
    } catch (e) {
      console.warn(`Storage prune failed for ${id}:`, e.message);
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
          id: d.id, frames: d.frames || [], fps: d.fps || FPS,
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
      res.json({ ...out, fps: FPS });
    } catch (err) {
      console.error("convertSceneClip failed", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

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
    const key = PEXELS_KEY.value();
    if (!key) throw new Error("PEXELS_KEY secret not configured");
    const bucket = admin.storage().bucket();
    const idsByCategory = {};
    for (const category of Object.keys(CATEGORIES)) {
      const sources = await fetchPexelsClips(category, key, TARGET_PER_CATEGORY);
      idsByCategory[category] = [];
      for (const sourceUrl of sources) {
        try {
          const { id } = await convertOneClip(sourceUrl, category, bucket);
          idsByCategory[category].push(id);
        } catch (err) {
          console.warn(`Clip failed (${category}): ${sourceUrl}`, err.message);
        }
      }
    }
    await pruneObsolete(idsByCategory);
    console.log("Scene library refreshed:", idsByCategory);
  }
);
