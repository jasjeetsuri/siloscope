const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(() => {
      const concepts = [
        { name: "04-spectrum-time", label: "04 / Charcoal", background: "#111114" },
        { name: "05-blue-time", label: "05 / Silo Blue", background: "#080e9c", strongerWarmFill: true },
        { name: "06-navy-time", label: "06 / Dark Navy", background: "#0b1730" },
      ];
      const intersectionY = 410;
      const trace = "M 0 660 C 32 642 52 654 78 656 C 106 660 118 601 148 584 C 174 569 192 616 218 591 C 244 566 252 506 279 513 C 306 520 322 684 352 694 C 384 705 395 608 430 584 C 466 559 483 579 505 544 C 533 500 548 400 578 388 C 609 374 626 484 649 477 C 667 472 678 425 692 410 C 711 392 726 431 741 472 C 759 521 772 572 797 561 C 825 548 846 420 871 400 C 899 379 927 393 950 379 C 978 365 998 350 1024 332";
      const canvases = concepts.map(concept => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d");
        context.beginPath();
        context.roundRect(0, 0, 1024, 1024, 224);
        context.clip();
        context.fillStyle = concept.background;
        context.fillRect(0, 0, 1024, 1024);
        const grid = context.createLinearGradient(0, 0, 0, 1024);
        grid.addColorStop(0, "rgba(255,255,255,0.03)");
        grid.addColorStop(0.3, "rgba(255,255,255,0.12)");
        grid.addColorStop(0.7, "rgba(255,255,255,0.09)");
        grid.addColorStop(1, "rgba(255,255,255,0.02)");
        context.strokeStyle = grid;
        context.lineWidth = 5;
        for (const position of [192, 352, 512, 832]) {
          context.beginPath();
          context.moveTo(position, 0);
          context.lineTo(position, 1024);
          context.stroke();
        }
        const gradientBottom = concept.strongerWarmFill ? 980 : 1024;
        const spectrum = context.createLinearGradient(0, 330, 0, gradientBottom);
        spectrum.addColorStop(0, "#168cff");
        spectrum.addColorStop(concept.strongerWarmFill ? 0.25 : 0.33, "#0044ff");
        spectrum.addColorStop(concept.strongerWarmFill ? 0.53 : 0.67, "#ff003c");
        spectrum.addColorStop(concept.strongerWarmFill ? 0.78 : 1, "#ff9900");
        const fill = document.createElement("canvas");
        fill.width = fill.height = 1024;
        const fillContext = fill.getContext("2d");
        fillContext.fillStyle = spectrum;
        fillContext.fill(new Path2D(`${trace} L 1024 1024 L 0 1024 Z`));
        fillContext.globalCompositeOperation = "destination-in";
        const fade = fillContext.createLinearGradient(0, 330, 0, gradientBottom);
        fade.addColorStop(0, concept.strongerWarmFill ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.72)");
        if (concept.strongerWarmFill) {
          fade.addColorStop(0.53, "rgba(0,0,0,0.6)");
          fade.addColorStop(0.82, "rgba(0,0,0,0.6)");
        } else {
          fade.addColorStop(0.45, "rgba(0,0,0,0.48)");
        }
        fade.addColorStop(1, "rgba(0,0,0,0)");
        fillContext.fillStyle = fade;
        fillContext.fillRect(0, 0, 1024, 1024);
        context.drawImage(fill, 0, 0);
        context.strokeStyle = "#ee8b9d";
        context.lineWidth = 10;
        context.beginPath();
        context.moveTo(692, 0);
        context.lineTo(692, 1024);
        context.stroke();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 21.85;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke(new Path2D(trace));
        const halo = context.createRadialGradient(692, intersectionY, 39.9, 692, intersectionY, 80);
        halo.addColorStop(0, "rgba(238,139,157,0.55)");
        halo.addColorStop(0.45, "rgba(238,139,157,0.25)");
        halo.addColorStop(1, "rgba(238,139,157,0)");
        context.fillStyle = halo;
        context.beginPath();
        context.arc(692, intersectionY, 80, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#ee8b9d";
        context.beginPath();
        context.arc(692, intersectionY, 39.9, 0, Math.PI * 2);
        context.fill();
        const markerPixel = context.getImageData(692, 260, 1, 1).data;
        const circlePixel = context.getImageData(706, Math.round(intersectionY), 1, 1).data;
        const haloCenterPixel = context.getImageData(692, intersectionY, 1, 1).data;
        const haloInnerPixel = context.getImageData(714, intersectionY - 32, 1, 1).data;
        const haloOuterPixel = context.getImageData(726, intersectionY - 49, 1, 1).data;
        const markerEdgePixel = context.getImageData(696, 260, 1, 1).data;
        const solidMarkerPixel = context.getImageData(692, 40, 1, 1).data;
        const gridPixel = context.getImageData(352, 260, 1, 1).data;
        const backgroundPixel = context.getImageData(342, 260, 1, 1).data;
        const linePixel = context.getImageData(578, 388, 1, 1).data;
        const fillPixels = [430, 810, 940].map(position => Array.from(fillContext.getImageData(950, position, 1, 1).data));
        const edgeLines = [[0, 660], [1023, 332]].map(([horizontal, vertical]) => context.getImageData(horizontal, vertical, 1, 1).data);
        const edgeFills = [0, 1023].map(horizontal => fillContext.getImageData(horizontal, 780, 1, 1).data);
        const colorsCorrect = markerPixel[0] === 238 && markerPixel[1] === 139 && markerPixel[2] === 157
          && edgeLines.every(pixel => pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255 && pixel[3] === 255)
          && edgeFills.every(pixel => pixel[3] > 50)
          && circlePixel[0] === 238 && circlePixel[1] === 139 && circlePixel[2] === 157
          && haloCenterPixel[0] === 238 && haloCenterPixel[1] === 139 && haloCenterPixel[2] === 157
          && haloInnerPixel[0] > haloOuterPixel[0] && haloOuterPixel[0] > backgroundPixel[0]
          && markerEdgePixel[0] === 238 && markerEdgePixel[1] === 139 && markerEdgePixel[2] === 157
          && solidMarkerPixel[0] === 238 && solidMarkerPixel[1] === 139 && solidMarkerPixel[2] === 157
          && gridPixel[0] > backgroundPixel[0]
          && fillPixels[1][3] > 50
          && linePixel[0] === 255 && linePixel[1] === 255 && linePixel[2] === 255
          && fillPixels[0][2] > fillPixels[0][0]
          && fillPixels[1][0] > fillPixels[1][2]
          && fillPixels[2][0] > fillPixels[2][1] && fillPixels[2][1] > fillPixels[2][2];
        return { canvas, name: concept.name, label: concept.label, colorsCorrect };
      });
      const sheet = document.createElement("canvas");
      sheet.width = 40 + concepts.length * 500;
      sheet.height = 780;
      const context = sheet.getContext("2d");
      context.fillStyle = "#eeeef0";
      context.fillRect(0, 0, sheet.width, sheet.height);
      context.fillStyle = "#19191d";
      context.font = "500 30px Avenir Next";
      context.fillText("Siloscope / Fill + Time", 40, 58);
      context.fillStyle = "#64646c";
      context.font = "18px Avenir Next";
      context.fillText("Silo colors fading top to bottom beneath the white trace.", 40, 94);
      canvases.forEach(({ canvas, label }, index) => {
        const left = 40 + index * 500;
        context.drawImage(canvas, left, 140, 460, 460);
        context.fillStyle = "#19191d";
        context.font = "500 24px Avenir Next";
        context.fillText(label, left, 642);
        context.drawImage(canvas, left, 674, 64, 64);
        context.drawImage(canvas, left + 88, 682, 48, 48);
        context.drawImage(canvas, left + 160, 690, 32, 32);
      });
      return {
        icons: canvases.map(({ canvas, name, colorsCorrect }) => ({ name, colorsCorrect, png: canvas.toDataURL("image/png").split(",")[1] })),
        sheet: sheet.toDataURL("image/png").split(",")[1],
      };
    });
    for (const icon of result.icons) {
      const bytes = Buffer.from(icon.png, "base64");
      assert.equal(bytes.readUInt32BE(16), 1024);
      assert.equal(bytes.readUInt32BE(20), 1024);
      assert.ok(icon.colorsCorrect, "Verify edge-to-edge white trace and fill, pink marker and circle, grid, and Silo colors");
      fs.writeFileSync(path.join(__dirname, `${icon.name}.png`), bytes);
    }
    fs.writeFileSync(path.join(__dirname, "timeline-comparison.png"), Buffer.from(result.sheet, "base64"));
    console.log("Rendered all concepts; edge-to-edge trace and fill, colors, grid, and marker verified. Production unchanged.");
  } finally {
    await browser.close();
  }
})();