import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = fileURLToPath(new URL("../", import.meta.url));
const svg = (
  await readFile(path.join(root, "app/icons/nextchat-bot.svg"), "utf8")
).replace(/\r\n?/g, "\n");
// Use the repository's original artwork, including its gradients and shadows.
// Rasterize the vector at each target size rather than enlarging a bitmap.
if (/<image\b/i.test(svg) || !/viewBox="0 0 360 360"/.test(svg)) {
  throw new Error("Expected the original NextChat vector icon");
}
const artwork = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360" width="1024" height="1024"><rect width="360" height="360" fill="#315EF8"/><g transform="translate(36 36) scale(.8)">${artwork}</g></svg>`;
const version = createHash("sha256")
  .update(svg + maskableSvg)
  .digest("hex")
  .slice(0, 12);
const check = process.argv.includes("--check");
const generated = new Map();
generated.set("public/icon.svg", Buffer.from(svg));
const asset = (size) => `/icons/nextchat-${version}-${size}.png`;
const maskableAsset = (size) =>
  `/icons/nextchat-${version}-maskable-${size}.png`;
const render = (size, maskable = false) => {
  const result = new Resvg(maskable ? maskableSvg : svg, {
    fitTo: { mode: "width", value: size },
  }).render();
  if (result.width !== size || result.height !== size) {
    throw new Error(`Icon must be ${size} x ${size}`);
  }
  if (maskable) {
    const pixels = result.pixels;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255)
        throw new Error("Maskable icon background must be opaque");
    }
  }
  return result.asPng();
};
for (const size of [16, 32, 48, 180, 192, 256, 512, 1024]) {
  generated.set(`public${asset(size)}`, render(size));
}
for (const size of [512, 1024]) {
  generated.set(`public${maskableAsset(size)}`, render(size, true));
}
// Compatibility URLs for older browsers and launchers.
for (const [name, size] of [
  ["favicon-16x16.png", 16],
  ["favicon-32x32.png", 32],
  ["apple-touch-icon.png", 180],
  ["android-chrome-192x192.png", 192],
  ["android-chrome-512x512.png", 512],
])
  generated.set(`public/${name}`, generated.get(`public${asset(size)}`));

const sizes = [16, 32, 48, 256];
const icoHeader = Buffer.alloc(6 + 16 * sizes.length);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(sizes.length, 4);
let offset = icoHeader.length;
const images = sizes.map((size, index) => {
  const png = generated.get(`public${asset(size)}`);
  const entry = 6 + index * 16;
  icoHeader[entry] = icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(png.length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  offset += png.length;
  return png;
});
generated.set("public/favicon.ico", Buffer.concat([icoHeader, ...images]));

const manifestUrl = `/icons/site-${version}.webmanifest`;
const manifest = {
  id: "/",
  name: "NextChat",
  short_name: "NextChat",
  icons: [192, 512, 1024]
    .map((size) => ({
      src: asset(size),
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    }))
    .concat(
      [512, 1024].map((size) => ({
        src: maskableAsset(size),
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "maskable",
      })),
    ),
  start_url: "/",
  scope: "/",
  theme_color: "#315EF8",
  background_color: "#FFFFFF",
  display: "standalone",
};
const json = (value) => JSON.stringify(value, null, 2) + "\n";
generated.set(`public${manifestUrl}`, Buffer.from(json(manifest)));
generated.set("public/site.webmanifest", Buffer.from(json(manifest)));
generated.set(
  "app/icon-assets.json",
  Buffer.from(
    json({
      favicon: asset(192),
      shortcut: asset(512),
      apple: asset(180),
      manifest: manifestUrl,
      svg: `/icon.svg?v=${version}`,
    }),
  ),
);

for (const [relative, expected] of generated) {
  const target = path.join(root, relative);
  if (check) {
    const actual = await readFile(target);
    if (!actual.equals(expected))
      throw new Error(`Regenerate icon asset: ${relative}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, expected);
  }
}
console.log(
  `HD icons ${check ? "verified" : "generated"}: ${version} (up to 1024px)`,
);
