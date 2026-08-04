import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { paths } from './config.js';

export const FONT_DIR = path.join(paths.DATA_DIR, 'fonts');
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

function fontFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...fontFiles(file));
    else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(file);
  }
  return files;
}

export function describeFontFile(file, root = FONT_DIR) {
  const id = path.relative(root, file).split(path.sep).join('/');
  if (!id || id.startsWith('../') || path.isAbsolute(id)) return null;
  const basename = path.basename(file, path.extname(file));
  const parent = path.basename(path.dirname(file));
  const split = basename.match(/^(.+?)[-_](Thin|ExtraLight|Light|Regular|Medium|SemiBold|Bold|ExtraBold|Black)(Italic)?$/i);
  const family = split?.[1] || (parent.toLowerCase() === 'fonts' ? basename : parent);
  const weight = split?.[2] || (/-?italic$/i.test(basename) ? 'Regular' : 'Regular');
  const italic = Boolean(split?.[3]) || /italic$/i.test(basename);
  const variant = `${weight}${italic ? ' Italic' : ''}`;
  return {
    id,
    family,
    variant,
    label: `${family} · ${variant}`,
    path: path.resolve(file),
  };
}

export function listFonts() {
  return fontFiles(FONT_DIR)
    .map((file) => describeFontFile(file))
    .filter(Boolean)
    .sort((a, b) => a.family.localeCompare(b.family, 'en') || a.variant.localeCompare(b.variant, 'en'));
}

export function resolveFont(fontId) {
  const id = String(fontId ?? '').trim().replace(/\\/g, '/');
  if (!id) return null;
  return listFonts().find((font) => font.id === id) ?? null;
}

export function publicFont(font) {
  return {
    id: font.id,
    family: font.family,
    variant: font.variant,
    label: font.label,
    url: `/api/fonts/file?id=${encodeURIComponent(font.id)}`,
  };
}
