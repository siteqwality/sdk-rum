// Fails fast when there is no build to test, and says which SDK a run is testing.
import fs from 'node:fs';
import path from 'node:path';
import { SDK, LOADER, SDK_PATH } from './lib/env.js';

export default function globalSetup() {
  if (!fs.existsSync(path.join(SDK.dir, 'sdk.min.js'))) {
    throw new Error(`No SDK build at ${SDK.dir}: run npm run build at the repo root, or set SQ_SDK_DIR`);
  }
  console.log(`[fixtures] SDK ${SDK.version} from ${SDK.dir}, served at ${SDK_PATH}, loaded as a ${LOADER} script`);
}
