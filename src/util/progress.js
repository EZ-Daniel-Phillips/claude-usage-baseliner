// A single-line, in-place progress indicator for the long scans (~1,700 transcript files / 1.4 GB,
// plus a git read per repository). Before this, a --visualise run printed one line and then went
// quiet for over a minute, which is indistinguishable from a hang.
//
// Rules it has to respect, because this tool's output is often piped or run from CI:
//   - Only draws when stderr is a TTY. Redirected output gets nothing, so a log file never fills with
//     carriage returns and half-drawn bars.
//   - Writes to stderr, never stdout: stdout carries the report paths a caller may want to consume.
//   - Silent at --quiet, exactly like info().
//   - Throttled to ~10 redraws a second. Redrawing per file was measurably slower than the work being
//     measured on a fast corpus.
// It also always clears its own line when done, so the finishing summary starts from a clean cursor.

const REDRAW_INTERVAL_MS = 100;

let active = null;

function isEnabled() {
  return Boolean(process.stderr.isTTY);
}

function clearLine() {
  if (!isEnabled()) return;
  process.stderr.write('\r\x1b[2K');
}

// Truncates to the terminal width so a long label cannot wrap and leave orphaned rows behind when the
// line is redrawn.
function fit(text) {
  const width = process.stderr.columns ?? 80;
  return text.length > width - 1 ? `${text.slice(0, Math.max(0, width - 2))}…` : text;
}

export function startProgress(label, total = null, { quiet = false } = {}) {
  if (quiet || !isEnabled()) {
    active = null;
    return {
      tick: () => {},
      update: () => {},
      done: () => {},
    };
  }

  const started = Date.now();
  let current = 0;
  let lastDraw = 0;
  let detail = '';

  const draw = (force = false) => {
    const now = Date.now();
    if (!force && now - lastDraw < REDRAW_INTERVAL_MS) return;
    lastDraw = now;
    const secs = ((now - started) / 1000).toFixed(0);
    const count = total ? `${current}/${total}` : `${current}`;
    const pct = total ? ` ${Math.floor((current / total) * 100)}%` : '';
    clearLine();
    process.stderr.write(fit(`  ${label} ${count}${pct} · ${secs}s${detail ? ` · ${detail}` : ''}`));
  };

  const handle = {
    tick(by = 1, newDetail) {
      current += by;
      if (newDetail !== undefined) detail = newDetail;
      draw();
    },
    update(newDetail) {
      detail = newDetail ?? '';
      draw();
    },
    done() {
      clearLine();
      active = null;
    },
  };
  active = handle;
  draw(true);
  // Reset the throttle clock so the FIRST real tick draws immediately instead of being swallowed by
  // the window the initial draw just opened. Without this the display sits on "0/N" with no detail
  // until 100ms have passed - and for a short phase (a handful of repositories, or a discovery pass
  // that finishes inside one window) that could be the only frame ever shown.
  lastDraw = 0;
  return handle;
}

// Clears any in-flight progress line so a warning or error never lands halfway through one.
export function clearProgress() {
  if (active) clearLine();
}
