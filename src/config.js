import { readFile } from 'node:fs/promises'

export async function readConfig(path) {
	let text

	try {
		text = await readFile(path, 'utf8')
	} catch (cause) {
		const error = new Error(
			cause.code === 'ENOENT' ? 'Config not found, run npm run gen-token' : 'Could not read config JSON (' + cause.code + ')'
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

export function validateConfig(input) {
	const fields = ['login', 'client_id', 'token']
	const config = { id: String(input?.id || '').trim() }

	for (const field of fields) {
		config[field] = typeof input?.[field] === 'string' ? input[field].trim() : ''
	}

	config.login = config.login.toLowerCase()
	config.token = config.token.replace(/^oauth:/i, '').trim()

	if (Object.values(config).some(value => !value) || config.token === 'your_oauth_token') {
		throw new Error('Config requires id, login, client_id and token, run npm run gen-token')
	}

	return config
}
