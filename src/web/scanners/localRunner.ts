// Compatibility exports for integrations that imported the v0.2 module path.
// Web execution itself is Docker-only from v0.3 onward.
export { DockerScannerRunner as LocalScannerRunner } from './dockerRunner.js';
export type { ScannerResult } from './dockerRunner.js';
export { clean } from './output.js';
