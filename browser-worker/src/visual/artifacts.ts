import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

export type FrameMilestone = 'navigation' | 'domcontentloaded' | 'delay' | 'asserted';

export interface VisualFileDescriptor {
  filename: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
}

export interface VisualFrameDescriptor extends VisualFileDescriptor {
  index: number;
  milestone: FrameMilestone;
  capturedAt: string;
  path: string;
}

export interface ContactSheetOptions {
  quality: number;
  maxPixels: number;
  maxBytes: number;
  labels: {
    route: string;
    role: string;
    browser: string;
    viewport: string;
  };
}

export interface VisualManifestInput {
  resultKey: string;
  route: string;
  role: string;
  browser: string;
  viewport: string;
  policyVersion: number;
  frames: VisualFrameDescriptor[];
  finalScreenshot: VisualFrameDescriptor | null;
  contactSheet: VisualFileDescriptor | null;
  warnings: string[];
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function describeFrameFile(
  filePath: string,
  index: number,
  milestone: FrameMilestone,
  capturedAt: string,
): Promise<VisualFrameDescriptor> {
  const buffer = fs.readFileSync(filePath);
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`frame has no dimensions: ${filePath}`);
  return {
    index,
    milestone,
    capturedAt,
    path: filePath,
    filename: path.basename(filePath),
    bytes: buffer.length,
    sha256: sha256(buffer),
    width: metadata.width,
    height: metadata.height,
  };
}

async function labelBuffer(
  width: number,
  height: number,
  line1: string,
  line2: string,
): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#151515"/>` +
      `<text x="10" y="17" fill="#f2f2f2" font-family="monospace" font-size="12">${xml(line1)}</text>` +
      `<text x="10" y="35" fill="#a8a8a8" font-family="monospace" font-size="11">${xml(line2)}</text>` +
      '</svg>',
  );
  return sharp(svg).png().toBuffer();
}

export async function createContactSheet(
  frames: VisualFrameDescriptor[],
  outputPath: string,
  options: ContactSheetOptions,
): Promise<VisualFileDescriptor> {
  if (frames.length === 0) throw new Error('contact sheet requires at least one frame');

  const columns = frames.length === 1 ? 1 : 2;
  const rows = Math.ceil(frames.length / columns);
  const labelHeight = 44;
  const imageHeight = 300;
  const minimumPixels = columns * 160 * rows * 120;
  if (options.maxPixels < minimumPixels) {
    throw new Error(`contact sheet maxPixels ${options.maxPixels} is below feasible minimum ${minimumPixels}`);
  }
  let tileWidth = 480;
  let tileHeight = labelHeight + imageHeight;
  const initialPixels = columns * tileWidth * rows * tileHeight;
  if (initialPixels > options.maxPixels) {
    const scale = Math.sqrt(options.maxPixels / initialPixels);
    tileWidth = Math.max(160, Math.floor(tileWidth * scale));
    tileHeight = Math.max(120, Math.floor(tileHeight * scale));
  }
  const scaledLabelHeight = Math.min(labelHeight, Math.max(32, Math.floor(tileHeight * 0.13)));
  const scaledImageHeight = tileHeight - scaledLabelHeight;
  const width = columns * tileWidth;
  const height = rows * tileHeight;

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const [position, frame] of frames.entries()) {
    const column = position % columns;
    const row = Math.floor(position / columns);
    const left = column * tileWidth;
    const top = row * tileHeight;
    const image = await sharp(frame.path)
      .flatten({ background: '#111111' })
      .resize(tileWidth, scaledImageHeight, {
        fit: 'contain',
        background: '#111111',
      })
      .png()
      .toBuffer();
    const label = await labelBuffer(
      tileWidth,
      scaledLabelHeight,
      `#${frame.index} ${frame.milestone} ${frame.capturedAt}`,
      `${options.labels.route} | ${options.labels.role} | ${options.labels.browser} ${options.labels.viewport}`,
    );
    composites.push({ input: label, left, top });
    composites.push({ input: image, left, top: top + scaledLabelHeight });
  }

  const canvas = await sharp({
    create: { width, height, channels: 3, background: '#111111' },
  }).composite(composites).png().toBuffer();

  let quality = options.quality;
  let buffer = await sharp(canvas).webp({ quality }).toBuffer();
  while (buffer.length > options.maxBytes && quality > 40) {
    quality = Math.max(40, quality - 15);
    buffer = await sharp(canvas).webp({ quality }).toBuffer();
  }
  let resizeWidth = width;
  while (buffer.length > options.maxBytes && resizeWidth > 320) {
    resizeWidth = Math.max(320, Math.floor(resizeWidth * 0.8));
    buffer = await sharp(canvas)
      .resize({ width: resizeWidth, withoutEnlargement: true })
      .webp({ quality: 40 })
      .toBuffer();
  }
  if (buffer.length > options.maxBytes) {
    throw new Error(`contact sheet exceeds ${options.maxBytes} bytes after bounded encoding`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  const metadata = await sharp(buffer).metadata();
  return {
    filename: path.basename(outputPath),
    bytes: buffer.length,
    sha256: sha256(buffer),
    width: metadata.width ?? width,
    height: metadata.height ?? height,
  };
}

function manifestFile(file: VisualFileDescriptor | null): Omit<VisualFileDescriptor, 'path'> | null {
  if (!file) return null;
  return {
    filename: file.filename,
    bytes: file.bytes,
    sha256: file.sha256,
    width: file.width,
    height: file.height,
  };
}

export function buildVisualManifest(input: VisualManifestInput) {
  const frames = [...input.frames]
    .sort((left, right) => left.index - right.index)
    .map(({ path: _path, ...frame }) => frame);
  return {
    schemaVersion: 1,
    resultId: null,
    resultKey: input.resultKey,
    route: input.route,
    role: input.role,
    browser: input.browser,
    viewport: input.viewport,
    capturePolicyVersion: input.policyVersion,
    frames,
    finalScreenshot: manifestFile(input.finalScreenshot),
    contactSheet: manifestFile(input.contactSheet),
    warnings: [...input.warnings],
  };
}
