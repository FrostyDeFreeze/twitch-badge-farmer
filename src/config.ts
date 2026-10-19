import type { Config } from './types.ts'
import { readFile } from 'node:fs/promises'

export async function readConfig(path: string | URL): Promise<unknown> {
	let text

	try {
		text = await readFile(path, 'utf8')
	} catch (cause) {
		if (!(cause instanceof Error)) throw cause

		const error = new Error(
			cause.code === 'ENOENT' ? 'Config not found, run with --gen-token' : 'Could not read config JSON (' + cause.code + ')'
		)

		error.code = cause.code

		throw error
	}

	try {
		return JSON.parse(text.replace(/^\uFEFF/, ''))
	} catch {
		throw new Error('Invalid config JSON')
	}
}

export function validateConfig(input: unknown): Config {
	const fields = ['login', 'client_id', 'token'] as const
	const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
	const config: Config = { id: String(record.id || '').trim(), login: '', client_id: '', token: '' }

	for (const field of fields) {
		config[field] = typeof record[field] === 'string' ? record[field].trim() : ''
	}

	config.login = config.login.toLowerCase()
	config.token = config.token.replace(/^oauth:/i, '').trim()

	if (Object.values(config).some(value => !value) || config.token === 'your_oauth_token') {
		throw new Error('Config requires id, login, client_id and token, run with --gen-token')
	}

	return config
}
