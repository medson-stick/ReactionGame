// =====================================================
// HAND-TRACKED RHYTHM GAME
// - Uses your glove sprite (gloves.png)
// - Uses song time instead of frame spawning
// - Builds a BPM-synced starter map for Clarity
// - Improved hand tracking stability with:
//   * multi-point palm averaging
//   * adaptive smoothing
//   * separate visual / gameplay cursors
//   * jump rejection with velocity guard
//   * simple hysteresis for hit testing
// =====================================================

// -----------------------------
// GLOBALS
// -----------------------------
let video;
let handPose;
let hands = [];

let gloveImage;
let hitZoneImage;
let indicatorImage;
let boardImage;
let song;

let songStarted = false;
let songReady = false;
let songLoadError = false;

// -----------------------------
// HAND / GLOVE SMOOTHING
// -----------------------------
let trackedHands = [];
let nextTrackedHandId = 0;

const TRACKING = {
  // Matching / lifecycle
  matchDistance: 130,
  graceFrames: 12,

  // Palm construction
  palmPointIds: [0, 5, 9, 13, 17],

  // Deadzone against tiny shimmer
  deadzone: 1.5,

  // Reject or heavily damp implausible jumps
  maxReasonableJump: 95,
  teleportThreshold: 220,
  velocityRejectionMultiplier: 3.2,
  minVelocityAllowance: 20,

  // Angle smoothing
  visualAngleLerp: 0.14,
  hitAngleLerp: 0.22,

  // Visual smoothing is stronger than gameplay smoothing
  visualLerpSlow: 0.08,
  visualLerpMedium: 0.14,
  visualLerpFast: 0.22,
  visualLerpVeryFast: 0.30,

  hitLerpSlow: 0.14,
  hitLerpMedium: 0.22,
  hitLerpFast: 0.34,
  hitLerpVeryFast: 0.46,

  // If a detection is briefly rejected, keep old state
  maxRejectedFramesBeforeSnap: 8,
};

// -----------------------------
// EDITABLE SONG / MAP SETTINGS
// -----------------------------
const SONG_CONFIG = {
  audioFile: "Zedd - Clarity (feat. Foxes).mp3",
  bpm: 129.19921875,
  firstBeatTime: 1.555736961451247,
  approachTime: 1.35,
};

// -----------------------------
// OSU-LIKE PLAYFIELD SETTINGS
// -----------------------------
const PLAYFIELD = {
  left: 0.10,
  right: 0.90,
  top: 0.14,
  bottom: 0.86,
  edgePadding: 52,
  minJump: 110,
  maxJump: 320,
  stackThreshold: 95,
  recentNotesToCheck: 6,
  flowWeight: 0.78,
  angleJitter: 0.45,
  reversalChance: 0.16,
  perpendicularChance: 0.22,
  maxPositionTries: 80
};

// -----------------------------
// EDITABLE VISUAL SETTINGS
// -----------------------------
const VISUALS = {
  targetRadius: 72,
  beatRadius: 24,
  hitWindow: 0.22,
  handRadius: 34,
  targetFlashFrames: 8,
  webcamAlpha: 70,
  gloveSizeMultiplier: 1.35,
  showTargetLabels: false,

  // Hysteresis for stable hover behavior
  hitEnterRadiusMultiplier: 0.76,
  hitExitRadiusMultiplier: 0.92,

  // Debug helpers
  showHandDebug: true,
  showVideoFeed: false,
};

// -----------------------------
// CHART SECTIONS
// -----------------------------
const CHART_SECTIONS = [
  { startBeat: 2,   endBeat: 34,  step: 2,   lanes: [0, 1, 2, 3] },
  { startBeat: 34,  endBeat: 66,  step: 1,   lanes: [0, 2, 1, 3] },
  { startBeat: 66,  endBeat: 98,  step: 0.5, lanes: [0, 1, 3, 2, 1, 0, 2, 3] },
  { startBeat: 98,  endBeat: 130, step: 1,   lanes: [0, 3, 1, 2] },
  { startBeat: 130, endBeat: 162, step: 0.5, lanes: [0, 1, 0, 2, 3, 2, 1, 3] },
  { startBeat: 162, endBeat: 226, step: 0.5, lanes: [0, 1, 2, 3, 1, 0, 3, 2] },
  { startBeat: 226, endBeat: 258, step: 1,   lanes: [0, 2, 1, 3] },
  { startBeat: 258, endBeat: 386, step: 0.5, lanes: [0, 3, 1, 2, 0, 1, 2, 3] },
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
let comboPulseTimer = 0;

// =====================================================
// PRELOAD
// =====================================================
let gameFont;

function preload() {
  handPose = ml5.handPose({ flipped: true });

  gloveImage = loadImage(
    "gloves.png",
    () => console.log("gloves.png loaded"),
    (err) => console.warn("Could not load gloves.png:", err)
  );

  hitZoneImage = loadImage(
    "hitZone.png",
    () => console.log("hitZone.png loaded"),
    (err) => console.warn("Could not load hitZone.png:", err)
  );

  indicatorImage = loadImage(
    "indicator.png",
    () => console.log("indicator.png loaded"),
    (err) => console.warn("Could not load indicator.png:", err)
  );

  boardImage = loadImage(
    "board.png",
    () => console.log("board.png loaded"),
    (err) => console.warn("Could not load board.png:", err)
  );

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

  // Lower camera resolution often improves tracking stability / FPS.
  // The model still maps correctly because its output is already in the
  // displayed video coordinate space.
  video.size(640, 480);
  video.hide();

  handPose.detectStart(video, gotHands);

  setupTargets();
  buildBeatMap();
}

// =====================================================
// SETUP TARGET CONTAINER
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
  if (previousNotes.length < 2) {
    return random(TWO_PI);
  }

  let a = previousNotes[previousNotes.length - 2];
  let b = previousNotes[previousNotes.length - 1];
  let baseAngle = atan2(b.y - a.y, b.x - a.x);
  let r = random();

  if (r < PLAYFIELD.reversalChance) {
    baseAngle += PI;
  } else if (r < PLAYFIELD.reversalChance + PLAYFIELD.perpendicularChance) {
    baseAngle += random() < 0.5 ? HALF_PI : -HALF_PI;
  }

  baseAngle += random(-PLAYFIELD.angleJitter, PLAYFIELD.angleJitter);
  return baseAngle;
}

function generateFlowPosition(previousNotes, beatGap) {
  let jumpRange = getDynamicJumpRange(beatGap);
  let bounds = getPlayfieldBounds();

  if (previousNotes.length === 0) {
    return randomPlayfieldPosition();
  }

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

  let prev = previousNotes[previousNotes.length - 1];
  let preferredAngle = getPreferredAngle(previousNotes);

  for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
    let randomAngle = random(TWO_PI);
    let useFlow = random() < PLAYFIELD.flowWeight;
    let angle = useFlow ? preferredAngle : randomAngle;
    let distance = random(jumpRange.min, jumpRange.max);

    let candidate = {
      x: prev.x + cos(angle) * distance,
      y: prev.y + sin(angle) * distance
    };

    if (
      candidate.x < bounds.left ||
      candidate.x > bounds.right ||
      candidate.y < bounds.top ||
      candidate.y > bounds.bottom
    ) {
      continue;
    }

    if (isTooCloseToRecentNotes(candidate, previousNotes)) {
      continue;
    }

    return candidate;
  }

  for (let i = 0; i < PLAYFIELD.maxPositionTries; i++) {
    let candidate = randomPlayfieldPosition();

    if (!isTooCloseToRecentNotes(candidate, previousNotes)) {
      return candidate;
    }
  }

  return randomPlayfieldPosition();
}

// =====================================================
// BUILD BPM-SYNCED MAP
// =====================================================
function buildBeatMap() {
  beatMap = [];

  let placedNotes = [];
  let previousBeat = null;

  for (let section of CHART_SECTIONS) {
    for (let beat = section.startBeat; beat <= section.endBeat; beat += section.step) {
      let hitTime = beatToTime(beat);
      let beatGap = previousBeat === null ? section.step : beat - previousBeat;
      let pos = generateFlowPosition(placedNotes, beatGap);

      let previousPlaced = placedNotes.length > 0
        ? placedNotes[placedNotes.length - 1]
        : null;

      let spawn = getSpawnPointForNote(pos, previousPlaced);

      let note = {
        time: hitTime,
        x: pos.x,
        y: pos.y,
        spawnX: spawn.x,
        spawnY: spawn.y,
        judged: false,
        result: null,
        hoveredBy: new Set()
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
  if (!previousNote) {
    return {
      x: width / 2,
      y: height / 2
    };
  }

  let angle = atan2(note.y - previousNote.y, note.x - previousNote.x);
  let spawnDistance = max(width, height) * 0.22;
  let spawnAngle = angle + PI;

  let sx = note.x + cos(spawnAngle) * spawnDistance;
  let sy = note.y + sin(spawnAngle) * spawnDistance;

  sx += random(-40, 40);
  sy += random(-40, 40);

  sx = constrain(sx, -120, width + 120);
  sy = constrain(sy, -120, height + 120);

  return { x: sx, y: sy };
}

// =====================================================
// RESIZE
// =====================================================
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  setupTargets();
}

// =====================================================
// MAIN DRAW LOOP
// =====================================================
function draw() {
  background(12);

  if (VISUALS.showVideoFeed) {
    push();
    tint(255, VISUALS.webcamAlpha);
    image(video, 0, 0, width, height);
    pop();
  }

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
// Uses hit cursor, not visual cursor, and hysteresis so a hand
// doesn't rapidly flicker in/out near the circle edge.
// =====================================================
function checkHits(currentTime) {
  let handPositions = getHandPositions();
  let enterRadius = VISUALS.targetRadius * VISUALS.hitEnterRadiusMultiplier;
  let exitRadius = VISUALS.targetRadius * VISUALS.hitExitRadiusMultiplier;

  for (let note of beatMap) {
    if (note.judged) continue;

    let timeDiff = abs(currentTime - note.time);
    if (timeDiff > VISUALS.hitWindow) continue;

    for (let hp of handPositions) {
      let handToNote = dist(hp.hitX, hp.hitY, note.x, note.y);
      let isHovering = note.hoveredBy.has(hp.id);
      let threshold = isHovering ? exitRadius : enterRadius;

      if (handToNote <= threshold) {
        note.hoveredBy.add(hp.id);
      } else {
        note.hoveredBy.delete(hp.id);
      }

      if (note.hoveredBy.has(hp.id)) {
        note.judged = true;
        note.result = "hit";

        score++;
        combo++;
        comboPulseTimer = 12;

        if (combo > maxCombo) maxCombo = combo;

        lastHitMessage = "HIT!";
        lastHitTimer = 12;
        break;
      }
    }
  }
}

// =====================================================
// TRACKING HELPERS
// =====================================================
function getPalmCenter(hand) {
  let x = 0;
  let y = 0;

  for (let id of TRACKING.palmPointIds) {
    x += hand.keypoints[id].x;
    y += hand.keypoints[id].y;
  }

  return {
    x: x / TRACKING.palmPointIds.length,
    y: y / TRACKING.palmPointIds.length
  };
}

function getAdaptiveLerp(distanceMoved, mode = "visual") {
  const values = mode === "visual"
    ? [TRACKING.visualLerpSlow, TRACKING.visualLerpMedium, TRACKING.visualLerpFast, TRACKING.visualLerpVeryFast]
    : [TRACKING.hitLerpSlow, TRACKING.hitLerpMedium, TRACKING.hitLerpFast, TRACKING.hitLerpVeryFast];

  if (distanceMoved < 8) return values[0];
  if (distanceMoved < 24) return values[1];
  if (distanceMoved < 60) return values[2];
  return values[3];
}

function smoothAngle(currentAngle, targetAngle, amount) {
  let delta = atan2(sin(targetAngle - currentAngle), cos(targetAngle - currentAngle));
  return currentAngle + delta * amount;
}

function buildRawHands() {
  let rawHands = [];

  // HandPose keypoints come back in video-space.
  // Since the video is captured at 640x480 but the canvas is fullscreen,
  // map those coordinates into canvas-space before tracking.
  let scaleX = width / video.width;
  let scaleY = height / video.height;

  for (let hand of hands) {
    let palm = getPalmCenter(hand);
    let wrist = hand.keypoints[0];
    let middleBase = hand.keypoints[9];

    let palmX = palm.x * scaleX;
    let palmY = palm.y * scaleY;
    let wristX = wrist.x * scaleX;
    let wristY = wrist.y * scaleY;
    let middleX = middleBase.x * scaleX;
    let middleY = middleBase.y * scaleY;

    let rawAngle = atan2(middleY - wristY, middleX - wristX);
    let handSize = dist(wristX, wristY, middleX, middleY);

    rawHands.push({
      x: palmX,
      y: palmY,
      angle: rawAngle,
      handedness: hand.handedness,
      size: handSize
    });
  }

  return rawHands;
}

function matchRawToTracked(rawHands) {
  for (let tracked of trackedHands) {
    tracked.matched = false;
    tracked.missingFrames = (tracked.missingFrames || 0) + 1;
  }

  for (let raw of rawHands) {
    let bestIndex = -1;
    let bestDist = Infinity;

    for (let i = 0; i < trackedHands.length; i++) {
      let tracked = trackedHands[i];
      if (tracked.matched) continue;

      let d = dist(raw.x, raw.y, tracked.hitX, tracked.hitY);
      if (d < bestDist && d < TRACKING.matchDistance) {
        bestDist = d;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      trackedHands.push({
        id: nextTrackedHandId++,
        x: raw.x,
        y: raw.y,
        visualX: raw.x,
        visualY: raw.y,
        hitX: raw.x,
        hitY: raw.y,
        angle: raw.angle,
        visualAngle: raw.angle,
        hitAngle: raw.angle,
        handedness: raw.handedness,
        size: raw.size,
        velocityX: 0,
        velocityY: 0,
        matched: true,
        missingFrames: 0,
        rejectedFrames: 0
      });
      continue;
    }

    updateTrackedHand(trackedHands[bestIndex], raw);
  }

  trackedHands = trackedHands.filter(
    (tracked) => tracked.missingFrames <= TRACKING.graceFrames
  );
}

function updateTrackedHand(tracked, raw) {
  tracked.matched = true;
  tracked.missingFrames = 0;
  tracked.handedness = raw.handedness;

  let dx = raw.x - tracked.hitX;
  let dy = raw.y - tracked.hitY;

  if (abs(dx) < TRACKING.deadzone) raw.x = tracked.hitX;
  if (abs(dy) < TRACKING.deadzone) raw.y = tracked.hitY;

  let jumpDist = dist(tracked.hitX, tracked.hitY, raw.x, raw.y);
  let currentSpeed = dist(0, 0, tracked.velocityX, tracked.velocityY);
  let allowedJump = max(
    TRACKING.minVelocityAllowance,
    currentSpeed * TRACKING.velocityRejectionMultiplier + TRACKING.minVelocityAllowance
  );

  let rawLooksBad = false;

  if (jumpDist > TRACKING.teleportThreshold) {
    rawLooksBad = true;
  } else if (jumpDist > TRACKING.maxReasonableJump && jumpDist > allowedJump) {
    rawLooksBad = true;
  }

  if (rawLooksBad) {
    tracked.rejectedFrames = (tracked.rejectedFrames || 0) + 1;

    if (tracked.rejectedFrames > TRACKING.maxRejectedFramesBeforeSnap) {
      tracked.hitX = lerp(tracked.hitX, raw.x, 0.10);
      tracked.hitY = lerp(tracked.hitY, raw.y, 0.10);
      tracked.visualX = lerp(tracked.visualX, raw.x, 0.06);
      tracked.visualY = lerp(tracked.visualY, raw.y, 0.06);
    }

    tracked.hitAngle = smoothAngle(tracked.hitAngle, raw.angle, 0.10);
    tracked.visualAngle = smoothAngle(tracked.visualAngle, raw.angle, 0.07);
    return;
  }

  tracked.rejectedFrames = 0;

  let hitLerpAmount = getAdaptiveLerp(jumpDist, "hit");
  let visualLerpAmount = getAdaptiveLerp(jumpDist, "visual");

  let prevHitX = tracked.hitX;
  let prevHitY = tracked.hitY;

  tracked.hitX = lerp(tracked.hitX, raw.x, hitLerpAmount);
  tracked.hitY = lerp(tracked.hitY, raw.y, hitLerpAmount);

  tracked.visualX = lerp(tracked.visualX, raw.x, visualLerpAmount);
  tracked.visualY = lerp(tracked.visualY, raw.y, visualLerpAmount);

  tracked.velocityX = tracked.hitX - prevHitX;
  tracked.velocityY = tracked.hitY - prevHitY;

  tracked.hitAngle = smoothAngle(tracked.hitAngle, raw.angle, TRACKING.hitAngleLerp);
  tracked.visualAngle = smoothAngle(tracked.visualAngle, raw.angle, TRACKING.visualAngleLerp);

  tracked.x = tracked.visualX;
  tracked.y = tracked.visualY;
  tracked.angle = tracked.visualAngle;
  tracked.size = lerp(tracked.size || raw.size, raw.size, 0.16);
}

// =====================================================
// GET HAND POSITIONS
// =====================================================
function getHandPositions() {
  let rawHands = buildRawHands();
  matchRawToTracked(rawHands);
  return trackedHands;
}

// =====================================================
// DRAW ACTIVE HIT ZONES
// =====================================================
function drawTargets() {
  let currentTime = getCurrentSongTime();

  for (let note of beatMap) {
    if (note.judged && note.result === "hit") continue;

    let timeUntilHit = note.time - currentTime;
    let timeSinceHit = currentTime - note.time;

    if (timeUntilHit > SONG_CONFIG.approachTime) continue;
    if (timeSinceHit > VISUALS.hitWindow) continue;

    let approachProgress = 1 - (timeUntilHit / SONG_CONFIG.approachTime);
    approachProgress = constrain(approachProgress, 0, 1);

    let zoneAlpha = lerp(0, 255, approachProgress);

    if (note.judged && note.result === "miss") {
      zoneAlpha = 220;
    }

    if (hitZoneImage) {
      push();
      imageMode(CENTER);
      tint(255, zoneAlpha);
      image(
        hitZoneImage,
        note.x,
        note.y,
        VISUALS.targetRadius * 2.6,
        VISUALS.targetRadius * 2.6
      );
      noTint();
      pop();
    } else {
      push();
      fill(80, 140, 255, zoneAlpha);
      stroke(255, zoneAlpha);
      strokeWeight(3);
      circle(note.x, note.y, VISUALS.targetRadius * 2.6);
      pop();
    }
  }
}

// =====================================================
// DRAW BPM-SYNCED NOTES
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

    let indicatorAlpha = lerp(0, 255, progress);

    push();
    if (indicatorImage) {
      imageMode(CENTER);
      tint(255, indicatorAlpha);
      image(
        indicatorImage,
        x,
        y,
        VISUALS.beatRadius * 2.4,
        VISUALS.beatRadius * 2.4
      );
      noTint();
    } else {
      noStroke();
      fill(255, 210, 110, indicatorAlpha);
      circle(x, y, VISUALS.beatRadius * 2.4);
    }
    pop();
  }
}

// =====================================================
// DRAW HANDS + GLOVE SPRITE
// =====================================================
function drawHands() {
  let handsNow = getHandPositions();

  if (VISUALS.showHandDebug) {
    for (let hp of handsNow) {
      push();
      noFill();
      stroke(255, 255, 0);
      strokeWeight(2);
      circle(hp.hitX, hp.hitY, VISUALS.handRadius * 2);

      stroke(0, 255, 255);
      circle(hp.visualX, hp.visualY, VISUALS.handRadius * 1.25);

      stroke(255, 255, 255, 80);
      line(hp.hitX, hp.hitY, hp.visualX, hp.visualY);
      pop();
    }
  }

  for (let hp of handsNow) {
    if (!gloveImage) continue;

    let desiredGloveHeight = VISUALS.targetRadius * 1.55;
    let scaleFactor = desiredGloveHeight / gloveImage.height;

    push();
    translate(hp.visualX, hp.visualY);
    rotate(hp.visualAngle + HALF_PI);

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

  const boardW = 260;
  const boardH = 180;
  const margin = 20;
  const bx = width - boardW - margin;
  const by = margin;

  if (boardImage) {
    imageMode(CORNER);
    image(boardImage, bx, by, boardW, boardH);
  }

  textFont("Comic Sans MS");
  textAlign(CENTER, CENTER);

  // Bounce only when a hit just happened
  let t = comboPulseTimer / 12;
  let comboScale = 1 + 0.25 * (t * t);

  // Score shadow
  push();
  fill(0, 0, 0, 90);
  textSize(32);
  textStyle(BOLD);
  text(nf(score, 6), bx + boardW / 2 + 3, by + boardH * 0.42 + 3);
  pop();

  // Score text
  fill(40, 30, 20);
  textSize(32);
  textStyle(BOLD);
  text(nf(score, 6), bx + boardW / 2, by + boardH * 0.42);

  // Combo shadow
  push();
  fill(0, 0, 0, 85);
  textStyle(NORMAL);
  textSize(22 * comboScale);
  text(combo + "x", bx + boardW / 2 + 2, by + boardH * 0.55 + 2);
  pop();

  // Combo text
  fill(50, 40, 25);
  textStyle(NORMAL);
  textSize(22 * comboScale);
  text(combo + "x", bx + boardW / 2, by + boardH * 0.55);

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
    text("Improved hand tracking ready", width / 2, height / 2 + 28);
  }

  pop();
}

// =====================================================
// TIMERS
// =====================================================
function updateTimers() {
  if (lastHitTimer > 0) lastHitTimer--;

  if (comboPulseTimer > 0) comboPulseTimer--;

  for (let i = 0; i < targetFlashTimers.length; i++) {
    if (targetFlashTimers[i] > 0) targetFlashTimers[i]--;
  }
}
