// Local screenshot helper for the Sentinel UI.
// Usage: electron scripts/capture-preview.cjs --url=<url> --out=<png> --size=<W>x<H> [--seed=<json>|--seed-file=<path>] [--wait=<ms>]
const { app, BrowserWindow } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const targetUrl = getArg("url");
const outPath = getArg("out");
const [width, height] = String(getArg("size") || "1660x980")
  .split("x")
  .map((value) => Number.parseInt(value, 10) || 0);
const waitMs = Number(getArg("wait") || 7000);
const seedJson = getArg("seed");
const seedFile = getArg("seed-file");
const evalJs = getArg("eval");
const clearStorage = process.argv.includes("--clear");
const fullPage = process.argv.includes("--full");

if (!targetUrl || !outPath) {
  console.error("usage: electron scripts/capture-preview.cjs --url=<url> --out=<png> [--size=WxH] [--seed=<json>] [--wait=ms]");
  app.exit(1);
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: width || 1660,
    height: height || 980,
    show: false,
    enableLargerThanScreen: true,
    backgroundColor: "#101114",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: false,
    },
  });

  let cleared = !clearStorage;
  let seeded = !seedJson && !seedFile;
  let captured = false;

  window.webContents.on("did-finish-load", async () => {
    if (window.isDestroyed()) return;

    if (!cleared) {
      cleared = true;
      await window.webContents.executeJavaScript("window.localStorage.clear()");
      window.webContents.reload();
      return;
    }

    if (!seeded) {
      seeded = true;
      try {
        let entries = JSON.parse(seedJson);
        if (!entries && seedFile) {
          const fileData = JSON.parse(await readFile(seedFile, "utf8"));
          entries = {
            mahoraga_connection_url: fileData.apiUrl,
            mahoraga_api_token: fileData.bearerToken,
          };
        }
        const statements = Object.entries(entries)
          .map(([key, value]) => `window.localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
          .join("");
        await window.webContents.executeJavaScript(statements);
      } catch (seedError) {
        console.error("[capture] seed failed", seedError);
      }
      window.webContents.reload();
      return;
    }

    if (captured) return;
    captured = true;

    setTimeout(async () => {
      if (evalJs) {
        try {
          const result = await window.webContents.executeJavaScript(evalJs);
          console.log("[capture] eval result", String(result).slice(0, 400));
        } catch (evalError) {
          console.error("[capture] eval failed", evalError);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      try {
        if (fullPage) {
          const dbg = window.webContents.debugger;
          dbg.attach("1.3");
          const shot = await dbg.sendCommand("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
          });
          dbg.detach();
          await writeFile(outPath, Buffer.from(shot.data, "base64"));
        } else {
          const image = await window.webContents.capturePage();
          await writeFile(outPath, image.toPNG());
        }
        console.log(`[capture] wrote ${outPath}`);
      } catch (captureError) {
        console.error("[capture] failed", captureError);
      }
      app.quit();
    }, waitMs);
  });

  window.loadURL(targetUrl);
});
