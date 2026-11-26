/**
 * Image formats and the upload plan (MED-01 to MED-07, D-43). Pure code with
 * no Worker or DOM dependencies, shared by the admin browser code (which
 * processes photos) and the admin Worker (which verifies them).
 * Never imported by the public site.
 */
export { FormatError } from './bytes.ts';
export {
  TAG_ARTIST,
  TAG_COPYRIGHT,
  buildRightsExif,
  exifAscii,
  isRightsOnly,
  readExif,
  rightsFor,
  type RightsMetadata,
} from './exif.ts';
export {
  addJpegRights,
  hasOnlyRightsMetadata,
  isJpeg,
  parseJpeg,
  stripJpegMetadata,
  type JpegInfo,
} from './jpeg.ts';
export {
  addWebpRights,
  isWebp,
  parseWebp,
  webpHasOnlyRightsMetadata,
  type WebpInfo,
} from './webp.ts';
export { ACCEPTED_IMAGE_INPUTS, SNIFF_BYTES, sniffInput, type InputKind } from './sniff.ts';
export {
  DERIVATIVE_EDGES,
  MASTER_MAX_EDGE,
  MASTER_MAX_PIXELS,
  MAX_BYTES,
  MIN_EDGE,
  OG_EDGE,
  PlanError,
  masterSize,
  scaledTo,
  uploadPlan,
  type PartFormat,
  type PartRole,
  type PlannedPart,
} from './plan.ts';
export { verifyPart, type VerifyReason, type VerifyResult } from './verify.ts';
export {
  Mp4Error,
  VIDEO_MAX_DURATION_S,
  VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SHORT_EDGE,
  verifyMp4Header,
  type Mp4Info,
  type Mp4Reason,
} from './mp4.ts';
