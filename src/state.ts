import type { CollectorState } from './types.ts'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function loadState(path: string, id: string): Promise<CollectorState> {
	let text

	try {
		text = await readFile(path, 'utf8')
	} catch (error) {
		if (!(error instanceof Error)) throw error

		if (error.code === 'ENOENT') {
			return { version: 1, id, confirmed: [], attempts: {}, active: null }
		}

		throw new Error('Could not read state: ' + error.code)
	}

	let state: unknown

	try {
		state = JSON.parse(text.replace(/^\uFEFF/, ''))
	} catch {
		throw new Error('Invalid state JSON, original file preserved')
	}

	if (
		!state ||
		typeof state !== 'object' ||
		!('version' in state) ||
		state.version !== 1 ||
		!('id' in state) ||
		state.id !== id ||
		!('confirmed' in state) ||
		!Array.isArray(state.confirmed) ||
		!('attempts' in state) ||
		!state.attempts ||
		typeof state.attempts !== 'object' ||
		Array.isArray(state.attempts)
	) {
		throw new Error('State belongs to another account or has an unsupported format')
	}

	for (const attempt of Object.values(state.attempts)) {
		if (
			!attempt ||
			typeof attempt !== 'object' ||
			('dailyWindow' in attempt && typeof attempt.dailyWindow !== 'string') ||
			('dailyCompletedWindow' in attempt && typeof attempt.dailyCompletedWindow !== 'string') ||
			('dailyCompletedDays' in attempt &&
				(typeof attempt.dailyCompletedDays !== 'number' ||
					!Number.isSafeInteger(attempt.dailyCompletedDays) ||
					attempt.dailyCompletedDays < 0)) ||
			('claimedInstance' in attempt && typeof attempt.claimedInstance !== 'string') ||
			('claimPendingAt' in attempt &&
				(typeof attempt.claimPendingAt !== 'number' || !Number.isFinite(attempt.claimPendingAt) || attempt.claimPendingAt < 0))
		) {
			throw new Error('Invalid daily resume state, original file preserved')
		}
	}

	return state as CollectorState
}

export async function saveState(path: string, state: CollectorState) {
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
