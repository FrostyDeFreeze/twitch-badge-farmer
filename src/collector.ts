import type {
	Attempt,
	AttemptStatus,
	Campaign,
	CollectorState,
	Config,
	DropProgress,
	DropReference,
	GlobalBadge,
	SelectedStream,
	Task
} from './types.ts'
import type { Twitch } from './twitch.ts'
import { createLogger, type Logger } from './logger.ts'

interface CollectorOptions {
	config: Config
	signal?: AbortSignal | undefined
	twitch: Pick<Twitch, 'globalBadges' | 'badges' | 'inventory' | 'selectStream' | 'dropProgress' | 'claimDrop' | 'watch' | 'playback'>
	state: CollectorState
	save: (state: CollectorState) => Promise<void>
	log?: Logger
	now?: () => number
}

interface ActiveTask {
	task: Task
	stream: SelectedStream | null
	drop: DropReference | null | undefined
	lastGoodAt: number | null
	nextStream: number
	nextProgress: number
	failures: number
	failedChannels: Map<string, number>
	rotate: boolean
	retryAt: number
	progressMinutes: number | null
	stalledMs: number
	progressMessage: string
}

import { buildTasks, describeSkipped } from './catalog.ts'
import { fetchJson } from './fetch.ts'

export const WATCH_INTERVAL = 20_000

const IDLE_INTERVAL = 180_000
const INVENTORY_INTERVAL = 120_000
const CATALOG_INTERVAL = 900_000
const RETRY_INTERVAL = 900_000
const CONFIRMATION_GRACE = 300_000
const STALL_INTERVAL = 300_000

function conditionSignature(task: Task) {
	return JSON.stringify([
		task.availabilityId,
		task.minutes,
		task.startAt,
		task.endAt,
		[...task.categoryIds].sort(),
		task.channels.map(channel => channel.id).sort()
	])
}

export class Collector {
	config: Config
	signal: AbortSignal | undefined
	twitch: CollectorOptions['twitch']
	state: CollectorState
	save: CollectorOptions['save']
	log: Logger
	now: () => number
	catalog: unknown
	globals: Map<string, GlobalBadge>
	dropCampaigns: Campaign[]
	owned: Set<string>
	active: ActiveTask | null
	nextDropsInventory = 0
	inventoryReady = false
	nextInventory = 0
	nextCatalog = 0
	idleMessage = ''
	skippedMessages = new Set<string>()
	catalogMessage = ''
	constructor({ config, signal, twitch, state, save, log = createLogger({ token: config.token }), now = Date.now }: CollectorOptions) {
		this.config = config
		this.signal = signal
		this.twitch = twitch
		this.state = state
		this.save = save
		this.log = log
		this.now = now

		this.catalog = null
		this.globals = new Map()
		this.dropCampaigns = []
		this.owned = new Set(state.confirmed)

		this.active = null
	}

	async persist() {
		try {
			await this.save(this.state)
		} catch {
			const error = new Error('Could not save state, viewing stopped')

			error.fatal = true

			throw error
		}
	}

	interrupt() {
		if (this.active) {
			this.active.lastGoodAt = null
			this.active.nextStream = 0
		}
	}

	async refresh(now: number) {
		if (now >= this.nextInventory) {
			this.nextInventory = now + INVENTORY_INTERVAL

			try {
				const owned = await this.twitch.badges()

				this.owned = new Set([...this.state.confirmed, ...owned])
				this.inventoryReady = true
			} catch (error) {
				if (!(error instanceof Error)) throw error

				this.nextInventory = now + Math.max(INVENTORY_INTERVAL, error.retryAfterMs || 0)

				if (this.signal?.aborted || error.fatal) throw error

				this.log.warn(`Could not refresh owned badges | Retrying in ${Math.ceil((this.nextInventory - now) / 1000)}s`)
				this.log.debug('[TWITCH] Badge ownership refresh: ' + error.message)
			}
		}

		if (now >= this.nextCatalog) {
			this.nextCatalog = now + CATALOG_INTERVAL

			try {
				const [data, globals] = await Promise.all([
					fetchJson('https://api.streamdatabase.com/events', { signal: this.signal, label: 'StreamDatabase' }),
					this.twitch.globalBadges()
				])
				const { tasks, skipped } = buildTasks(data, this.owned, now, globals)

				this.catalog = data
				this.globals = globals
				const message = `Found ${tasks.length} available badge${tasks.length === 1 ? '' : 's'}`

				if (message !== this.catalogMessage) {
					this.log.info(message)
				}
				this.log.debug(`[CATALOG] Skipped records: ${skipped.length}`)
				this.catalogMessage = message

				const messages = new Set(describeSkipped(skipped))

				for (const message of messages) {
					if (!this.skippedMessages.has(message)) this.log.debug(message)
				}

				this.skippedMessages = messages
			} catch (error) {
				if (!(error instanceof Error)) throw error

				this.nextCatalog = now + Math.max(60_000, error.retryAfterMs || 0)

				if (this.signal?.aborted || error.fatal) throw error

				this.log.warn(`Could not refresh available badges | Retrying in ${Math.ceil((this.nextCatalog - now) / 1000)}s`)
				this.log.debug('[CATALOG] Refresh: ' + error.message)
			}
		}
	}

	async claimReadyDrop(progress: DropProgress | null) {
		if (!progress || progress.isClaimed || !(progress.currentMinutesWatched >= progress.requiredMinutesWatched) || !progress.dropInstanceID) {
			return false
		}

		await this.twitch.claimDrop(progress.dropInstanceID)

		this.log.info(this.active!.task.title + ' | Drop claimed, waiting for badge confirmation')
		this.log.debug('[REWARD] Drop claimed: ' + this.active!.task.key)
		this.nextInventory = 0
		this.nextDropsInventory = 0

		return true
	}

	async finish(status: AttemptStatus, now: number, deferMs = 0) {
		const { task } = this.active!
		const attempt = this.state.attempts[task.key]!

		attempt.status = status
		attempt.deferUntil = now + deferMs

		if (status === 'earned') {
			this.state.confirmed = [...new Set([...this.state.confirmed, task.key])]
			this.log.success('Badge earned: ' + task.title)
			this.log.debug('[REWARD] Ownership confirmed: ' + task.key)
		} else {
			const reasons: Partial<Record<AttemptStatus, string>> = {
				waiting: 'no eligible live stream offering this badge',
				unconfirmed: 'badge ownership not confirmed within the attempt limit',
				error: 'repeated viewing failures',
				'expired-or-unavailable': 'badge expired or requirements no longer available'
			}
			const reason = reasons[status] || status

			const message = `${task.title} | ${reason}${deferMs ? ' | Retrying in ' + Math.ceil(deferMs / 1000) + 's' : ''}`

			if (status === 'error' || status === 'unconfirmed') this.log.warn(message)
			// waiting is reported once when the queue becomes idle
			else if (status !== 'waiting') this.log.log({ tag: 'WAIT', message })
			this.log.debug(`[VIEWING] ${task.key}: ${status} | ${reason}`)
		}

		this.state.active = null
		this.active = null

		await this.persist()
	}

	idle(message: string, delay = 60_000) {
		if (this.idleMessage !== message) this.log.log({ tag: 'WAIT', message })

		this.idleMessage = message

		return delay
	}

	async step() {
		const started = this.now()

		await this.refresh(started)

		let now = this.now()

		if (!this.inventoryReady || !this.catalog) {
			return this.idle('Waiting for the catalog and Twitch badge ownership data')
		}

		if (this.active && this.owned.has(this.active.task.key)) {
			await this.finish('earned', now)

			return 0
		}

		let { tasks } = buildTasks(this.catalog, this.owned, now, this.globals, this.dropCampaigns)

		if (this.active) {
			const task = tasks.find(task => task.key === this.active!.task.key)

			if (!task) {
				await this.finish('expired-or-unavailable', now)

				return 0
			}

			const signature = conditionSignature(task)
			const attempt = this.state.attempts[task.key]!

			if (signature !== attempt.signature) {
				attempt.attemptedMs = 0
				attempt.signature = signature

				this.active.stream = null
				this.active.lastGoodAt = null
				this.active.nextStream = 0
				this.active.drop = null
				this.active.failedChannels.clear()
				this.active.progressMinutes = null
				this.active.stalledMs = 0

				this.log.info(task.title + ' | Requirements changed, restarting session')
				this.log.debug('[VIEWING] Requirements changed: ' + task.key)
			}

			this.active.task = task
		}

		if (!this.active) {
			if (tasks.some(task => (this.state.attempts[task.key]?.deferUntil || 0) <= now)) {
				this.dropCampaigns = await this.twitch.inventory()
				this.nextDropsInventory = this.now() + 60_000
				tasks = buildTasks(this.catalog, this.owned, this.now(), this.globals, this.dropCampaigns).tasks
			}

			const available = tasks.filter(task => (this.state.attempts[task.key]?.deferUntil || 0) <= now)
			const resumed = available.find(task => task.key === this.state.active)
			const task = resumed && (resumed.serverMinutes || !available[0]?.serverMinutes) ? resumed : available[0]

			if (!task) {
				return this.idle(
					(tasks.length ? 'No eligible live streams' : 'No unearned badges available') +
						` | Checking again in ${IDLE_INTERVAL / 60_000} min`,
					IDLE_INTERVAL
				)
			}

			this.idleMessage = ''

			const attempt: Attempt = this.state.attempts[task.key] ?? { attemptedMs: 0, deferUntil: 0, status: 'pending' }
			const signature = conditionSignature(task)

			if (attempt.signature !== signature || ['unconfirmed', 'error'].includes(attempt.status)) {
				attempt.attemptedMs = 0
			}

			attempt.signature = signature
			attempt.status = 'watching'

			this.state.attempts[task.key] = attempt
			this.state.active = task.key
			this.active = {
				task,
				stream: null,
				drop: task.drop,
				lastGoodAt: null,
				nextStream: 0,
				nextProgress: 0,
				failures: 0,
				failedChannels: new Map(),
				rotate: false,
				retryAt: 0,
				progressMinutes: null,
				stalledMs: 0,
				progressMessage: ''
			}

			this.log.info(`Selected badge: ${task.title} | Required viewing: ${task.minutes} min`)
			this.log.debug(`[VIEWING] Task: ${task.key}${task.serverMinutes ? ', already watched ' + task.serverMinutes + ' min' : ''}`)

			await this.persist()
		}

		const active = this.active
		const attempt = this.state.attempts[active.task.key]!

		let phase = 'TWITCH'

		try {
			if (active.task.drop && (active.task.serverMinutes || 0) >= active.task.minutes && now >= active.nextProgress) {
				if (now >= this.nextDropsInventory) {
					this.dropCampaigns = await this.twitch.inventory()
					this.nextDropsInventory = this.now() + 60_000
				}

				const progress = await this.twitch.dropProgress(active.task.drop, this.dropCampaigns)

				if (progress && (await this.claimReadyDrop(progress))) {
					attempt.serverMinutes = progress.currentMinutesWatched
					active.lastGoodAt = null
					active.nextProgress = this.now() + 60_000
					active.failures = 0

					await this.persist()

					return WATCH_INTERVAL
				}
			}

			if (attempt.attemptedMs >= active.task.minutes * 60_000 + CONFIRMATION_GRACE) {
				await this.finish('unconfirmed', now, RETRY_INTERVAL)

				return 0
			}

			if (!active.stream || now >= active.nextStream) {
				let stream = null
				const exclude = new Set([...active.failedChannels].filter(([, until]) => until > now).map(([id]) => id))
				const options = { exclude, drop: active.drop }

				if (active.stream && !active.rotate && !exclude.has(active.stream!.user_id)) {
					stream = await this.twitch.selectStream(
						{
							...active.task,
							channels: [{ id: active.stream!.user_id, login: active.stream!.user_login }]
						},
						options
					)
				}

				if (!stream) stream = await this.twitch.selectStream(active.task, options)

				if (!stream && active.rotate && active.stream) {
					if (now < active.retryAt) return active.retryAt - now

					stream = await this.twitch.selectStream(
						{
							...active.task,
							channels: [{ id: active.stream!.user_id, login: active.stream!.user_login }]
						},
						{ drop: active.drop }
					)
				}

				if (!stream) {
					await this.finish('waiting', this.now(), IDLE_INTERVAL)

					return 0
				}

				if (stream.id !== active.stream?.id) {
					active.lastGoodAt = null

					active.stalledMs = 0
					this.log.log({ tag: 'WATCH', message: `${active.task.title} | Channel: ${stream.user_login}` })
					this.log.debug(`[VIEWING] Stream: ${stream.user_login}, category: ${stream.game_name}`)
				}

				active.stream = stream
				active.drop ??= stream.drop
				active.rotate = false
				active.nextStream = this.now() + 60_000
			}

			if (this.now() >= active.task.endAt) {
				await this.finish('expired-or-unavailable', this.now())

				return 0
			}

			phase = 'VIEWING'
			await this.twitch.watch(active.stream!)
			active.failedChannels.delete(active.stream!.user_id)
			phase = 'TWITCH'

			now = this.now()

			const elapsed = active.lastGoodAt === null ? 0 : now - active.lastGoodAt

			// local elapsed time bounds an attempt, never confirms reward ownership
			if (elapsed > 0 && elapsed <= WATCH_INTERVAL * 2) {
				attempt.attemptedMs += elapsed
				if (active.progressMinutes !== null) active.stalledMs += elapsed
			}

			active.lastGoodAt = now

			if (now >= active.nextProgress) {
				if (now >= this.nextDropsInventory) {
					this.dropCampaigns = await this.twitch.inventory()
					this.nextDropsInventory = this.now() + 60_000
				}

				const progress = await this.twitch.dropProgress(active.drop!, this.dropCampaigns)
				let message

				if (progress) {
					attempt.serverMinutes = progress.currentMinutesWatched
					if (progress.currentMinutesWatched !== active.progressMinutes) active.stalledMs = 0
					active.progressMinutes = progress.currentMinutesWatched

					message = `${active.task.title} | Twitch progress: ${progress.currentMinutesWatched}/${progress.requiredMinutesWatched} min`

					await this.claimReadyDrop(progress)

					if (
						!progress.isClaimed &&
						progress.currentMinutesWatched < progress.requiredMinutesWatched &&
						active.stalledMs >= STALL_INTERVAL
					) {
						active.failedChannels.set(active.stream!.user_id, now + STALL_INTERVAL)
						active.rotate = true
						active.retryAt = now + WATCH_INTERVAL
						active.nextStream = 0
						active.lastGoodAt = null
						active.stalledMs = 0
						this.twitch.playback = null
						this.log.warn(
							`${active.task.title} | No Twitch progress for 5 min on ${active.stream!.user_login} | Trying another eligible channel`
						)
					}
				} else {
					active.progressMinutes = null
					active.stalledMs = 0
					message = active.task.title + ' | Waiting for Twitch progress'
				}

				if (message !== active.progressMessage) {
					this.log.log({ tag: 'WATCH', message })
					this.log.debug('[TWITCH] ' + active.task.key + ': ' + message)
				}
				active.progressMessage = message
				active.nextProgress = now + 60_000
			}

			active.failures = 0

			await this.persist()
		} catch (error) {
			if (!(error instanceof Error)) throw error

			if (this.signal?.aborted || error.fatal) throw error

			active.lastGoodAt = null
			active.nextStream = 0
			active.stalledMs = 0
			active.failures++

			const delay = Math.max(WATCH_INTERVAL * 2 ** (active.failures - 1), error.retryAfterMs || 0)
			const next = active.failures >= 3 ? 'Pausing this badge' : 'Retrying in ' + Math.ceil(delay / 1000) + 's'
			const rotate = phase === 'VIEWING' && active.stream && error.status !== 429 && !error.retryAfterMs && active.failures < 3

			if (rotate) {
				active.failedChannels.set(active.stream!.user_id, this.now() + STALL_INTERVAL)
				active.rotate = true
				active.retryAt = this.now() + delay
			}

			const reason =
				error.status === 429
					? 'Request limit reached'
					: phase === 'VIEWING'
						? 'Stream connection interrupted'
						: 'Could not update Twitch data'
			this.log.warn(`${active.task.title} | ${reason} | ${rotate ? 'Trying another eligible channel' : next}`)
			this.log.debug(
				`[${phase}] ${active.task.key} [${active.stream?.user_login || 'channel selection'}]: ${error.message} | failure ${active.failures}/3, ${rotate ? 'fallback ' : ''}${next}`
			)

			if (active.failures >= 3) {
				await this.finish('error', this.now(), RETRY_INTERVAL)

				return error.retryAfterMs || 0
			}

			return rotate ? 0 : delay
		}

		return Math.max(0, WATCH_INTERVAL - (this.now() - started))
	}
}
