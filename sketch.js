// Using codingTrain reference

let video;
let handPose;
let hands = [];
let gloveImage;

function preload() {
  // Initialize HandPose model with flipped video input
  handPose = ml5.handPose({ flipped: true });
  gloveImage = loadImage('gloves.png'); // Load glove image
}

function mousePressed() {
  console.log(hands);
}

function gotHands(results) {
  hands = results;
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  video = createCapture(VIDEO, { flipped: true });
  video.size(windowWidth, windowHeight);  
  video.hide();

  // Start detecting hands
  handPose.detectStart(video, gotHands);
}

function draw() {
    background(0);
    if (hands.length > 0) {
    for (let hand of hands) {

        let wrist = hand.keypoints[0];
        let middle = hand.keypoints[9];

        // Calculate rotation angle
        let angle = atan2(middle.y - wrist.y, middle.x - wrist.x);

        // Calculate hand size
        let handSize = dist(wrist.x, wrist.y, middle.x, middle.y);

        push();

        translate(wrist.x, wrist.y);
        rotate(angle + HALF_PI); // Rotate to align with hand direction
        
        // scale glove relative to hand size
        let scaleFactor = handSize / 100;

        // Flip glove for right hand
        if (hand.handedness === "Right") {
        scale(-1, 1);
        }

        
        imageMode(CENTER);
        image(
            gloveImage,
            0,
            -handSize * 0.5,
            gloveImage.width * scaleFactor,
            gloveImage.height * scaleFactor

        );

        pop();
    }
  }
}
