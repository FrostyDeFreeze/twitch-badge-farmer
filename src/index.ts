import { basename, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { readConfig, validateConfig } from './config.ts'
import { generateToken } from './gen-token.ts'
import { buildTasks, describeSkipped } from './catalog.ts'
import { fetchJson } from './fetch.ts'
import { Twitch } from './twitch.ts'
import { Collector } from './collector.ts'
import { loadState, saveState } from './state.ts'
import { createLogger } from './logger.ts'

let log = createLogger()

function argumentsFor(args: string[]) {
	let mode = 'start'
	let debug = false
	let configPath = resolve('config.json')

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!
		const value = args[index + 1]

		if (argument === '--config' && value && !value.startsWith('--')) {
			configPath = resolve(value)
			index++
		} else if (argument === '--debug') {
			debug = true
		} else if (['--help', '--list', '--gen-token'].includes(argument) && mode === 'start') {
			mode = argument.slice(2)
		} else {
			throw new Error('Unknown argument or conflicting modes, use --help')
		}
	}

	return { mode, configPath, debug }
}

async function main() {
	const { mode, configPath, debug } = argumentsFor(process.argv.slice(2))

	log = createLogger({ debug })

	if (mode === 'help') {
		console.log(
			[
				'Badge Farmer',
				`${Bun.isStandaloneExecutable ? basename(process.execPath) : 'bun src/index.ts'} [--config config.json] [--debug] [mode]`,
				'--list   List eligible badges without viewing',
				'--gen-token   Generate a token and save config.json',
				'--debug   Show technical diagnostics and skipped badges',
				'No mode: keep running, Ctrl+C to stop'
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
			await generateToken(configPath, controller.signal, log)
		} finally {
			process.off('SIGINT', stop)
			process.off('SIGTERM', stop)
		}

		return
	}

	const config = validateConfig(await readConfig(configPath))

	log = createLogger({ debug, token: config.token })

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

		log.info(`Found ${tasks.length} available badge${tasks.length === 1 ? '' : 's'}`)
		log.debug(`[CATALOG] Skipped records: ${skipped.length}`)

		for (const message of describeSkipped(skipped)) {
			log.debug(message)
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
	const onMessage = (message: unknown) => {
		if (message === 'shutdown') stop()
	}

	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
	process.on('message', onMessage)

	let failures = 0

	try {
		log.info('Account: ' + config.login)
		log.debug('[SYSTEM] Starting one active viewing session')

		while (!controller.signal.aborted) {
			let delay

			try {
				delay = await collector.step()
				failures = 0
			} catch (error) {
				if (!(error instanceof Error)) throw error

				if (controller.signal.aborted) break
				if (error.fatal) throw error

				collector.interrupt()
				failures++

				delay = Math.max(Math.min(10_000 * 2 ** Math.min(failures - 1, 5), 300_000), error.retryAfterMs || 0)

				log.warn(`Could not update badge collection | Retrying in ${Math.ceil(delay / 1000)}s`)
				log.debug('[SYSTEM] ' + error.message)
			}

			try {
				await pause(Math.max(1, delay), undefined, { signal: controller.signal })
			} catch (error) {
				if (!(error instanceof Error)) throw error

				if (!controller.signal.aborted) throw error
			}
		}
	} finally {
		process.off('message', onMessage)

		await collector.persist()

		log.info('Stopped | State saved')
	}
}

main().catch(error => {
	log.error(error instanceof Error ? error.message : 'Unexpected failure')

	process.exitCode = 1
})
