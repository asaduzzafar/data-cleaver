import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;

// A throwaway app-data folder per run, so the app starts empty, installs a
// small sample, and never touches the user's own Data Cleaver data.
const appData = path.join(os.tmpdir(), `datacleaver-a11y-${Date.now()}`);

export default defineConfig({
  testDir: "tests/a11y",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The Chrome already installed on this machine: no browser download.
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `"${path.resolve(here, "../../.venv/Scripts/python.exe")}" -m app --port ${PORT}`,
    cwd: path.resolve(here, "../backend"),
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: { LOCALAPPDATA: appData, SDA_SAMPLE_ROWS: "5000" },
  },
});
