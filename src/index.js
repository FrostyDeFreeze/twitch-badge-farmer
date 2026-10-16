import { resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { readConfig, validateConfig } from './config.js'
import { generateToken } from './gen-token.js'
import { buildTasks, describeSkipped } from './catalog.js'
import { fetchJson } from './fetch.js'
import { Twitch } from './twitch.js'
import { Collector } from './collector.js'
import { loadState, saveState } from './state.js'

function argumentsFor(args) {
	let mode = 'start'
	let configPath = resolve('config.json')

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]

		if (argument === '--config' && args[index + 1] && !args[index + 1].startsWith('--')) {
			configPath = resolve(args[++index])
		} else if (['--help', '--list', '--gen-token'].includes(argument) && mode === 'start') {
			mode = argument.slice(2)
		} else {
			throw new Error('Unknown argument or conflicting modes, use --help')
		}
	}

	return { mode, configPath }
}

async function main() {
	const { mode, configPath } = argumentsFor(process.argv.slice(2))

	if (mode === 'help') {
		console.log(
			[
				'Badge Farmer',
				'node src/index.js [--config config.json] [mode]',
				'--list   List eligible badges without viewing',
				'--gen-token   Generate a token and save config.json',
				'No mode: keep running, Ctrl+C to stop',
				'JSON config: id, login, client_id, token'
			].join('\n')
		)

		return
	}

	const controller = new AbortController()

	if (mode === 'gen-token') {
		const stop = () => controller.abort(new Error('Token generation cancelled'))

		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)

		try {
			await generateToken(configPath, controller.signal)
		} finally {
			process.off('SIGINT', stop)
			process.off('SIGTERM', stop)
		}

		return
	}

	const config = validateConfig(await readConfig(configPath))

	const log = message => {
		const safe = String(message)
			.replaceAll(config.token, '[redacted]')
			.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
			.replace(/\.+$/, '')

		console.log(new Date().toISOString() + ' ' + safe)
	}

	if (mode === 'list') {
		const twitch = new Twitch(config, controller.signal)
		const [catalog, globals, owned] = await Promise.all([
			fetchJson('https://api.streamdatabase.com/events', { signal: controller.signal, label: 'StreamDatabase' }),
			twitch.globalBadges(),
			twitch.badges()
		])
		const { tasks, skipped } = buildTasks(catalog, owned, Date.now(), globals)

		console.table(
			tasks.map(task => ({
				title: task.title,
				minutes: task.minutes,
				categories: task.categoryNames.join(', ') || 'Any',
				channels: task.channels.map(channel => channel.login).join(', ') || 'Any eligible channel',
				endsUTC: new Date(task.endAt).toISOString()
			}))
		)

		log(`[CATALOG] Tasks: ${tasks.length}, skipped records: ${skipped.length}`)

		for (const message of describeSkipped(skipped)) {
			log(message)
		}

		return
	}

	const statePath = configPath + '.state.json'
	const state = await loadState(statePath, config.id)
	const collector = new Collector({
		config,
		signal: controller.signal,
		twitch: new Twitch(config, controller.signal),
		state,
		save: value => saveState(statePath, value),
		log
	})

	const stop = () => controller.abort(new Error('Shutdown requested'))
	const onMessage = message => {
		if (message === 'shutdown') stop()
	}

	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	process.on('message', onMessage)

	let failures = 0

	try {
		log('[SYSTEM] Starting: ' + config.login + ', one active viewing session')

		while (!controller.signal.aborted) {
			let delay

			try {
				delay = await collector.step()
				failures = 0
			} catch (error) {
				if (controller.signal.aborted) break
				if (error.fatal) throw error

				collector.interrupt()
				failures++

				delay = Math.max(Math.min(10_000 * 2 ** Math.min(failures - 1, 5), 300_000), error.retryAfterMs || 0)

				log(`[ERROR] [SYSTEM] ${error.message}, retrying in ${Math.ceil(delay / 1000)}s`)
			}

			try {
				await pause(Math.max(1, delay), undefined, { signal: controller.signal })
			} catch (error) {
				if (!controller.signal.aborted) throw error
			}
		}
	} finally {
		process.off('message', onMessage)

		await collector.persist()

		log('[SYSTEM] Stopped, state saved')
	}
}

main().catch(error => {
	console.error('[ERROR] [SYSTEM] Error: ' + error.message.replace(/\.+$/, ''))

	process.exitCode = 1
})
