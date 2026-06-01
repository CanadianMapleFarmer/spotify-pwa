#!/usr/bin/env bash
#
# Spotify TV PWA — one-shot setup for the Scene image-sequence backend.
#
# CLI can NOT do these two things first — handle them in the Firebase console
# before running this script:
#   1. Upgrade the project to the Blaze plan (Firebase requires a payment
#      method; the free tier still applies for usage). Console → Upgrade.
#   2. Enable Storage (Console → Build → Storage → Get started). Pick the
#      default us-central1 location. The first-time bucket creation runs a
#      console wizard the CLI can't replicate.
#
# Once those are done, run this script from the repo root. It will:
#   - Install function dependencies (`functions/`)
#   - Ensure the required Google Cloud APIs are enabled (best-effort, via gcloud)
#   - Prompt for and store the PEXELS_KEY secret used by the scheduled job
#   - Deploy Firestore rules, Storage rules, and all Cloud Functions
#   - Optionally trigger the first refreshSceneLibrary run on demand

set -euo pipefail

# --- preflight --------------------------------------------------------------

if ! command -v firebase >/dev/null 2>&1; then
  echo "✗ firebase CLI not found. Install: npm i -g firebase-tools" >&2
  exit 1
fi

if [[ ! -d functions ]]; then
  echo "✗ Run this from the repo root (no ./functions directory found)." >&2
  exit 1
fi

PROJECT_ID="$(firebase use 2>/dev/null | awk '/Active Project/ { print $NF }')"
if [[ -z "${PROJECT_ID:-}" ]]; then
  PROJECT_ID="$(grep -o '"default": "[^"]*"' .firebaserc | head -1 | cut -d'"' -f4)"
fi
echo "→ Firebase project: ${PROJECT_ID:-<unknown>}"

# --- 1. function deps -------------------------------------------------------

echo "→ Installing function dependencies…"
(cd functions && npm install --silent)

# --- 2. enable required APIs (best-effort, needs gcloud + Blaze) ------------

if command -v gcloud >/dev/null 2>&1 && [[ -n "${PROJECT_ID:-}" ]]; then
  echo "→ Enabling required Google Cloud APIs via gcloud…"
  gcloud services enable \
    cloudfunctions.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    cloudscheduler.googleapis.com \
    pubsub.googleapis.com \
    secretmanager.googleapis.com \
    eventarc.googleapis.com \
    run.googleapis.com \
    --project="$PROJECT_ID" 2>/dev/null || {
      echo "  (gcloud failed — Firebase deploy will enable APIs on first push anyway.)"
    }
else
  echo "↷ gcloud not installed; skipping API enable. Firebase will prompt on deploy."
fi

# --- 3. Pexels API key secret ----------------------------------------------

echo "→ Checking PEXELS_KEY secret…"
if firebase functions:secrets:access PEXELS_KEY --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  PEXELS_KEY already set."
  read -r -p "  Re-enter to overwrite? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    firebase functions:secrets:set PEXELS_KEY --project "$PROJECT_ID"
  fi
else
  echo "  Setting PEXELS_KEY (paste your Pexels API key when prompted)…"
  firebase functions:secrets:set PEXELS_KEY --project "$PROJECT_ID"
fi

# --- 4. deploy --------------------------------------------------------------

echo "→ Deploying Firestore rules, Storage rules, and Functions…"
firebase deploy --only firestore:rules,storage,functions --project "$PROJECT_ID"

# --- 5. optional first refresh ---------------------------------------------

echo ""
read -r -p "Trigger the first refreshSceneLibrary run now? [Y/n] " yn
if [[ ! "$yn" =~ ^[Nn]$ ]]; then
  if command -v gcloud >/dev/null 2>&1; then
    echo "→ Invoking refreshSceneLibrary via gcloud (this can take several minutes)…"
    gcloud functions call refreshSceneLibrary \
      --project="$PROJECT_ID" --region=us-central1 --gen2 2>/dev/null || {
        echo "  gcloud call failed. Trigger manually in the Cloud Console:"
        echo "  https://console.cloud.google.com/functions/details/us-central1/refreshSceneLibrary?project=$PROJECT_ID"
      }
  else
    echo "  gcloud not installed — trigger manually:"
    echo "  https://console.cloud.google.com/functions/details/us-central1/refreshSceneLibrary?project=$PROJECT_ID"
  fi
fi

echo ""
echo "✓ Setup complete."
echo "  On the TV: Settings → Scene playback → Image-sequence Scene mode → On"
