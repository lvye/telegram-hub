import { connect } from 'cloudflare:sockets';

const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

export type NitterRssTransport = (
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	timeoutMs: number,
	maxBodyBytes: number,
) => Promise<Response>;

/**
 * Nitter's public instances block Cloudflare's normal HTTP egress. A narrowly
 * scoped TLS socket keeps the same HTTPS origin and certificate validation but
 * uses Workers' direct TCP egress prefix instead of the HTTP fetch proxy.
 */
export const fetchNitterRssOverTls: NitterRssTransport = async (
	input,
	init,
	timeoutMs,
	maxBodyBytes,
) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (request.method !== 'GET') throw new Error('Nitter TLS transport only supports GET');
	if (url.protocol !== 'https:' || (url.port && url.port !== '443')) {
		throw new Error('Nitter TLS transport requires HTTPS on port 443');
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error('Nitter TLS transport timeout must be a positive integer');
	}

	const socket = connect(
		{ hostname: url.hostname, port: 443 },
		{ secureTransport: 'on', allowHalfOpen: true },
	);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = readSocketResponse(socket, request, url, maxBodyBytes);
		const expired = new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error(`Nitter TLS request timed out after ${timeoutMs} ms`)),
				timeoutMs,
			);
		});
		return await Promise.race([response, expired]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		await socket.close().catch(() => undefined);
	}
};

async function readSocketResponse(
	socket: ReturnType<typeof connect>,
	request: Request,
	url: URL,
	maxBodyBytes: number,
): Promise<Response> {
	await socket.opened;
	const writer = socket.writable.getWriter();
	const headers = new Headers(request.headers);
	headers.set('accept-encoding', 'identity');
	headers.set('connection', 'close');
	headers.set('host', url.hostname);
	const requestLines = [
		`GET ${url.pathname}${url.search} HTTP/1.1`,
		...['host', 'accept', 'accept-language', 'accept-encoding', 'user-agent', 'connection']
			.flatMap((name) => {
				const value = headers.get(name);
				return value ? [`${httpHeaderName(name)}: ${value}`] : [];
			}),
		'',
		'',
	];
	await writer.write(new TextEncoder().encode(requestLines.join('\r\n')));
	writer.releaseLock();

	const reader = socket.readable.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBodyBytes + MAX_RESPONSE_HEADER_BYTES) {
				throw new Error(`Nitter TLS response exceeds ${maxBodyBytes} body bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return decodeNitterHttpResponse(joinBytes(chunks, totalBytes), maxBodyBytes);
}

export function decodeNitterHttpResponse(raw: Uint8Array, maxBodyBytes: number): Response {
	const headerEnd = indexOfBytes(raw, HEADER_END);
	if (headerEnd < 0 || headerEnd > MAX_RESPONSE_HEADER_BYTES) {
		throw new Error('Nitter TLS response has invalid or oversized headers');
	}
	const headerText = new TextDecoder().decode(raw.subarray(0, headerEnd));
	const [statusLine, ...headerLines] = headerText.split('\r\n');
	const statusMatch = statusLine?.match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/u);
	if (!statusMatch) throw new Error('Nitter TLS response has an invalid status line');
	const status = Number(statusMatch[1]);
	if (status < 200 || status > 599) {
		throw new Error(`Nitter TLS response returned unsupported HTTP ${status}`);
	}

	const headers = new Headers();
	for (const line of headerLines) {
		const separator = line.indexOf(':');
		if (separator <= 0) throw new Error('Nitter TLS response has an invalid header');
		headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	const contentEncoding = headers.get('content-encoding')?.toLowerCase();
	if (contentEncoding && contentEncoding !== 'identity') {
		throw new Error(`Nitter TLS response uses unsupported encoding ${contentEncoding}`);
	}

	const encodedBody = raw.subarray(headerEnd + HEADER_END.byteLength);
	const body = headers.get('transfer-encoding')?.toLowerCase().includes('chunked')
		? decodeChunkedBody(encodedBody, maxBodyBytes)
		: contentLengthBody(encodedBody, headers.get('content-length'), maxBodyBytes);
	return new Response(body, {
		status,
		statusText: statusMatch[2] ?? '',
		headers,
	});
}

function contentLengthBody(
	body: Uint8Array,
	contentLength: string | null,
	maxBodyBytes: number,
): Uint8Array {
	if (contentLength === null) {
		if (body.byteLength > maxBodyBytes) throw bodyTooLarge(maxBodyBytes);
		return body;
	}
	if (!/^\d+$/u.test(contentLength)) throw new Error('Nitter TLS response has invalid content-length');
	const expected = Number(contentLength);
	if (!Number.isSafeInteger(expected)) throw new Error('Nitter TLS content-length is unsafe');
	if (expected > maxBodyBytes) throw bodyTooLarge(maxBodyBytes);
	if (body.byteLength < expected) throw new Error('Nitter TLS response body is truncated');
	return body.subarray(0, expected);
}

function decodeChunkedBody(encoded: Uint8Array, maxBodyBytes: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let totalBytes = 0;
	while (offset < encoded.byteLength) {
		const lineEnd = indexOfBytes(encoded, CRLF, offset);
		if (lineEnd < 0) throw new Error('Nitter TLS response has an invalid chunk size');
		const sizeLine = new TextDecoder().decode(encoded.subarray(offset, lineEnd));
		const sizeToken = sizeLine.split(';', 1)[0]?.trim() ?? '';
		if (!/^[0-9a-f]+$/iu.test(sizeToken)) {
			throw new Error('Nitter TLS response has an invalid chunk size');
		}
		const size = Number.parseInt(sizeToken, 16);
		offset = lineEnd + CRLF.byteLength;
		if (size === 0) return joinBytes(chunks, totalBytes);
		if (size > maxBodyBytes - totalBytes) throw bodyTooLarge(maxBodyBytes);
		const chunkEnd = offset + size;
		if (
			chunkEnd + CRLF.byteLength > encoded.byteLength
			|| indexOfBytes(encoded, CRLF, chunkEnd) !== chunkEnd
		) {
			throw new Error('Nitter TLS response contains a truncated chunk');
		}
		chunks.push(encoded.subarray(offset, chunkEnd));
		totalBytes += size;
		offset = chunkEnd + CRLF.byteLength;
	}
	throw new Error('Nitter TLS response is missing the final chunk');
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	outer: for (let index = from; index <= haystack.byteLength - needle.byteLength; index += 1) {
		for (let offset = 0; offset < needle.byteLength; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) continue outer;
		}
		return index;
	}
	return -1;
}

function joinBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
	const joined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

function httpHeaderName(name: string): string {
	return name.split('-').map((part) => (
		part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part
	)).join('-');
}

function bodyTooLarge(maxBodyBytes: number): Error {
	return new Error(`Nitter TLS response exceeds ${maxBodyBytes} body bytes`);
}
