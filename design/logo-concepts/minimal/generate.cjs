const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const concepts = [
  { name: "01-spectrum", label: "01 / Spectrum", description: "Silo colors on near-black", background: "#111114", shape: "M 166 660 L 350 660 L 470 448 L 598 562 L 858 332", width: 38, spectrum: true },
  { name: "02-blue", label: "02 / Blue", description: "Original blue, warm signal", background: "#080e9c", shape: "M 166 644 L 348 644 L 484 440 L 620 532 L 858 332", width: 38, spectrum: false },
  { name: "03-rise", label: "03 / Rise", description: "One clean dip and ascent", background: "#111114", shape: "M 166 610 L 382 468 L 538 576 L 858 332", width: 38, spectrum: true },
];

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(concepts => {
      const canvases = concepts.map(concept => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d");
        context.fillStyle = concept.background;
        context.beginPath();
        context.roundRect(0, 0, 1024, 1024, 224);
        context.fill();
        const gradient = context.createLinearGradient(166, 650, 858, 350);
        if (concept.spectrum) {
          gradient.addColorStop(0, "#168cff");
          gradient.addColorStop(0.28, "#168cff");
          gradient.addColorStop(0.60, "#ff1648");
          gradient.addColorStop(1, "#ff9900");
        } else {
          gradient.addColorStop(0, "#ff365c");
          gradient.addColorStop(1, "#ffae24");
        }
        context.strokeStyle = gradient;
        context.lineWidth = concept.width;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke(new Path2D(concept.shape));
        const pixels = context.getImageData(0, 0, 1024, 1024).data;
        let coloredPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset + 3] > 0 && pixels[offset] > 100) coloredPixels++;
        }
        return { canvas, coloredPixels };
      });
      const sheet = document.createElement("canvas");
      sheet.width = 1280;
      sheet.height = 760;
      const context = sheet.getContext("2d");
      context.fillStyle = "#eeeef0";
      context.fillRect(0, 0, sheet.width, sheet.height);
      context.fillStyle = "#19191d";
      context.font = "500 32px Avenir Next";
      context.fillText("Siloscope / Reduced to a signal", 40, 60);
      context.fillStyle = "#64646c";
      context.font = "18px Avenir Next";
      context.fillText("Silo palette. One line. Nothing behind it.", 40, 96);
      canvases.forEach(({ canvas }, index) => {
        const left = 40 + index * 414;
        context.drawImage(canvas, left, 142, 372, 372);
        context.fillStyle = "#19191d";
        context.font = "500 25px Avenir Next";
        context.fillText(concepts[index].label, left, 559);
        context.fillStyle = "#64646c";
        context.font = "18px Avenir Next";
        context.fillText(concepts[index].description, left, 590);
        context.drawImage(canvas, left, 626, 80, 80);
        context.drawImage(canvas, left + 104, 642, 48, 48);
        context.drawImage(canvas, left + 176, 650, 32, 32);
      });
      return {
        icons: canvases.map(({ canvas, coloredPixels }) => ({ png: canvas.toDataURL("image/png").split(",")[1], coloredPixels })),
        sheet: sheet.toDataURL("image/png").split(",")[1],
      };
    }, concepts);
    result.icons.forEach((image, index) => {
      const bytes = Buffer.from(image.png, "base64");
      assert.equal(bytes.readUInt32BE(16), 1024);
      assert.equal(bytes.readUInt32BE(20), 1024);
      assert.ok(image.coloredPixels > 10000, "The colored chart line must be visible");
      fs.writeFileSync(path.join(__dirname, `${concepts[index].name}.png`), bytes);
    });
    fs.writeFileSync(path.join(__dirname, "comparison.png"), Buffer.from(result.sheet, "base64"));
    console.log("Rendered three minimal concepts; dimensions and visible chart pixels verified. Live assets unchanged.");
  } finally {
    await browser.close();
  }
})();