import { parseSimulationSpec, type SimulationSpec, type SpecIssue } from '@distlab/shared';

/**
 * Scenarios travel in the URL fragment, compressed. The fragment is never sent
 * to a server, so sharing a link shares a scenario without any backend — and
 * without the scenario leaving the browser until someone chooses to paste it.
 */

const PREFIX_DEFLATE = 'z.';
const PREFIX_PLAIN = 'j.';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export async function encodeSpec(spec: SimulationSpec): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(spec));
  if (typeof CompressionStream === 'undefined') return PREFIX_PLAIN + toBase64Url(json);
  return PREFIX_DEFLATE + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeSpec(
  token: string,
): Promise<{ spec: SimulationSpec } | { errors: readonly SpecIssue[] }> {
  try {
    let bytes: Uint8Array;
    if (token.startsWith(PREFIX_DEFLATE)) {
      bytes = await pipe(fromBase64Url(token.slice(PREFIX_DEFLATE.length)), new DecompressionStream('deflate-raw'));
    } else if (token.startsWith(PREFIX_PLAIN)) {
      bytes = fromBase64Url(token.slice(PREFIX_PLAIN.length));
    } else {
      return { errors: [{ path: '', message: 'unrecognised share link' }] };
    }
    return parseSimulationSpec(new TextDecoder().decode(bytes));
  } catch (error) {
    return { errors: [{ path: '', message: `could not read share link: ${(error as Error).message}` }] };
  }
}

export async function shareUrl(spec: SimulationSpec): Promise<string> {
  const url = new URL(window.location.href);
  url.hash = `s=${await encodeSpec(spec)}`;
  return url.toString();
}

export function sharedTokenFromLocation(): string | undefined {
  const match = /(?:^#|&)s=([^&]+)/.exec(window.location.hash);
  return match?.[1];
}
