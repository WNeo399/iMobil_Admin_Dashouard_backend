// The full stock-register refresh (bin/stockSnapshot.js --apply), run as a
// child process — the script is a cron entrypoint that calls process.exit,
// so it must never run in-process. One at a time: the dashboard's "Update
// Now" and the external trigger (/integration/stockSync?mode=full) both
// come through here, so neither can start a second run behind the other.
// It takes a couple of minutes; callers get "started" straight back and
// poll isFullRefreshRunning() (the dashboard) or simply wait for the next
// scheduled pass.

const { spawn } = require("child_process");
const path = require("path");

let child = null;
const finished = new Set();

// { started, running } — started is false when a run is already going.
function startFullRefresh(by = "unknown") {
  if (child) return { started: false, running: true };
  const root = path.join(__dirname, "..");
  const c = spawn(process.execPath, [path.join(root, "bin", "stockSnapshot.js"), "--apply"], {
    cwd: root,
    stdio: "ignore",
  });
  child = c;
  c.on("exit", (code) => {
    child = null;
    console.log(`stock refresh finished (exit ${code})`);
    for (const fn of finished) {
      try {
        fn(code);
      } catch (e) {
        // A listener's problem is not the refresh's.
      }
    }
  });
  c.on("error", (e) => {
    child = null;
    console.error("stock refresh spawn error:", e.message);
  });
  console.log(`stock refresh started by ${by}`);
  return { started: true, running: true };
}

function isFullRefreshRunning() {
  return !!child;
}

// Called with the exit code each time a run ends (the routes drop their
// cached "as of" stamp here).
function onFullRefreshFinished(fn) {
  finished.add(fn);
}

module.exports = { startFullRefresh, isFullRefreshRunning, onFullRefreshFinished };
