const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const concepts = [
  { name: "01-pulse", label: "01 / Pulse", description: "Single precise peak", shape: "M 122 554 L 338 554 Q 350 554 355 541 L 413 395 Q 420 377 428 398 L 515 626 Q 523 647 534 627 L 580 542 Q 587 530 602 530 L 902 530" },
  { name: "02-wave", label: "02 / Wave", description: "Continuous soft motion", shape: "M 122 534 L 265 534 C 335 534 345 428 403 428 C 470 428 479 608 544 608 C 603 608 617 476 679 476 C 735 476 754 534 808 534 L 902 534" },
  { name: "03-rhythm", label: "03 / Rhythm", description: "Two balanced peaks", shape: "M 122 550 L 288 550 Q 300 550 307 537 L 368 436 Q 378 420 389 437 L 475 583 Q 484 599 495 583 L 602 427 Q 612 412 622 428 L 697 538 Q 705 550 720 550 L 902 550" },
  { name: "04-signal", label: "04 / Signal", description: "Rounded stepped trace", shape: "M 122 560 L 307 560 Q 327 560 327 540 L 327 471 Q 327 451 347 451 L 442 451 Q 462 451 462 471 L 462 595 Q 462 615 482 615 L 575 615 Q 595 615 595 595 L 595 499 Q 595 479 615 479 L 704 479 Q 724 479 724 499 L 724 540 Q 724 560 744 560 L 902 560" },
];

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const source = fs.readFileSync(path.resolve(__dirname, "../../../../silo/silo-server/assets/icon.png")).toString("base64");
    const result = await page.evaluate(async ({ source, concepts }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${source}`;
      await image.decode();
      const canvases = concepts.map(concept => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, 1024, 1024);
        const trace = new Path2D(concept.shape);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = "rgba(20, 15, 17, 0.78)";
        context.lineWidth = 48;
        context.stroke(trace);
        context.strokeStyle = "#ee8b9d";
        context.lineWidth = 27;
        context.stroke(trace);
        return canvas;
      });
      const sheet = document.createElement("canvas");
      sheet.width = 1440;
      sheet.height = 680;
      const context = sheet.getContext("2d");
      context.fillStyle = "#171416";
      context.fillRect(0, 0, sheet.width, sheet.height);
      context.fillStyle = "#f7f1f3";
      context.font = "500 30px Avenir Next";
      context.fillText("Siloscope / Waveform studies", 40, 56);
      context.fillStyle = "#b5a6ab";
      context.font = "18px Avenir Next";
      context.fillText("Pink trace. No endpoint circle. Original Silo artwork.", 40, 90);
      canvases.forEach((canvas, index) => {
        const left = 40 + index * 350;
        context.drawImage(canvas, left, 134, 310, 310);
        context.fillStyle = "#f7f1f3";
        context.font = "500 24px Avenir Next";
        context.fillText(concepts[index].label, left, 488);
        context.fillStyle = "#b5a6ab";
        context.font = "17px Avenir Next";
        context.fillText(concepts[index].description, left, 519);
        context.drawImage(canvas, left, 555, 64, 64);
        context.drawImage(canvas, left + 88, 571, 32, 32);
      });
      return { icons: canvases.map(canvas => canvas.toDataURL("image/png").split(",")[1]), sheet: sheet.toDataURL("image/png").split(",")[1] };
    }, { source, concepts });
    result.icons.forEach((image, index) => fs.writeFileSync(path.join(__dirname, `${concepts[index].name}.png`), Buffer.from(image, "base64")));
    fs.writeFileSync(path.join(__dirname, "comparison.png"), Buffer.from(result.sheet, "base64"));
    console.log("Generated four 1024px waveform concepts and comparison.png; production assets unchanged.");
  } finally {
    await browser.close();
  }
})();