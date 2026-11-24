// Khmer fonts for posters and videos (all SIL OFL, files in assets/fonts). The Content Creator and Video
// Creator AIs choose a headline font and a body font for each design.
// Keep the keys in sync with KHMER_FONTS in src/marketing/promo.js.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FONTS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'assets', 'fonts');

// family, files [file, weight], scale (wide fonts start smaller), body: good for sentences too.
export const KHMER_FONTS = {
  kantumruy: { family: 'Kantumruy Pro', files: [['KantumruyPro-Variable.ttf', '100 700']], scale: 0.95, body: true },      // modern, the most used on Khmer apps and social media
  koulen: { family: 'Koulen', files: [['Koulen-Regular.ttf', 400]], scale: 1.1 },                                         // tall bold display: loud headlines
  kdamthmor: { family: 'Kdam Thmor Pro', files: [['KdamThmorPro-Regular.ttf', 400]], scale: 1.0 },                         // strong modern headline
  moul: { family: 'Moul', files: [['Moul-Regular.ttf', 400]], scale: 0.72 },                                              // traditional titles (like Khmer OS Muol)
  bayon: { family: 'Bayon', files: [['Bayon-Regular.ttf', 400]], scale: 1.05 },                                           // condensed display
  dangrek: { family: 'Dangrek', files: [['Dangrek-Regular.ttf', 400]], scale: 0.95 },                                     // rounded, friendly
  fasthand: { family: 'Fasthand', files: [['Fasthand-Regular.ttf', 400]], scale: 0.95 },                                  // handwritten, personal
  battambang: { family: 'Battambang', files: [['Battambang-Regular.ttf', 400], ['Battambang-Bold.ttf', 700]], scale: 0.92, body: true }, // classic (like Khmer OS Battambang)
  siemreap: { family: 'Siemreap', files: [['Siemreap.ttf', 400]], scale: 0.9, body: true },                               // standard text (like Khmer OS Siemreap)
  hanuman: { family: 'Hanuman', files: [['Hanuman-Variable.ttf', '100 900']], scale: 0.92, body: true },                  // book-like serif
  suwannaphum: { family: 'Suwannaphum', files: [['Suwannaphum-Regular.ttf', 400], ['Suwannaphum-Bold.ttf', 700]], scale: 0.92, body: true }, // traditional serif
  notoserif: { family: 'Noto Serif Khmer', files: [['NotoSerifKhmer-Variable.ttf', '100 900']], scale: 0.9, body: true }, // elegant serif
  noto: { family: 'Noto Sans Khmer', files: [['NotoSansKhmer-Regular.ttf', 400], ['NotoSansKhmer-Bold.ttf', 700]], scale: 0.92, body: true }, // neutral
};
export const fontOf = (key, fallback = 'kantumruy') => KHMER_FONTS[key] || KHMER_FONTS[fallback];
export const bodyFontOf = key => (KHMER_FONTS[key]?.body ? KHMER_FONTS[key] : KHMER_FONTS.kantumruy);

const face = (family, file, weight) => `@font-face{font-family:'${family}';src:url('${pathToFileURL(join(FONTS, file)).href}') format('truetype');font-weight:${weight};}`;
// @font-face rules for the given font keys plus Poppins (Latin brand text) and Noto Sans Khmer (fallback).
export function fontFaces(keys = []) {
  const set = new Set(['noto', ...keys.filter(k => KHMER_FONTS[k])]);
  const rules = [...set].flatMap(k => KHMER_FONTS[k].files.map(([f, w]) => face(KHMER_FONTS[k].family, f, w)));
  rules.push(face('Poppins', 'Poppins-Regular.ttf', 400), face('Poppins', 'Poppins-SemiBold.ttf', 600), face('Poppins', 'Poppins-ExtraBold.ttf', 800));
  return rules.join('\n');
}
