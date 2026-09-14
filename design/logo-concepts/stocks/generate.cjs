const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const concepts = [
  { name: "01-trend", label: "01 / Trend", description: "Fine trace, no extra detail", grid: false, area: false },
  { name: "02-market", label: "02 / Market", description: "Trace with a quiet chart grid", grid: true, area: false },
  { name: "03-area", label: "03 / Area", description: "Soft fill beneath the signal", grid: true, area: true },
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
      const traceData = "M 104 645 L 168 645 L 205 606 L 246 620 L 283 556 L 322 577 L 365 505 L 403 540 L 439 529 L 478 569 L 512 544 L 548 592 L 584 570 L 625 473 L 663 495 L 701 435 L 737 448 L 777 372 L 816 394 L 858 350 L 920 350";
      const canvases = concepts.map(concept => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, 1024, 1024);
        if (concept.grid) {
          context.strokeStyle = "rgba(235, 238, 242, 0.12)";
          context.lineWidth = 2;
          for (const position of [256, 512, 768]) {
            context.beginPath();
            context.moveTo(position, 220);
            context.lineTo(position, 790);
            context.stroke();
          }
          for (const position of [350, 500, 650]) {
            context.beginPath();
            context.moveTo(104, position);
            context.lineTo(920, position);
            context.stroke();
          }
        }
        if (concept.area) {
          const gradient = context.createLinearGradient(0, 340, 0, 790);
          gradient.addColorStop(0, "rgba(238, 139, 157, 0.30)");
          gradient.addColorStop(1, "rgba(238, 139, 157, 0)");
          context.fillStyle = gradient;
          context.fill(new Path2D(`${traceData} L 920 790 L 104 790 Z`));
        }
        context.lineCap = "round";
        context.lineJoin = "round";
        context.strokeStyle = "#ee8b9d";
        context.lineWidth = 20;
        context.shadowColor = "rgba(0, 0, 0, 0.6)";
        context.shadowBlur = 10;
        context.shadowOffsetY = 3;
        context.stroke(new Path2D(traceData));
        return canvas;
      });
      const sheet = document.createElement("canvas");
      sheet.width = 1280;
      sheet.height = 760;
      const context = sheet.getContext("2d");
      context.fillStyle = "#171719";
      context.fillRect(0, 0, sheet.width, sheet.height);
      context.fillStyle = "#f4f4f6";
      context.font = "500 32px Avenir Next";
      context.fillText("Siloscope / Stocks-inspired studies", 40, 60);
      context.fillStyle = "#a9a9b0";
      context.font = "18px Avenir Next";
      context.fillText("Original artwork. Fine pink chart trace. No endpoint marker.", 40, 96);
      canvases.forEach((canvas, index) => {
        const left = 40 + index * 414;
        context.drawImage(canvas, left, 142, 372, 372);
        context.fillStyle = "#f4f4f6";
        context.font = "500 25px Avenir Next";
        context.fillText(concepts[index].label, left, 559);
        context.fillStyle = "#a9a9b0";
        context.font = "18px Avenir Next";
        context.fillText(concepts[index].description, left, 590);
        context.drawImage(canvas, left, 626, 80, 80);
        context.drawImage(canvas, left + 104, 642, 48, 48);
        context.drawImage(canvas, left + 176, 650, 32, 32);
      });
      return { icons: canvases.map(canvas => canvas.toDataURL("image/png").split(",")[1]), sheet: sheet.toDataURL("image/png").split(",")[1] };
    }, { source, concepts });
    for (const [index, image] of result.icons.entries()) {
      const bytes = Buffer.from(image, "base64");
      assert.equal(bytes.readUInt32BE(16), 1024);
      assert.equal(bytes.readUInt32BE(20), 1024);
      fs.writeFileSync(path.join(__dirname, `${concepts[index].name}.png`), bytes);
    }
    fs.writeFileSync(path.join(__dirname, "comparison.png"), Buffer.from(result.sheet, "base64"));
    console.log("Rendered and dimension-checked three Stocks-inspired concepts; production assets unchanged.");
  } finally {
    await browser.close();
  }
})();