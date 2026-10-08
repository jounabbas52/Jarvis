/**
 * Bundle the two model workers as standalone ES modules.
 *
 * Why not let Next do it: Next's webpack emits workers as *classic* scripts,
 * and a classic script cannot contain `import.meta` — which both
 * transformers.js and several of its dependencies use. The result is a build
 * that dies on a parse error deep inside a vendor bundle.
 *
 * Browsers and Electron support real module workers natively, so building
 * these two files with esbuild and loading them with `{ type: 'module' }`
 * sidesteps the whole problem. It also keeps the model runtime out of the
 * app's own bundle entirely, which is where it belongs: nothing about the
 * chat window should wait on several megabytes of inference code.
 */

const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

const WORKERS = [
  { in: 'lib/brain/worker.ts', out: 'public/workers/brain.js' },
  { in: 'lib/voice/worker.ts', out: 'public/workers/voice.js' },
  // Mark's local "Hey Jarvis" detector (openWakeWord on onnxruntime-web).
  { in: 'lib/mark/wake.worker.ts', out: 'public/workers/wake.js' },
];

async function main() {
  const watch = process.argv.includes('--watch');

  for (const worker of WORKERS) {
    const options = {
      entryPoints: [path.join(root, worker.in)],
      outfile: path.join(root, worker.out),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      // Electron 31 ships Chromium 126, so there is no reason to down-level
      // anything — and down-levelling top-level await would break the loader.
      target: 'chrome126',
      minify: !watch,
      sourcemap: watch,
      // The Node build of onnxruntime is never reachable from a browser
      // worker; without this esbuild tries to resolve its native binding.
      external: ['onnxruntime-node'],
      logLevel: 'warning',
    };

    if (watch) {
      const context = await esbuild.context(options);
      await context.watch();
      console.log(`[workers] watching ${worker.in}`);
    } else {
      await esbuild.build(options);
      console.log(`[workers] built ${worker.out}`);
    }
  }
}

main().catch((err) => {
  console.error('[workers] build failed:', err.message);
  process.exit(1);
});
