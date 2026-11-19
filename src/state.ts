import type { Attempt, CollectorState } from './types.ts'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const text = (value: unknown) => typeof value === 'string'
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)

function valid(input: unknown, id: string): input is CollectorState {
	const state = input as Partial<CollectorState> | null

	return (
		state?.version === 2 &&
		state.id === id &&
		(state.active === null || text(state.active)) &&
		!!state.attempts &&
		typeof state.attempts === 'object' &&
		!Array.isArray(state.attempts) &&
		Object.values(state.attempts as Record<string, Partial<Attempt> | null>).every(
			attempt =>
				!!attempt &&
				count(attempt.attemptedMs) &&
				count(attempt.deferUntil) &&
				text(attempt.status) &&
				optional(attempt.signature, text) &&
				optional(attempt.dailyWindow, text) &&
				optional(attempt.dailyCompletedWindow, text) &&
				optional(attempt.dailyCompletedDays, value => Number.isSafeInteger(value) && count(value)) &&
				optional(attempt.completedAt, count)
		)
	)
}

export async function loadState(path: string, id: string): Promise<CollectorState> {
	let state: unknown

	try {
		state = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
	} catch (error) {
		if (error instanceof Error && !(error instanceof SyntaxError) && error.code !== 'ENOENT')
			throw new Error('Could not read state: ' + error.code)
	}

	// state only spares repeated work, so a missing, old, foreign or damaged file starts over
	return valid(state, id) ? state : { version: 2, id, active: null, attempts: {} }
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
