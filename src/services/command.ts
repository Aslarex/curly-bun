import type { GlobalInit, RequestInit } from '../types';
import {
  CURL,
  CIPHERS,
  DEFAULT_DNS_SERVERS,
  CURL_VERSION,
  CURL_OUTPUT,
} from '../models/constants';
import formatProxyString from '../models/proxy';
import {
  compareVersions,
  containsAlphabet,
  determineContentType,
  getDefaultPort,
  hasJsonStructure,
  isValidIPv4,
} from '../models/utils';
import { Buffer } from 'buffer';
import { LocalCache } from './local_cache';
import { dns } from 'bun';

const SUPPORTS = {
  HTTP2: CURL_OUTPUT.indexOf('http2') !== -1,
  DNS_SERVERS: CURL_OUTPUT.indexOf('c-ares') !== -1,
  DNS_RESOLVE: compareVersions(CURL_VERSION, '7.21.3') >= 0,
  TCP_FASTOPEN: compareVersions(CURL_VERSION, '7.49.0') >= 0,
  TCP_NODELAY: compareVersions(CURL_VERSION, '7.11.2') >= 0,
  CIPHERS: (() => {
    const libs = [
      'openssl',
      'libressl',
      'boringssl',
      'quictls',
      'wolfssl',
      'gnutls',
    ];
    return libs.some(lib => CURL_OUTPUT.indexOf(lib) !== -1);
  })(),
};

const DNS_CACHE_MAP = new LocalCache<string>({
  maxItems: 255,
  noInterval: true,
});

/**
 * Helper: Build a multipart/form-data payload from a FormData instance.
 * Returns a Buffer payload and the boundary string.
 */
async function buildMultipartBody(
  formData: FormData
): Promise<{ body: Buffer; boundary: string }> {
  const boundary =
    '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts: Buffer[] = [];

  // Collect all entries from FormData.
  const entries: [string, FormDataEntryValue][] = [];
  formData.forEach((value, key) => {
    entries.push([key, value]);
  });

  // Loop over the collected entries sequentially.
  for (const [key, value] of entries) {
    let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${key}"`;
    let contentBuffer: Buffer;

    if (value instanceof Blob) {
      // For file fields, add filename and Content-Type.
      const fileName = (value as File).name || 'file';
      const fileType = (value as File).type || 'application/octet-stream';
      headers += `; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`;
      const arrayBuffer = await value.arrayBuffer();
      contentBuffer = Buffer.from(arrayBuffer);
    } else {
      // For normal fields.
      headers += '\r\n\r\n';
      contentBuffer = Buffer.from(String(value), 'utf-8');
    }

    parts.push(Buffer.from(headers, 'utf-8'));
    parts.push(contentBuffer);
    parts.push(Buffer.from('\r\n', 'utf-8'));
  }

  // Append the closing boundary.
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));

  return { body: Buffer.concat(parts), boundary };
}

/**
 * Helper: Prepare the request body.
 * Converts various body types (string, object, URLSearchParams, FormData, Blob,
 * ReadableStream, or BufferSource) into either a string or Buffer and returns
 * any headers that need to be set.
 */
async function prepareRequestBody(
  body: any
): Promise<{ body: string | Buffer; type?: string }> {
  // URLSearchParams: convert to URL-encoded string.
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      type: 'application/x-www-form-urlencoded',
    };
  }

  // FormData: build multipart/form-data.
  if (body instanceof FormData) {
    const { body: multipartBody, boundary } = await buildMultipartBody(body);
    return {
      body: multipartBody,
      type: `multipart/form-data; boundary=${boundary}`,
    };
  }

  // Blob: convert to Buffer.
  if (body instanceof Blob) {
    const arrayBuffer = await body.arrayBuffer();
    return { body: Buffer.from(arrayBuffer) };
  }

  // ReadableStream: read and concatenate all chunks.
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (value) chunks.push(value);
      done = streamDone;
    }
    return { body: Buffer.concat(chunks) };
  }

  // BufferSource: ArrayBuffer or TypedArray.
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { body: Buffer.from(body as ArrayBuffer) };
  }

  // Plain object: assume JSON.
  if (typeof body === 'object' && hasJsonStructure(body)) {
    return {
      body: JSON.stringify(body),
      type: 'application/json',
    };
  }

  // Fallback: convert to string.
  const strBody = String(body);
  return { body: strBody, type: determineContentType(strBody) };
}

/**
 * Main BuildCommand function.
 * Constructs the curl command for Bun.spawn based on options.
 */
export default async function BuildCommand<T>(
  url: URL,
  options: RequestInit<T>,
  init: GlobalInit
) {
  if (options.transformRequest) {
    options = options.transformRequest({ url: url.toString(), ...options });
  } else if (init.transfomRequest && options.transformRequest !== false) {
    options = init.transfomRequest({ url: url.toString(), ...options });
  }

  // Set default values.
  const maxTime = options.maxTime ?? 10;
  const connectionTimeout = options.connectionTimeout ?? 5;
  const compress = options.compress!;
  const ciphers_tls12 = options.tls?.ciphers?.TLS12 ?? CIPHERS['TLS12'];
  const ciphers_tls13 = options.tls?.ciphers?.TLS13 ?? CIPHERS['TLS13'];
  const tls_insecure = options.tls?.insecure ?? false;
  const tls_versions = options.tls?.versions ?? [1.3, 1.2];
  const httpVersion = options.http?.version ?? (SUPPORTS.HTTP2 ? 2.0 : 1.1);
  const dnsServers = options.dns?.servers ?? DEFAULT_DNS_SERVERS;

  // Build the base curl command.
  const command: string[] = [
    CURL.BASE,
    CURL.INFO,
    CURL.SILENT,
    CURL.SHOW_ERROR,
    CURL.WRITE_OUT,
    '\nFinal-Url:%{url_effective}',
    CURL.TIMEOUT,
    String(maxTime),
    CURL.CONNECT_TIMEOUT,
    String(connectionTimeout),
    CURL.HTTP_VERSION[httpVersion],
  ];

  if (tls_insecure) {
    command.push(CURL.INSECURE);
  }

  if (tls_versions.includes(1.2)) {
    command.push(CURL.TLSv1_2);
    if (SUPPORTS.CIPHERS) {
      command.push(
        CURL.CIPHERS,
        Array.isArray(ciphers_tls12) ? ciphers_tls12.join(':') : ciphers_tls12
      );
    }
  }

  if (tls_versions.includes(1.3)) {
    const delta = tls_versions.includes(1.2)
      ? [CURL.TLS_MAX, '1.3']
      : [CURL.TLSv1_3];
    command.push(...delta);
    if (SUPPORTS.CIPHERS) {
      command.push(
        CURL.TLS13_CIPHERS,
        Array.isArray(ciphers_tls13) ? ciphers_tls13.join(':') : ciphers_tls13
      );
    }
  }

  if (compress) {
    command.push(CURL.COMPRESSED);
  }

  if (SUPPORTS.DNS_SERVERS) {
    command.push(CURL.DNS_SERVERS, dnsServers.join(','));
  }

  if (SUPPORTS.DNS_RESOLVE && containsAlphabet(url.host)) {
    let i: string | null = null,
      resolveIP =
        (options.dns?.resolve ?? options.dns?.cache !== false)
          ? ((i = DNS_CACHE_MAP.get(url.host)), i)
          : null;
    if (!resolveIP) {
      const lookup = await dns.lookup(url.host, { family: 4 });
      if (lookup.length) {
        resolveIP = lookup[0].address;
      }
    }
    if (resolveIP && isValidIPv4(resolveIP)) {
      if (options.dns?.cache !== false && !i) {
        DNS_CACHE_MAP.set(url.host, resolveIP, options.dns?.cache ?? 300);
      }
      const port = getDefaultPort(url.protocol);
      command.push(CURL.DNS_RESOLVE, `${url.host}:${port}:${resolveIP}`);
    }
  }

  if (
    init.tcp?.fastOpen &&
    httpVersion !== 1.1 &&
    !options.http?.keepAlive &&
    SUPPORTS.TCP_FASTOPEN
  ) {
    command.push(CURL.TCP_FASTOPEN);
  }

  if (init.tcp?.noDelay && SUPPORTS.TCP_NODELAY) {
    command.push(CURL.TCP_NODELAY);
  }

  if (options.proxy) {
    command.push(CURL.PROXY, formatProxyString(options.proxy));
  }

  if (options.follow !== undefined && options.follow !== false) {
    command.push(
      CURL.FOLLOW,
      CURL.MAX_REDIRS,
      typeof options.follow === 'number' ? String(options.follow) : '10'
    );
  }

  if (httpVersion === 1.1) {
    if (options.http?.keepAlive === false || options.http?.keepAlive === 0) {
      command.push(CURL.NO_KEEPALIVE);
    } else if (typeof options.http?.keepAlive === 'number') {
      command.push(CURL.KEEPALIVE_TIME, String(options.http.keepAlive));
    }
    if (typeof options.http?.keepAliveProbes === 'number') {
      command.push(CURL.KEEPALIVE_CNT, String(options.http.keepAliveProbes));
    }
  }

  // --- Build headers ---
  const headers: Headers = !options.headers
    ? new Headers()
    : options.headers instanceof Headers
      ? options.headers
      : new Headers(
          Object.entries(options.headers)
            .filter(([_, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)] as [string, string])
        );

  if (options.body) {
    const prepared = await prepareRequestBody(options.body);

    if (prepared.type && !headers.has('content-type')) {
      headers.set('content-type', prepared.type);
    }

    if (typeof prepared.body === 'string') {
      command.push(CURL.DATA_RAW, prepared.body);
    } else {
      command.push(CURL.DATA_RAW, prepared.body.toString('utf-8'));
    }
  }

  // Set default user agent if not provided.
  if (!headers.has('user-agent') && init.defaultAgent) {
    command.push(CURL.USER_AGENT, init.defaultAgent);
  }

  // Append headers to the command.
  for (const [key, value] of headers as unknown as Iterable<[string, string]>) {
    command.push(CURL.HEADER, `${key}: ${value}`);
  }

  command.push(CURL.METHOD, options.method!.toUpperCase());

  // Properly encode [ and ] in the URL.
  command.push(url.toString().replaceAll('[', '%5B').replaceAll(']', '%5D'));

  return command;
}
