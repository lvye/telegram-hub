import { describe, expect, it, vi } from 'vitest';
import { TelegramClient } from '../src/delivery/telegram-client';
import { renderHtmlForTelegram } from '../src/delivery/telegram-html-serializer';

describe('Telegram outbound length limits', () => {
	it.each([
		{ method: 'sendMessage', field: 'text', limit: 4_096 },
		{ method: 'sendPhoto', field: 'caption', limit: 1_024 },
	] as const)('bounds $method decoded text and closes nested HTML', async ({ method, field, limit }) => {
		const fetchMock = vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true, result: { message_id: 12 } }));
		const client = new TelegramClient('fake-token', 1_000);
		const input = `<b><i>${'😀&amp;'.repeat(limit)}</i></b>`;
		const result = method === 'sendMessage'
			? await client.sendMessage('fake-chat', input, 'HTML')
			: await client.sendPhoto('fake-chat', 'https://example.com/image.png', input, 'HTML');
		const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		const expectedText = `${[...'😀&'.repeat(limit)].slice(0, limit - 1).join('')}…`;

		expect(result).toEqual({ messageId: '12' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(`/botfake-token/${method}`);
		expect(payload[field]).toBe(`<b><i>${expectedText.replace(/&/g, '&amp;')}</i></b>`);
		expect([...renderHtmlForTelegram(payload[field]).text]).toHaveLength(limit);
	});

	it.each([1_024, 4_096])('preserves exactly %i decoded characters despite longer HTML encoding', async (limit) => {
		const fetchMock = vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true }));
		const client = new TelegramClient('fake-token', 1_000);
		const input = `<b>${'&amp;'.repeat(limit)}</b>`;
		if (limit === 1_024) {
			await client.sendPhoto('fake-chat', 'https://example.com/image.png', input, 'HTML');
		} else {
			await client.sendMessage('fake-chat', input, 'HTML');
		}
		const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(payload[limit === 1_024 ? 'caption' : 'text']).toBe(input);
	});
});
