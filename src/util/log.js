let verbosity = 'normal'; // 'quiet' | 'normal' | 'verbose'

export function setVerbosity(v) {
  verbosity = v;
}

export function info(...args) {
  if (verbosity === 'quiet') return;
  console.log(...args);
}

export function verbose(...args) {
  if (verbosity !== 'verbose') return;
  console.log(...args);
}

export function warn(...args) {
  if (verbosity === 'quiet') return;
  console.warn(...args);
}

export function error(...args) {
  console.error(...args);
}
