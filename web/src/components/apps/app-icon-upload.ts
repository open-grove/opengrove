import { APP_CUSTOM_ICON_DATA_URL_MAX_LENGTH } from "../../../../src/app-icons/catalog";

const APP_ICON_SOURCE_MAX_BYTES = 2_000_000;
const APP_ICON_RASTER_SIZE = 512;
const ACCEPTED_MIME_TYPES = new Set(["image/png", "image/webp", "image/svg+xml"]);
const SAFE_SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "title",
  "desc",
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "xmlns",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "clip-rule",
  "clip-path",
  "mask",
  "opacity",
  "transform",
  "rx",
  "ry",
  "r",
  "cx",
  "cy",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "id",
]);

export type AppIconUploadErrorCode =
  | "unsupported_type"
  | "too_large"
  | "invalid_svg"
  | "decode_failed"
  | "output_too_large";

export async function prepareAppIconUpload(file: File): Promise<string> {
  const mime = normalizedMimeType(file);
  if (!ACCEPTED_MIME_TYPES.has(mime)) throw appIconUploadError("unsupported_type");
  if (!file.size || file.size > APP_ICON_SOURCE_MAX_BYTES) throw appIconUploadError("too_large");

  const source = mime === "image/svg+xml" ? sanitizedSvgBlob(await file.text()) : file;
  const objectUrl = URL.createObjectURL(source);
  try {
    const image = await loadImage(objectUrl);
    const dataUrl = rasterizeIcon(image);
    if (dataUrl.length > APP_CUSTOM_ICON_DATA_URL_MAX_LENGTH) {
      throw appIconUploadError("output_too_large");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function appIconUploadErrorCode(error: unknown): AppIconUploadErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "unsupported_type" ||
    message === "too_large" ||
    message === "invalid_svg" ||
    message === "decode_failed" ||
    message === "output_too_large"
  ) {
    return message;
  }
  return "decode_failed";
}

function normalizedMimeType(file: File): string {
  const mime = file.type.trim().toLowerCase();
  if (mime) return mime;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  return "";
}

function sanitizedSvgBlob(source: string): Blob {
  if (/<!doctype|<!entity/i.test(source)) throw appIconUploadError("invalid_svg");
  const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = documentNode.documentElement;
  if (root.localName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) {
    throw appIconUploadError("invalid_svg");
  }

  for (const element of [...documentNode.querySelectorAll("*")]) {
    if (!SAFE_SVG_ELEMENTS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name === "href" ||
        name.startsWith("xlink:") ||
        !SAFE_SVG_ATTRIBUTES.has(name) ||
        /(?:javascript|data|https?|file):/i.test(value) ||
        (value.includes("url(") && !/^url\(#[a-z0-9_.:-]+\)$/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const sanitized = new XMLSerializer().serializeToString(root);
  if (!sanitized.includes("<svg")) throw appIconUploadError("invalid_svg");
  return new Blob([sanitized], { type: "image/svg+xml" });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(appIconUploadError("decode_failed"));
    image.src = source;
  });
}

function rasterizeIcon(image: HTMLImageElement): string {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw appIconUploadError("decode_failed");
  const canvas = document.createElement("canvas");
  canvas.width = APP_ICON_RASTER_SIZE;
  canvas.height = APP_ICON_RASTER_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw appIconUploadError("decode_failed");
  const scale = Math.min(APP_ICON_RASTER_SIZE / width, APP_ICON_RASTER_SIZE / height);
  const renderedWidth = Math.max(1, Math.round(width * scale));
  const renderedHeight = Math.max(1, Math.round(height * scale));
  context.drawImage(
    image,
    Math.round((APP_ICON_RASTER_SIZE - renderedWidth) / 2),
    Math.round((APP_ICON_RASTER_SIZE - renderedHeight) / 2),
    renderedWidth,
    renderedHeight,
  );
  const webp = canvas.toDataURL("image/webp", 0.92);
  return webp.startsWith("data:image/webp;") ? webp : canvas.toDataURL("image/png");
}

function appIconUploadError(code: AppIconUploadErrorCode): Error {
  return new Error(code);
}
