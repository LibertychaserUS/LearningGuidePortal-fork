// Courseware for the whiteboard (2026-11-02), modelled on BigBlueButton's
// presentation upload: the host uploads a PDF, an Office document or an
// image, or imports a web page; the server turns it into one PDF; every
// browser renders the same pages and the boards are drawn on top of them.
//
// Pure: no I/O. The conversion runs behind ports (presentationService.ts).

import { STAGE_LIMITS } from "./stage";

// BigBlueButton's defaults are 30 MB and 200 pages (bigbluebutton.properties
// maxFileSizeUpload, maxNumPages).
export const PRESENTATION_LIMITS = { maxBytes: 30 * 1024 * 1024, maxPages: STAGE_LIMITS.maxPages, maxNameLength: 120, maxUrlLength: 2048, perSession: 20 } as const;

export type PresentationSource = "pdf" | "office" | "image" | "web";

export type PresentationErrorCode =
  | "too_large"
  | "unsupported"
  | "empty"
  | "page_count_exceeded"
  | "conversion_failed"
  | "conversion_timeout"
  | "encrypted"
  | "blocked_url"
  | "unreachable"
  | "too_many"
  | "in_use";

export type Presentation = Readonly<{
  id: string;
  sessionId: string;
  name: string;
  source: PresentationSource;
  // The file extension or the web page address it came from.
  origin: string;
  status: "converting" | "ready" | "failed";
  error?: PresentationErrorCode;
  pageCount: number;
  uploadedBy: string;
  createdAt: string;
  // sha-256 of the uploaded bytes, or of the normalised URL: the same file
  // uploaded twice to one session is one presentation.
  contentKey: string;
}>;

export class PresentationError extends Error {
  readonly code: PresentationErrorCode;

  constructor(code: PresentationErrorCode) {
    super(code);
    this.name = "PresentationError";
    this.code = code;
  }
}

const OFFICE = ["ppt", "pptx", "pps", "ppsx", "odp", "doc", "docx", "odt", "rtf"];
const IMAGES = ["png", "jpg", "jpeg"];

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

// Decides what an upload is from its first bytes, and accepts it only when
// the name's extension agrees. A renamed executable or HTML page is refused
// here, before any converter sees it.
export function sniffUpload(name: string, bytes: Uint8Array): { source: Exclude<PresentationSource, "web">; extension: string } {
  if (!bytes.length) throw new PresentationError("empty");
  if (bytes.length > PRESENTATION_LIMITS.maxBytes) throw new PresentationError("too_large");
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  const pdf = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  const ole = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const png = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
  const rtf = startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
  if (extension === "pdf" && pdf) return { source: "pdf", extension };
  if (["pptx", "ppsx", "docx", "odp", "odt"].includes(extension) && zip) return { source: "office", extension };
  if (["ppt", "pps", "doc"].includes(extension) && ole) return { source: "office", extension };
  if (extension === "rtf" && rtf) return { source: "office", extension };
  if (extension === "png" && png) return { source: "image", extension };
  if ((extension === "jpg" || extension === "jpeg") && jpeg) return { source: "image", extension };
  throw new PresentationError("unsupported");
}

export const ACCEPTED_EXTENSIONS = ["pdf", ...OFFICE, ...IMAGES] as const;

// A file name as shown in the list: no path, no control characters, bounded.
export function displayName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PRESENTATION_LIMITS.maxNameLength);
  return clean || "courseware";
}

// The web page address a host typed. Only http(s), no credentials, no IP
// literal outside the public internet; the host name is checked again after
// DNS (isPublicAddress) and for every request the page makes.
export function parseImportUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim() || raw.length > PRESENTATION_LIMITS.maxUrlLength) throw new PresentationError("blocked_url");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PresentationError("blocked_url");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) throw new PresentationError("blocked_url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (!isPublicAddress(host)) throw new PresentationError("blocked_url");
  } else if (!/\.[a-z]{2,}$/i.test(host) || /\.(?:local|localhost|internal|lan|home|corp)$/i.test(host)) {
    throw new PresentationError("blocked_url");
  }
  url.hash = "";
  return url;
}

function ipv4(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

// True only for addresses on the public internet: no loopback, private,
// link-local (cloud metadata lives at 169.254.169.254), CGNAT, multicast or
// reserved ranges, in IPv4, IPv6 or IPv4-mapped IPv6.
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (v4[2] === 0 || v4[2] === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && v4[2] === 100))) return false;
    if (a === 203 && b === 0 && v4[2] === 113) return false;
    return true;
  }
  const v6 = address.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(v6) || !v6.includes(":")) return false;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:([\d.]+)$/.exec(v6) ?? /^::ffff:([\d.]+)$/.exec(v6);
  if (mapped) return isPublicAddress(mapped[1]);
  if (v6 === "::" || v6 === "::1") return false;
  const first = parseInt(v6.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && parseInt(v6.split(":")[1] || "0", 16) === 0x0db8) return false; // documentation
  if (first === 0 || first === 0x0064) return false; // ::/8 (incl. compat), 64:ff9b::/96 NAT64
  return (first & 0xe000) === 0x2000; // 2000::/3 global unicast
}
