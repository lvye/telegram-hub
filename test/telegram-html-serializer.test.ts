import { describe, expect, it } from 'vitest';
import { renderHtmlForTelegram } from '../src/delivery/telegram-html-serializer';

describe('renderHtmlForTelegram', () => {
	it('preserves supported semantics and produces readable Telegram layout', () => {
		const result = renderHtmlForTelegram(`
			<p>Hello <strong>bold</strong> and <em>italic</em>.</p>
			<ol><li>First</li><li>Second<br>line</li></ol>
			<blockquote>Quoted &amp; safe</blockquote>
			<p><a href="https://example.com/?a=1&amp;b=2">Source</a></p>
			<pre><code>const ok = 1 < 2;</code></pre>
		`);

		expect(result).toEqual({
			text: [
				'Hello bold and italic.',
				'',
				'1. First',
				'2. Second',
				'line',
				'',
				'Quoted & safe',
				'',
				'Source',
				'',
				'const ok = 1 < 2;',
			].join('\n'),
			html: [
				'Hello <b>bold</b> and <i>italic</i>.',
				'',
				'1. First',
				'2. Second',
				'line',
				'',
				'<blockquote>Quoted &amp; safe</blockquote>',
				'',
				'<a href="https://example.com/?a=1&amp;b=2">Source</a>',
				'',
				'<pre>const ok = 1 &lt; 2;</pre>',
			].join('\n'),
		});
	});

	it('drops executable content and unsafe links while retaining visible text', () => {
		const result = renderHtmlForTelegram(`
			<p>before<script>alert(1)</script><style>.x{display:none}</style>after</p>
			<a href="javascript:alert(1)">unsafe link</a>
			<iframe src="https://example.com">hidden frame</iframe>
		`);

		expect(result).toEqual({
			text: 'beforeafter\n\nunsafe link',
			html: 'beforeafter\n\nunsafe link',
		});
	});

	it('repairs malformed fragments and closes formatting when truncating', () => {
		const result = renderHtmlForTelegram(
			'<p><strong>abcdefghij<div>tail',
			{ maxTextLength: 8 },
		);

		expect(result.text).toBe('abcdefgh…');
		expect(result.html).toBe('<b>abcdefgh…</b>');
	});

	it('rejects obfuscated protocols and strips all source attributes', () => {
		const result = renderHtmlForTelegram(`
			<custom data-html="<b>">kept</custom>
			<a href="java&#x73;cript:alert(1)" onclick="alert(2)">blocked</a>
			<a href="https://example.com/?a=1&amp;b=2" onclick="alert(3)">allowed</a>
		`);

		expect(result).toEqual({
			text: 'kept blocked allowed',
			html: 'kept blocked <a href="https://example.com/?a=1&amp;b=2">allowed</a>',
		});
	});

	it('truncates on Unicode code-point boundaries', () => {
		const result = renderHtmlForTelegram('<strong>A😀BC</strong>', { maxTextLength: 2 });

		expect(result).toEqual({
			text: 'A😀…',
			html: '<b>A😀…</b>',
		});
	});

	it('downgrades entity combinations that Telegram rejects', () => {
		expect(renderHtmlForTelegram('<code><b>x</b></code>').html).toBe('<code>x</code>');
		expect(renderHtmlForTelegram('<b><code>x</code></b>').html).toBe('<b>x</b>');
		expect(renderHtmlForTelegram('<a href="https://example.com"><code>x</code></a>').html)
			.toBe('<a href="https://example.com/">x</a>');
		expect(renderHtmlForTelegram('<blockquote>outer<blockquote>inner</blockquote></blockquote>').html)
			.toBe('<blockquote>outerinner</blockquote>');
		expect(renderHtmlForTelegram('<blockquote><a href="https://example.com">linked</a></blockquote>').html)
			.toBe('<blockquote>linked</blockquote>');
	});

	it('flattens adversarial nesting without overflowing or inflating output', () => {
		const input = `${'<b>'.repeat(3_000)}x${'</b>'.repeat(3_000)}`;
		const result = renderHtmlForTelegram(input, { maxTextLength: 400 });

		expect(result).toEqual({ text: 'x', html: '<b>x</b>' });
		expect(result.html.length).toBeLessThan(100);
	});
});
