// =====================================================
// HAND-TRACKED RHYTHM GAME
// - Uses your glove sprite (gloves.png)
// - Uses song time instead of frame spawning
// - Builds a BPM-synced starter map for Clarity
// - Keeps targets / lanes easy to edit
// =====================================================

// -----------------------------
// GLOBALS
// -----------------------------
let video;
let handPose;
let hands = [];

let gloveImage;
let song;

let songStarted = false;
let songReady = false;
let songLoadError = false;

// -----------------------------
// HAND / GLOVE SMOOTHING
// Stronger anti-snap version
// -----------------------------
let smoothedHands = [];
let nextTrackedHandId = 0;

const SMOOTHING = {
  // General motion smoothing
  positionLerp: 0.10,
  angleLerp: 0.08,

  // Reject / damp sudden jumps
  maxJump: 70,
  teleportThreshold: 180,

  // Tiny motion deadzone
  deadzone: 2.0,

  // Matching logic
  matchDistance: 120,

  // If a hand disappears briefly, keep it alive for a few frames
  graceFrames: 10
};

// -----------------------------
// EDITABLE SONG / MAP SETTINGS
// -----------------------------
// These values are set up for the uploaded song as a starter synced chart.
// If you want tighter/manual mapping later, edit CHART_SECTIONS below.
const SONG_CONFIG = {
  audioFile: "Zedd - Clarity (feat. Foxes).mp3",
  bpm: 129.19921875,
  firstBeatTime: 1.555736961451247,
  approachTime: 1.35, // how early notes appear before hit time
};

// -----------------------------
// OSU-LIKE PLAYFIELD SETTINGS
// -----------------------------
// Every note gets its own position inside this playfield.
//
// This version:
// - uses more of the screen
// - prevents stacking
// - tries to preserve readable flow angles
// - allows larger jumps on wider beat gaps
// -----------------------------
const PLAYFIELD = {
  // Larger usable area than before
  left: 0.10,
  right: 0.90,
  top: 0.14,
  bottom: 0.86,

  // Keeps notes away from the very edges
  edgePadding: 52,

  // Base jump distances
  minJump: 110,
  maxJump: 320,

  // Prevent notes from landing too close to recent notes
  stackThreshold: 95,
  recentNotesToCheck: 6,

  // Flow behavior
  flowWeight: 0.78,           // higher = stronger tendency to continue direction
  angleJitter: 0.45,          // random variation added around flow angle
  reversalChance: 0.16,       // occasional reverse for variety
  perpendicularChance: 0.22,  // occasional side movement

  // Search attempts
  maxPositionTries: 80
};

// -----------------------------
// EDITABLE VISUAL SETTINGS
// -----------------------------
const VISUALS = {
  targetRadius: 72,
  beatRadius: 24,
  hitWindow: 0.22,      // seconds
  handRadius: 34,
  targetFlashFrames: 8,
  webcamAlpha: 70,

  // Reduced glove size from the previous version
  gloveSizeMultiplier: 1.35,

  // Toggle target labels on/off
  showTargetLabels: false,
};

// -----------------------------
// CHART SECTIONS
// -----------------------------
// Easy to edit.
// startBeat/endBeat = beat numbers
// step = 1 means every beat, 2 means every other beat, 0.5 = eighth notes
// lanes = repeating pattern of lanes
//
// Example:
// { startBeat: 32, endBeat: 48, step: 1, lanes: [0, 1, 2, 3] }
// -----------------------------
const CHART_SECTIONS = [
  // intro
  { startBeat: 2,   endBeat: 34,  step: 2,   lanes: [0, 1, 2, 3] },

  // build
  { startBeat: 34,  endBeat: 66,  step: 1,   lanes: [0, 2, 1, 3] },

  // busier section
  { startBeat: 66,  endBeat: 98,  step: 0.5, lanes: [0, 1, 3, 2, 1, 0, 2, 3] },

  // verse-like
  { startBeat: 98,  endBeat: 130, step: 1,   lanes: [0, 3, 1, 2] },

  // pre-drop build
  { startBeat: 130, endBeat: 162, step: 0.5, lanes: [0, 1, 0, 2, 3, 2, 1, 3] },

  // chorus/drop
  { startBeat: 162, endBeat: 226, step: 0.5, lanes: [0, 1, 2, 3, 1, 0, 3, 2] },

  // short breath
  { startBeat: 226, endBeat: 258, step: 1,   lanes: [0, 2, 1, 3] },

  // final bigger section
  { startBeat: 258, endBeat: 386, step: 0.5, lanes: [0, 3, 1, 2, 0, 1, 2, 3] },

  // outro
  { startBeat: 386, endBeat: 450, step: 2,   lanes: [0, 1, 2, 3] },
];

// -----------------------------
// GAME STATE
// -----------------------------
let targets = [];
let beatMap = [];
let score = 0;
let combo = 0;
let maxCombo = 0;

let lastHitMessage = "";
let lastHitTimer = 0;
let targetFlashTimers = [0, 0, 0, 0];

// =====================================================
// PRELOAD
// =====================================================
function preload() {
  handPose = ml5.handPose({ flipped: true });

  // Load glove sprite made by you
  gloveImage = loadImage(
    "gloves.png",
    () => console.log("gloves.png loaded"),
    (err) => console.warn("Could not load gloves.png:", err)
  );

  // Load song
  song = loadSound(
    SONG_CONFIG.audioFile,
    () => {
      console.log("Song loaded");
      songReady = true;
    },
    (err) => {
      console.error("Song failed to load:", err);
      songLoadError = true;
    }
  );
}

// =====================================================
// HAND TRACKING CALLBACK
// =====================================================
function gotHands(results) {
  hands = results;
}

// =====================================================
// SETUP
// =====================================================
function setup() {
  createCanvas(windowWidth, windowHeight);

  video = createCapture(VIDEO, { flipped: true });
  video.size(windowWidth, windowHeight);
  video.hide();

  handPose.detectStart(video, gotHands);

  setupTargets();
  buildBeatMap();
}

// =====================================================
// SETUP TARGET CONTAINER
// With free-position notes, this stays empty.
// Each note stores its own x/y target.
// =====================================================
function setupTargets() {
  targets = [];
}

// =====================================================
// PLAYFIELD HELPERS
// =====================================================
function getPlayfieldBounds() {
  return {
    left: width * PLAYFIELD.left + PLAYFIELD.edgePadding,
    right: width * PLAYFIELD.right - PLAYFIELD.edgePadding,
    top: height * PLAYFIELD.top + PLAYFIELD.edgePadding,
    bottom: height * PLAYFIELD.bottom - PLAYFIELD.edgePadding
  };
}

function randomPlayfieldPosition() {
  let bounds = getPlayfieldBounds();

  return {
    x: random(bounds.left, bounds.right),
    y: random(bounds.top, bounds.bottom)
  };
}

function randomPositionNearPrevious(previousPos) {
  let bounds = getPlayfieldBounds();

  for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
    let angle = random(TWO_PI);
    let distance = random(PLAYFIELD.minJump, PLAYFIELD.maxJump);

    let x = previousPos.x + cos(angle) * distance;
    let y = previousPos.y + sin(angle) * distance;

    if (
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    ) {
      return { x, y };
    }
  }

  // Fallback if no good jump was found
  return randomPlayfieldPosition();
}

function generateNotePosition(previousNote, beatGap) {
  // First note starts somewhere inside the playfield
  if (!previousNote) {
    return randomPlayfieldPosition();
  }

  // Smaller beat gaps -> shorter jumps
  // Larger beat gaps -> allow larger jumps
  let originalMin = PLAYFIELD.minJump;
  let originalMax = PLAYFIELD.maxJump;

  let dynamicMin = originalMin;
  let dynamicMax = originalMax;

  if (beatGap <= 0.5) {
    dynamicMin = 55;
    dynamicMax = 150;
  } else if (beatGap <= 1) {
    dynamicMin = 80;
    dynamicMax = 210;
  } else {
    dynamicMin = 120;
    dynamicMax = 280;
  }

  let bounds = getPlayfieldBounds();

  for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
    let angle = random(TWO_PI);
    let distance = random(dynamicMin, dynamicMax);

    let x = previousNote.x + cos(angle) * distance;
    let y = previousNote.y + sin(angle) * distance;

    if (
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    ) {
      return { x, y };
    }
  }

  return randomPlayfieldPosition();
}

// =====================================================
// PLAYFIELD HELPERS
// =====================================================
function getPlayfieldBounds() {
  return {
    left: width * PLAYFIELD.left + PLAYFIELD.edgePadding,
    right: width * PLAYFIELD.right - PLAYFIELD.edgePadding,
    top: height * PLAYFIELD.top + PLAYFIELD.edgePadding,
    bottom: height * PLAYFIELD.bottom - PLAYFIELD.edgePadding
  };
}

function randomPlayfieldPosition() {
  let bounds = getPlayfieldBounds();

  return {
    x: random(bounds.left, bounds.right),
    y: random(bounds.top, bounds.bottom)
  };
}

function isTooCloseToRecentNotes(candidate, placedNotes) {
  let startIndex = max(0, placedNotes.length - PLAYFIELD.recentNotesToCheck);

  for (let i = startIndex; i < placedNotes.length; i++) {
    let n = placedNotes[i];
    let d = dist(candidate.x, candidate.y, n.x, n.y);

    if (d < PLAYFIELD.stackThreshold) {
      return true;
    }
  }

  return false;
}

function clampToPlayfield(pos) {
  let bounds = getPlayfieldBounds();

  return {
    x: constrain(pos.x, bounds.left, bounds.right),
    y: constrain(pos.y, bounds.top, bounds.bottom)
  };
}

function getDynamicJumpRange(beatGap) {
  // Faster rhythms = shorter spacing
  // Slower rhythms = bigger jumps
  if (beatGap <= 0.5) {
    return { min: 70, max: 150 };
  } else if (beatGap <= 1.0) {
    return { min: 100, max: 230 };
  } else if (beatGap <= 2.0) {
    return { min: 150, max: 310 };
  } else {
    return { min: 180, max: 360 };
  }
}

function getPreferredAngle(previousNotes) {
  // If fewer than 2 notes exist, choose a random angle
  if (previousNotes.length < 2) {
    return random(TWO_PI);
  }

  let a = previousNotes[previousNotes.length - 2];
  let b = previousNotes[previousNotes.length - 1];

  // Base direction = continue the previous movement direction
  let baseAngle = atan2(b.y - a.y, b.x - a.x);

  // Sometimes reverse or move perpendicular for variety
  let r = random();

  if (r < PLAYFIELD.reversalChance) {
    baseAngle += PI;
  } else if (r < PLAYFIELD.reversalChance + PLAYFIELD.perpendicularChance) {
    baseAngle += random() < 0.5 ? HALF_PI : -HALF_PI;
  }

  // Add small angle noise so it doesn't feel robotic
  baseAngle += random(-PLAYFIELD.angleJitter, PLAYFIELD.angleJitter);

  return baseAngle;
}

function generateFlowPosition(previousNotes, beatGap) {
  let jumpRange = getDynamicJumpRange(beatGap);
  let bounds = getPlayfieldBounds();

  // First note
  if (previousNotes.length === 0) {
    return randomPlayfieldPosition();
  }

  // Second note: random but not too close
  if (previousNotes.length === 1) {
    let prev = previousNotes[0];

    for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
      let angle = random(TWO_PI);
      let distance = random(jumpRange.min, jumpRange.max);

      let candidate = {
        x: prev.x + cos(angle) * distance,
        y: prev.y + sin(angle) * distance
      };

      candidate = clampToPlayfield(candidate);

      if (!isTooCloseToRecentNotes(candidate, previousNotes)) {
        return candidate;
      }
    }

    return randomPlayfieldPosition();
  }

  // Third+ notes: use flow-based angle generation
  let prev = previousNotes[previousNotes.length - 1];
  let preferredAngle = getPreferredAngle(previousNotes);

  for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
    // Blend between continuing flow and a fresh random angle
    let randomAngle = random(TWO_PI);
    let useFlow = random() < PLAYFIELD.flowWeight;
    let angle = useFlow ? preferredAngle : randomAngle;

    let distance = random(jumpRange.min, jumpRange.max);

    let candidate = {
      x: prev.x + cos(angle) * distance,
      y: prev.y + sin(angle) * distance
    };

    // Reject if outside playfield
    if (
      candidate.x < bounds.left ||
      candidate.x > bounds.right ||
      candidate.y < bounds.top ||
      candidate.y > bounds.bottom
    ) {
      continue;
    }

    // Reject stacked notes
    if (isTooCloseToRecentNotes(candidate, previousNotes)) {
      continue;
    }

    return candidate;
  }

  // Fallback
  for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
    let candidate = randomPlayfieldPosition();

    if (!isTooCloseToRecentNotes(candidate, previousNotes)) {
      return candidate;
    }
  }

  return randomPlayfieldPosition();
}

// =====================================================
// BUILD BPM-SYNCED MAP WITH:
// - larger playfield
// - note stacking prevention
// - angle-flow logic
// - varied spawn origins
// =====================================================
function buildBeatMap() {
  beatMap = [];

  let placedNotes = [];
  let previousBeat = null;

  for (let section of CHART_SECTIONS) {
    for (let beat = section.startBeat; beat <= section.endBeat; beat += section.step) {
      let hitTime = beatToTime(beat);

      let beatGap = previousBeat === null ? section.step : beat - previousBeat;

      // Generate note target position with flow + anti-stack logic
      let pos = generateFlowPosition(placedNotes, beatGap);

      let previousPlaced = placedNotes.length > 0
        ? placedNotes[placedNotes.length - 1]
        : null;

      // Generate note spawn position
      let spawn = getSpawnPointForNote(pos, previousPlaced);

      let note = {
        time: hitTime,
        x: pos.x,
        y: pos.y,
        spawnX: spawn.x,
        spawnY: spawn.y,
        judged: false,
        result: null
      };

      beatMap.push(note);
      placedNotes.push(note);
      previousBeat = beat;
    }
  }

  beatMap.sort((a, b) => a.time - b.time);
}

// =====================================================
// HELPERS
// =====================================================
function beatToTime(beatNumber) {
  return SONG_CONFIG.firstBeatTime + (beatNumber * 60) / SONG_CONFIG.bpm;
}

function getCurrentSongTime() {
  if (!songStarted) return 0;
  return song.currentTime();
}

// =====================================================
// SPAWN ORIGIN HELPERS
// =====================================================
function getSpawnPointForNote(note, previousNote) {
  // Different notes can spawn from different directions.
  // We bias the spawn origin so the note appears to travel
  // toward its hit position from outside / around the playfield.

  let bounds = getPlayfieldBounds();

  // If there is no previous note, spawn from center-ish
  if (!previousNote) {
    return {
      x: width / 2,
      y: height / 2
    };
  }

  // Use the direction from previous note -> current note
  let angle = atan2(note.y - previousNote.y, note.x - previousNote.x);

  // Spawn from the opposite direction so the note travels inward
  let spawnDistance = max(width, height) * 0.22;
  let spawnAngle = angle + PI;

  let sx = note.x + cos(spawnAngle) * spawnDistance;
  let sy = note.y + sin(spawnAngle) * spawnDistance;

  // Add some randomness so every note doesn't feel identical
  sx += random(-40, 40);
  sy += random(-40, 40);

  // Clamp spawn point slightly outside / near screen edges
  sx = constrain(sx, -120, width + 120);
  sy = constrain(sy, -120, height + 120);

  return { x: sx, y: sy };
}

// =====================================================
// RESIZE
// =====================================================
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  video.size(windowWidth, windowHeight);
  setupTargets();
}

// =====================================================
// MAIN DRAW LOOP
// =====================================================
function draw() {
  background(12);

  drawTargets();

  if (!songStarted) {
    drawHands();
    drawStartScreen();
    updateTimers();
    return;
  }

  let currentTime = getCurrentSongTime();

  judgeMisses(currentTime);
  drawBeats(currentTime);
  checkHits(currentTime);
  drawHands();
  drawUI(currentTime);
  updateTimers();
}

// =====================================================
// START / PAUSE
// =====================================================
async function mousePressed() {
  await toggleSongPlayback();
}

async function keyPressed() {
  if (key === " " || keyCode === 32) {
    await toggleSongPlayback();
    return false;
  }
}

async function toggleSongPlayback() {
  try {
    await userStartAudio();

    if (!songReady) {
      console.warn("Song is not ready yet.");
      return;
    }

    if (!songStarted) {
      song.play();
      songStarted = true;
      return;
    }

    if (song.isPlaying()) {
      song.pause();
    } else {
      song.play();
    }
  } catch (err) {
    console.error("Audio start failed:", err);
  }
}

// =====================================================
// MISS CHECK
// =====================================================
function judgeMisses(currentTime) {
  for (let note of beatMap) {
    if (note.judged) continue;

    if (currentTime > note.time + VISUALS.hitWindow) {
      note.judged = true;
      note.result = "miss";
      combo = 0;
      lastHitMessage = "MISS";
      lastHitTimer = 18;
    }
  }
}

// =====================================================
// HIT CHECK
// Player must hover hand over the note's own target position
// within the timing window.
// =====================================================
function checkHits(currentTime) {
  let handPositions = getHandPositions();

  for (let note of beatMap) {
    if (note.judged) continue;

    let timeDiff = abs(currentTime - note.time);
    if (timeDiff > VISUALS.hitWindow) continue;

    for (let hp of handPositions) {
      let handToNote = dist(hp.x, hp.y, note.x, note.y);

      if (handToNote <= VISUALS.targetRadius * 0.78) {
        note.judged = true;
        note.result = "hit";

        score++;
        combo++;
        if (combo > maxCombo) maxCombo = combo;

        lastHitMessage = "HIT!";
        lastHitTimer = 12;
        break;
      }
    }
  }
}

// =====================================================
// GET HAND POSITIONS (ROBUST SMOOTHED TRACKING)
// - matches hands by nearest position, not array index
// - smooths palm center
// - smooths angle
// - heavily dampens snaps
// - keeps hands alive briefly during tracker flicker
// =====================================================
function getHandPositions() {
  let rawHands = [];

  // -----------------------------------
  // Build raw detections
  // -----------------------------------
  for (let hand of hands) {
    let wrist = hand.keypoints[0];
    let middleBase = hand.keypoints[9];

    let palmX = (wrist.x + middleBase.x) / 2;
    let palmY = (wrist.y + middleBase.y) / 2;

    let rawAngle = atan2(middleBase.y - wrist.y, middleBase.x - wrist.x);

    rawHands.push({
      x: palmX,
      y: palmY,
      angle: rawAngle,
      handedness: hand.handedness
    });
  }

  // Age existing smoothed hands
  for (let tracked of smoothedHands) {
    tracked.matched = false;
    tracked.missingFrames = (tracked.missingFrames || 0) + 1;
  }

  // -----------------------------------
  // Match raw detections to existing tracked hands
  // -----------------------------------
  for (let raw of rawHands) {
    let bestIndex = -1;
    let bestDist = Infinity;

    for (let i = 0; i < smoothedHands.length; i++) {
      let tracked = smoothedHands[i];
      if (tracked.matched) continue;

      let d = dist(raw.x, raw.y, tracked.x, tracked.y);
      if (d < bestDist && d < SMOOTHING.matchDistance) {
        bestDist = d;
        bestIndex = i;
      }
    }

    // No match -> create new tracked hand
    if (bestIndex === -1) {
      smoothedHands.push({
        id: nextTrackedHandId++,
        x: raw.x,
        y: raw.y,
        angle: raw.angle,
        handedness: raw.handedness,
        matched: true,
        missingFrames: 0
      });
      continue;
    }

    let tracked = smoothedHands[bestIndex];
    tracked.matched = true;
    tracked.missingFrames = 0;
    tracked.handedness = raw.handedness;

    // -----------------------------------
    // Deadzone to reduce tiny shimmer
    // -----------------------------------
    let dx = raw.x - tracked.x;
    let dy = raw.y - tracked.y;

    if (abs(dx) < SMOOTHING.deadzone) raw.x = tracked.x;
    if (abs(dy) < SMOOTHING.deadzone) raw.y = tracked.y;

    let jumpDist = dist(tracked.x, tracked.y, raw.x, raw.y);

    // -----------------------------------
    // Anti-snap position smoothing
    // -----------------------------------
    if (jumpDist > SMOOTHING.teleportThreshold) {
      // Tracker probably re-locked badly: barely move toward it
      tracked.x = lerp(tracked.x, raw.x, 0.03);
      tracked.y = lerp(tracked.y, raw.y, 0.03);
    } else if (jumpDist > SMOOTHING.maxJump) {
      // Large jump: heavy damping
      tracked.x = lerp(tracked.x, raw.x, 0.06);
      tracked.y = lerp(tracked.y, raw.y, 0.06);
    } else {
      // Normal smoothing
      tracked.x = lerp(tracked.x, raw.x, SMOOTHING.positionLerp);
      tracked.y = lerp(tracked.y, raw.y, SMOOTHING.positionLerp);
    }

    // -----------------------------------
    // Anti-snap angle smoothing
    // -----------------------------------
    let currentAngle = tracked.angle;
    let targetAngle = raw.angle;
    let delta = atan2(sin(targetAngle - currentAngle), cos(targetAngle - currentAngle));
    tracked.angle = currentAngle + delta * SMOOTHING.angleLerp;
  }

  // -----------------------------------
  // Keep unmatched hands alive briefly
  // so they do not vanish/reappear instantly
  // -----------------------------------
  smoothedHands = smoothedHands.filter(
    (tracked) => tracked.missingFrames <= SMOOTHING.graceFrames
  );

  return smoothedHands;
}

// =====================================================
// DRAW ACTIVE HIT ZONES
// - Only draws circles for notes currently in play
// - Uses each note's individual position
// =====================================================
function drawTargets() {
  let currentTime = getCurrentSongTime();

  for (let note of beatMap) {
    if (note.judged && note.result === "hit") continue;

    let timeUntilHit = note.time - currentTime;
    let timeSinceHit = currentTime - note.time;

    if (timeUntilHit > SONG_CONFIG.approachTime) continue;
    if (timeSinceHit > VISUALS.hitWindow) continue;

    push();

    if (!note.judged) {
      fill(80, 140, 255, 95);
    } else {
      fill(255, 80, 80, 90);
    }

    stroke(255);
    strokeWeight(3);
    circle(note.x, note.y, VISUALS.targetRadius * 2);

    noFill();
    stroke(255, 130);
    strokeWeight(2);
    circle(note.x, note.y, VISUALS.targetRadius * 1.45);

    pop();
  }
}

// =====================================================
// DRAW BPM-SYNCED NOTES
// - Each note moves from its own spawn origin
// - Travel stays synced to song time
// - Approach circle helps timing clarity
// =====================================================
function drawBeats(currentTime) {
  for (let note of beatMap) {
    if (note.judged && note.result === "hit") continue;

    let timeUntilHit = note.time - currentTime;
    let timeSinceHit = currentTime - note.time;

    if (timeUntilHit > SONG_CONFIG.approachTime) continue;
    if (timeSinceHit > VISUALS.hitWindow) continue;

    let progress = 1 - (timeUntilHit / SONG_CONFIG.approachTime);
    progress = constrain(progress, 0, 1);

    let x = lerp(note.spawnX, note.x, progress);
    let y = lerp(note.spawnY, note.y, progress);

    push();
    noStroke();
    fill(255, 210, 110);
    circle(x, y, VISUALS.beatRadius * 2);

    // Travel guide
    stroke(255, 45);
    line(x, y, note.x, note.y);

    // Approach ring
    noFill();
    stroke(255, 120);
    let ringSize = map(progress, 0, 1, VISUALS.beatRadius * 5, VISUALS.beatRadius * 2.2);
    circle(x, y, ringSize);

    pop();
  }
}

// =====================================================
// DRAW HANDS + GLOVE SPRITE
// - uses robust smoothed hand tracking
// - glove size stays constant relative to hit zone size
// =====================================================
function drawHands() {
  let trackedHands = getHandPositions();

  for (let hp of trackedHands) {
    push();
    noFill();
    stroke(255, 255, 0);
    strokeWeight(2);
    circle(hp.x, hp.y, VISUALS.handRadius * 2);
    pop();
  }

  for (let hp of trackedHands) {
    if (!gloveImage) continue;

    let desiredGloveHeight = VISUALS.targetRadius * 1.55;
    let scaleFactor = desiredGloveHeight / gloveImage.height;

    push();
    translate(hp.x, hp.y);
    rotate(hp.angle + HALF_PI);

    if (hp.handedness === "Right") {
      scale(-1, 1);
    }

    imageMode(CENTER);
    image(
      gloveImage,
      0,
      -desiredGloveHeight * 0.18,
      gloveImage.width * scaleFactor,
      gloveImage.height * scaleFactor
    );
    pop();
  }
}

// =====================================================
// UI
// =====================================================
function drawUI(currentTime) {
  push();
  fill(255);
  textAlign(LEFT, TOP);
  textSize(26);
  text("Score: " + score, 20, 20);
  text("Combo: " + combo, 20, 54);

  textSize(15);
  text("Time: " + currentTime.toFixed(2), 20, 88);
  text("Notes: " + beatMap.length, 20, 108);

  if (lastHitTimer > 0) {
    textAlign(CENTER, CENTER);
    textSize(40);

    if (lastHitMessage === "HIT!") fill(80, 255, 120);
    else fill(255, 80, 80);

    text(lastHitMessage, width / 2, 50);
  }
  pop();
}

// =====================================================
// START SCREEN
// =====================================================
function drawStartScreen() {
  push();
  textAlign(CENTER, CENTER);

  fill(255);
  textSize(34);
  text("CLICK OR PRESS SPACE TO START", width / 2, height / 2 - 20);

  textSize(18);

  if (songLoadError) {
    fill(255, 120, 120);
    text("Song failed to load. Check the mp3 filename.", width / 2, height / 2 + 28);
  } else if (!songReady) {
    fill(220);
    text("Loading song...", width / 2, height / 2 + 28);
  } else {
    fill(200);
    text("Glove sprite + synced chart ready", width / 2, height / 2 + 28);
  }

  pop();
}

// =====================================================
// TIMERS
// =====================================================
function updateTimers() {
  if (lastHitTimer > 0) lastHitTimer--;

  for (let i = 0; i < targetFlashTimers.length; i++) {
    if (targetFlashTimers[i] > 0) targetFlashTimers[i]--;
  }
}