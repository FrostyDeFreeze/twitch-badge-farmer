import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function loadState(path, id) {
	let text

	try {
		text = await readFile(path, 'utf8')
	} catch (error) {
		if (error.code === 'ENOENT') {
			return { version: 1, id, confirmed: [], attempts: {}, active: null }
		}

		throw new Error('Could not read state: ' + error.code)
	}

	let state

	try {
		state = JSON.parse(text.replace(/^\uFEFF/, ''))
	} catch {
		throw new Error('Invalid state JSON, original file preserved')
	}

	if (state?.version !== 1 || state.id !== id || !Array.isArray(state.confirmed) || !state.attempts || typeof state.attempts !== 'object') {
		throw new Error('State belongs to another account or has an unsupported format')
	}

	return state
}

export async function saveState(path, state) {
	const temp = path + '.' + randomUUID() + '.tmp'

	try {
		await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true })
		await rename(temp, path)
	} finally {
		await unlink(temp).catch(error => {
			if (error.code !== 'ENOENT') throw error
		})
	}
}
