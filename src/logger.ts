import { createConsola } from 'consola/core'
import { stripVTControlCharacters } from 'node:util'

export type Logger = ReturnType<typeof createLogger>

const pad = (value: number) => String(value).padStart(2, '0')

// a delay in log text: 45s, 3m, 2h 5m
export function duration(ms: number) {
	const minutes = Math.ceil(ms / 60_000)

	if (ms < 60_000) return Math.ceil(ms / 1000) + 's'

	return minutes < 60 ? minutes + 'm' : Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '')
}

// a local time of day in log text, like the log timestamps
export function clock(time: number) {
	const date = new Date(time)

	return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

export function createLogger({ debug = false, token = '' }: { debug?: boolean; token?: string } = {}) {
	return createConsola({
		level: debug ? 4 : 3,
		// collector messages are already deduplicated, write immediately before exit
		throttle: 0,
		reporters: [
			{
				log({ date, type, tag, level, args }) {
					const stream = level < 2 ? process.stderr : process.stdout
					const text = args.map(value => (value instanceof Error ? value.message : String(value))).join(' ')
					const message = stripVTControlCharacters(token ? text.replaceAll(token, '[redacted]') : text)
						.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
						.trim()
						.replace(/\.+$/, '')
					const time = clock(date.getTime()) + ':' + pad(date.getSeconds())
					const label = (tag || (type === 'success' ? 'DONE' : type.toUpperCase())).padEnd(5)
					const color = level < 1 ? 31 : type === 'warn' ? 33 : type === 'success' ? 32 : type === 'debug' || tag === 'WAIT' ? 90 : 36
					const marker = stream.isTTY && !('NO_COLOR' in process.env) ? '\x1b[' + color + 'm' + label + '\x1b[0m' : label

					stream.write(time + ' ' + marker + ' ' + message + '\n')
				}
			}
		]
	})
}
