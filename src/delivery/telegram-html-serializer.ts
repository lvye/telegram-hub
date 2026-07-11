import { Parser, parseDocument } from 'htmlparser2';
import {
	hasChildren,
	isTag,
	isText,
	type ChildNode,
	type Element,
} from 'domhandler';

export interface TelegramHtmlRenderOptions {
	maxTextLength?: number;
	preserveLineBreaks?: boolean;
	transformText?: (text: string) => string;
}

export interface TelegramHtmlRenderResult {
	text: string;
	html: string;
}

interface RenderedFragment {
	text: string;
	html: string;
}

interface RenderContext {
	depth: number;
	entity: 'a' | 'blockquote' | null;
	styles: ReadonlySet<string>;
}

const EMPTY_FRAGMENT: RenderedFragment = { text: '', html: '' };
const ROOT_CONTEXT: RenderContext = { depth: 0, entity: null, styles: new Set() };
const MAX_RENDER_DEPTH = 32;
const MAX_LINK_LENGTH = 2_048;
const BLOCK_TAGS = new Set([
	'address',
	'article',
	'aside',
	'details',
	'div',
	'figcaption',
	'figure',
	'footer',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'main',
	'nav',
	'p',
	'section',
]);
const DROPPED_TAGS = new Set([
	'embed',
	'frame',
	'iframe',
	'math',
	'noscript',
	'object',
	'script',
	'style',
	'svg',
	'template',
]);
const STYLE_TAGS: Readonly<Record<string, string>> = {
	b: 'b',
	strong: 'b',
	i: 'i',
	em: 'i',
	u: 'u',
	ins: 'u',
	s: 's',
	strike: 's',
	del: 's',
};
const TELEGRAM_TAGS = new Set(['a', 'b', 'blockquote', 'code', 'i', 'pre', 's', 'u']);

/**
 * Converts an untrusted HTML fragment into Telegram's supported HTML subset.
 * Source tags and attributes are never copied through directly.
 */
export function renderHtmlForTelegram(
	input: string,
	options: TelegramHtmlRenderOptions = {},
): TelegramHtmlRenderResult {
	if (!input.trim()) return { text: '', html: '' };

	const document = parseDocument(input, {
		decodeEntities: true,
		lowerCaseAttributeNames: true,
		lowerCaseTags: true,
		xmlMode: false,
	});
	const rendered = renderChildren(document.children, options, ROOT_CONTEXT);
	const html = normalizeHtmlLayout(rendered.html);
	const text = telegramHtmlToText(html);

	if (
		options.maxTextLength === undefined
		|| countCodePoints(text) <= options.maxTextLength
	) {
		return { text, html };
	}

	return truncateTelegramHtml(html, Math.max(0, options.maxTextLength));
}

function renderChildren(
	children: ChildNode[],
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	return children.reduce<RenderedFragment>((result, child) => {
		const rendered = renderNode(child, options, context);
		result.text += rendered.text;
		result.html += rendered.html;
		return result;
	}, { text: '', html: '' });
}

function renderNode(
	node: ChildNode,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	if (isText(node)) {
		const transformed = options.transformText?.(node.data) ?? node.data;
		const text = options.preserveLineBreaks
			? normalizeTextWithLineBreaks(transformed)
			: transformed.replace(/\s+/gu, ' ');
		return plainFragment(text);
	}
	if (!isTag(node)) {
		return hasChildren(node)
			? renderChildren(node.children, options, descend(context))
			: EMPTY_FRAGMENT;
	}

	const name = htmlLocalName(node.name);
	if (DROPPED_TAGS.has(name) || name === 'img') return EMPTY_FRAGMENT;
	if (name === 'br') return { text: '\n', html: '\n' };
	if (name === 'hr') return { text: '\n\n', html: '\n\n' };
	if (context.depth >= MAX_RENDER_DEPTH) {
		const text = normalizeInlineText(collectVisibleText(node.children, options));
		return plainFragment(text);
	}

	if (name === 'code') return renderCode(node, options, context);
	if (name === 'pre') return renderPreformatted(node, options, context);
	if (name === 'table') return renderTable(node, options, context);
	if (name === 'ul' || name === 'ol') {
		return renderList(node, options, context, name === 'ol');
	}
	if (name === 'blockquote') return renderBlockquote(node, options, context);
	if (name === 'a') return renderAnchor(node, options, context);

	const style = STYLE_TAGS[name];
	if (style) return renderStyle(node, options, context, style);

	const inner = renderChildren(node.children, options, descend(context));
	if (BLOCK_TAGS.has(name)) {
		const block = trimFragment(inner);
		return block.text
			? { text: `${block.text}\n\n`, html: `${block.html}\n\n` }
			: EMPTY_FRAGMENT;
	}

	return inner;
}

function renderStyle(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
	style: string,
): RenderedFragment {
	const duplicate = context.styles.has(style);
	const childContext = duplicate ? descend(context) : withStyle(context, style);
	const inner = renderChildren(element.children, options, childContext);
	if (!inner.text || duplicate) return inner;
	return { text: inner.text, html: `<${style}>${inner.html}</${style}>` };
}

function renderCode(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	const text = normalizeInlineText(collectVisibleText(element.children, options));
	if (!text) return EMPTY_FRAGMENT;
	return context.entity || context.styles.size > 0
		? plainFragment(text)
		: { text, html: `<code>${escapeHtml(text)}</code>` };
}

function renderAnchor(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	const href = safeHttpUrl(element.attribs.href);
	const canWrap = Boolean(href) && context.entity === null;
	const inner = renderChildren(
		element.children,
		options,
		canWrap ? withEntity(context, 'a') : descend(context),
	);
	if (!inner.text || !canWrap || !href) return inner;

	return {
		text: inner.text,
		html: `<a href="${escapeAttribute(href)}">${inner.html}</a>`,
	};
}

function renderBlockquote(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	const canWrap = context.entity === null;
	const inner = trimFragment(renderChildren(
		element.children,
		options,
		canWrap ? withEntity(context, 'blockquote') : descend(context),
	));
	if (!inner.text) return EMPTY_FRAGMENT;

	return {
		text: `${inner.text}\n\n`,
		html: canWrap
			? `<blockquote>${inner.html}</blockquote>\n\n`
			: `${inner.html}\n\n`,
	};
}

function renderList(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
	ordered: boolean,
): RenderedFragment {
	const items = element.children.filter(
		(child): child is Element => isTag(child) && htmlLocalName(child.name) === 'li',
	);
	if (items.length === 0) {
		return renderChildren(element.children, options, descend(context));
	}

	const rendered = items.map((item, index) => {
		const content = trimFragment(renderChildren(item.children, options, descend(context)));
		const prefix = ordered ? `${index + 1}. ` : '• ';
		return {
			text: `${prefix}${content.text}`.trimEnd(),
			html: `${escapeHtml(prefix)}${content.html}`.trimEnd(),
		};
	}).filter((item) => item.text.trim());

	return {
		text: `${rendered.map((item) => item.text).join('\n')}\n\n`,
		html: `${rendered.map((item) => item.html).join('\n')}\n\n`,
	};
}

function renderPreformatted(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	const text = collectVisibleText(element.children, options).trim();
	if (!text) return EMPTY_FRAGMENT;
	return context.entity || context.styles.size > 0
		? { text: `${text}\n\n`, html: `${escapeHtml(text)}\n\n` }
		: { text: `${text}\n\n`, html: `<pre>${escapeHtml(text)}</pre>\n\n` };
}

function renderTable(
	element: Element,
	options: TelegramHtmlRenderOptions,
	context: RenderContext,
): RenderedFragment {
	const rows = descendantsNamed(element.children, 'tr').map((row) => {
		const cells = row.children
			.filter((child): child is Element => {
				return isTag(child) && ['td', 'th'].includes(htmlLocalName(child.name));
			})
			.map((cell) => normalizeInlineText(collectVisibleText(cell.children, options)));
		return cells.filter(Boolean).join(' | ');
	}).filter(Boolean);
	const text = rows.join('\n');
	if (!text) return EMPTY_FRAGMENT;

	return context.entity || context.styles.size > 0
		? { text: `${text}\n\n`, html: `${escapeHtml(text)}\n\n` }
		: { text: `${text}\n\n`, html: `<pre>${escapeHtml(text)}</pre>\n\n` };
}

function descendantsNamed(children: ChildNode[], name: string): Element[] {
	const matches: Element[] = [];
	const stack = [...children].reverse();
	while (stack.length > 0) {
		const child = stack.pop()!;
		if (!isTag(child)) continue;
		const childName = htmlLocalName(child.name);
		if (childName === name) {
			matches.push(child);
			continue;
		}
		if (!DROPPED_TAGS.has(childName)) {
			stack.push(...[...child.children].reverse());
		}
	}
	return matches;
}

function collectVisibleText(
	children: ChildNode[],
	options: TelegramHtmlRenderOptions,
): string {
	let result = '';
	const stack = [...children].reverse();
	while (stack.length > 0) {
		const child = stack.pop()!;
		if (isText(child)) {
			result += options.transformText?.(child.data) ?? child.data;
			continue;
		}
		if (!isTag(child)) {
			if (hasChildren(child)) stack.push(...[...child.children].reverse());
			continue;
		}
		const name = htmlLocalName(child.name);
		if (DROPPED_TAGS.has(name) || name === 'img') continue;
		if (name === 'br') {
			result += '\n';
			continue;
		}
		stack.push(...[...child.children].reverse());
	}
	return result;
}

function descend(context: RenderContext): RenderContext {
	return { ...context, depth: context.depth + 1 };
}

function htmlLocalName(name: string): string {
	return name.toLowerCase().split(':').at(-1) ?? name.toLowerCase();
}

function withStyle(context: RenderContext, style: string): RenderContext {
	return {
		...context,
		depth: context.depth + 1,
		styles: new Set([...context.styles, style]),
	};
}

function withEntity(context: RenderContext, entity: RenderContext['entity']): RenderContext {
	return { ...context, depth: context.depth + 1, entity };
}

function plainFragment(text: string): RenderedFragment {
	return text ? { text, html: escapeHtml(text) } : EMPTY_FRAGMENT;
}

function normalizeInlineText(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

function normalizeTextWithLineBreaks(value: string): string {
	return value
		.replace(/\r\n?/gu, '\n')
		.replace(/[\t\f\v ]+/gu, ' ')
		.replace(/ *\n */gu, '\n')
		.replace(/\n{3,}/gu, '\n\n');
}

function trimFragment(fragment: RenderedFragment): RenderedFragment {
	return {
		text: fragment.text.trim(),
		html: fragment.html.trim(),
	};
}

function normalizeHtmlLayout(value: string): string {
	return value
		.split(/(<pre>[\s\S]*?<\/pre>)/gu)
		.map((part) => part.startsWith('<pre>')
			? part
			: part
				.replace(/[\t\f\v ]+/gu, ' ')
				.replace(/ *\n */gu, '\n')
				.replace(/\n{3,}/gu, '\n\n'))
		.join('')
		.trim();
}

function telegramHtmlToText(html: string): string {
	let text = '';
	const parser = new Parser({
		ontext(value) {
			text += value;
		},
	}, { decodeEntities: true, xmlMode: false });
	parser.end(html);
	return text;
}

function truncateTelegramHtml(html: string, maxTextLength: number): TelegramHtmlRenderResult {
	let text = '';
	let renderedHtml = '';
	let remaining = maxTextLength;
	let truncated = false;
	const openTags: string[] = [];

	const parser = new Parser({
		onopentag(name, attributes) {
			if (truncated || !TELEGRAM_TAGS.has(name)) return;
			if (name === 'a') {
				const href = safeHttpUrl(attributes.href);
				if (!href) return;
				renderedHtml += `<a href="${escapeAttribute(href)}">`;
				openTags.push(name);
				return;
			}
			renderedHtml += `<${name}>`;
			openTags.push(name);
		},
		ontext(value) {
			if (truncated) return;
			const codePoints = [...value];
			const accepted = codePoints.slice(0, remaining).join('');
			text += accepted;
			renderedHtml += escapeHtml(accepted);
			remaining -= countCodePoints(accepted);
			if (remaining === 0) {
				text += '…';
				renderedHtml += '…';
				truncated = true;
			}
		},
		onclosetag(name) {
			if (truncated || !TELEGRAM_TAGS.has(name)) return;
			const position = openTags.lastIndexOf(name);
			if (position < 0) return;
			for (let index = openTags.length - 1; index >= position; index -= 1) {
				renderedHtml += `</${openTags[index]}>`;
			}
			openTags.length = position;
		},
	}, {
		decodeEntities: true,
		lowerCaseAttributeNames: true,
		lowerCaseTags: true,
		xmlMode: false,
	});
	parser.end(html);

	for (let index = openTags.length - 1; index >= 0; index -= 1) {
		renderedHtml += `</${openTags[index]}>`;
	}

	return { text, html: renderedHtml };
}

function safeHttpUrl(value: string | undefined): string | null {
	if (!value?.trim() || value.length > MAX_LINK_LENGTH) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

function countCodePoints(value: string): number {
	return [...value].length;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/gu, '&amp;')
		.replace(/</gu, '&lt;')
		.replace(/>/gu, '&gt;');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value)
		.replace(/"/gu, '&quot;')
		.replace(/'/gu, '&#39;');
}
