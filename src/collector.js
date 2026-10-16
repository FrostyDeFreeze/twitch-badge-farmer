import { buildTasks, describeSkipped } from './catalog.js'
import { fetchJson } from './fetch.js'

export const WATCH_INTERVAL = 20_000

const INVENTORY_INTERVAL = 120_000
const CATALOG_INTERVAL = 900_000
const RETRY_INTERVAL = 900_000
const CONFIRMATION_GRACE = 300_000
const STALL_INTERVAL = 300_000

function conditionSignature(task) {
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
	constructor({ config, signal, twitch, state, save, log = console.log, now = Date.now }) {
		Object.assign(this, { config, signal, twitch, state, save, log, now })

		this.catalog = null
		this.globals = new Map()
		this.dropCampaigns = []
		this.nextDropsInventory = 0
		this.owned = new Set(state.confirmed)
		this.inventoryReady = false
		this.nextInventory = 0
		this.nextCatalog = 0

		this.active = null
		this.idleMessage = ''
		this.skippedMessages = new Set()
		this.catalogMessage = ''
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

	async refresh(now) {
		if (now >= this.nextInventory) {
			this.nextInventory = now + INVENTORY_INTERVAL

			try {
				const owned = await this.twitch.badges()

				this.owned = new Set([...this.state.confirmed, ...owned])
				this.inventoryReady = true
			} catch (error) {
				this.nextInventory = now + Math.max(INVENTORY_INTERVAL, error.retryAfterMs || 0)

				if (this.signal?.aborted || error.fatal) throw error

				this.log('[ERROR] [TWITCH] Badge ownership refresh: ' + error.message)
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
				const message = `[CATALOG] ${tasks.length} eligible tasks, ${skipped.length} skipped records`

				if (message !== this.catalogMessage) this.log(message)
				this.catalogMessage = message

				const messages = new Set(describeSkipped(skipped))

				for (const message of messages) {
					if (!this.skippedMessages.has(message)) this.log(message)
				}

				this.skippedMessages = messages
			} catch (error) {
				this.nextCatalog = now + Math.max(60_000, error.retryAfterMs || 0)

				if (this.signal?.aborted || error.fatal) throw error

				this.log('[ERROR] [CATALOG] Refresh: ' + error.message)
			}
		}
	}

	async claimReadyDrop(progress) {
		if (!progress || progress.isClaimed || !(progress.currentMinutesWatched >= progress.requiredMinutesWatched) || !progress.dropInstanceID) {
			return false
		}

		await this.twitch.claimDrop(progress.dropInstanceID)

		this.log('[REWARD] ' + this.active.task.key + ': Drop claimed, awaiting badge ownership')
		this.nextInventory = 0
		this.nextDropsInventory = 0

		return true
	}

	async finish(status, now, deferMs = 0) {
		const { task } = this.active
		const attempt = this.state.attempts[task.key]

		attempt.status = status
		attempt.deferUntil = now + deferMs

		if (status === 'earned') {
			this.state.confirmed = [...new Set([...this.state.confirmed, task.key])]
			this.log(`[REWARD] Badge earned: ${task.title} (${task.key})`)
		} else {
			const reason =
				{
					waiting: 'no eligible live stream offering this badge',
					unconfirmed: 'badge ownership not confirmed within the attempt limit',
					error: 'repeated viewing failures',
					'expired-or-unavailable': 'badge expired or requirements no longer available'
				}[status] || status

			this.log(`[VIEWING] ${task.title} (${task.key}): ${reason}${deferMs ? ', retry in ' + Math.ceil(deferMs / 1000) + 's' : ''}`)
		}

		this.state.active = null
		this.active = null

		await this.persist()
	}

	idle(message) {
		if (this.idleMessage !== message) this.log('[VIEWING] ' + message)

		this.idleMessage = message

		return 60_000
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
			const task = tasks.find(task => task.key === this.active.task.key)

			if (!task) {
				await this.finish('expired-or-unavailable', now)

				return 0
			}

			const signature = conditionSignature(task)
			const attempt = this.state.attempts[task.key]

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

				this.log('[VIEWING] ' + task.key + ': conditions changed, restarting session')
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
					tasks.length ? 'No eligible streams or tasks deferred, waiting' : 'No unearned badges available, waiting for new events'
				)
			}

			this.idleMessage = ''

			const attempt = this.state.attempts[task.key] ?? { attemptedMs: 0, deferUntil: 0, status: 'pending' }
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

			this.log(
				`[VIEWING] Task: ${task.title}, ${task.minutes} min${task.serverMinutes ? ', already watched ' + task.serverMinutes + ' min' : ''}`
			)

			await this.persist()
		}

		const active = this.active
		const attempt = this.state.attempts[active.task.key]

		let phase = 'TWITCH'

		try {
			if (active.task.drop && active.task.serverMinutes >= active.task.minutes && now >= active.nextProgress) {
				if (now >= this.nextDropsInventory) {
					this.dropCampaigns = await this.twitch.inventory()
					this.nextDropsInventory = this.now() + 60_000
				}

				const progress = await this.twitch.dropProgress(active.task.drop, this.dropCampaigns)

				if (await this.claimReadyDrop(progress)) {
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

				if (active.stream && !active.rotate && !exclude.has(active.stream.user_id)) {
					stream = await this.twitch.selectStream(
						{
							...active.task,
							channels: [{ id: active.stream.user_id, login: active.stream.user_login }]
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
							channels: [{ id: active.stream.user_id, login: active.stream.user_login }]
						},
						{ drop: active.drop }
					)
				}

				if (!stream) {
					await this.finish('waiting', this.now(), 60_000)

					return 0
				}

				if (stream.id !== active.stream?.id) {
					active.lastGoodAt = null

					active.stalledMs = 0
					this.log(`[VIEWING] Stream: ${stream.user_login}, category: ${stream.game_name}`)
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
			await this.twitch.watch(active.stream)
			active.failedChannels.delete(active.stream.user_id)
			phase = 'TWITCH'

			now = this.now()

			const elapsed = active.lastGoodAt === null ? 0 : now - active.lastGoodAt

			// Local elapsed time only bounds an attempt, it never confirms Drops progress
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

				const progress = await this.twitch.dropProgress(active.drop, this.dropCampaigns)
				let message

				if (progress) {
					attempt.serverMinutes = progress.currentMinutesWatched
					if (progress.currentMinutesWatched !== active.progressMinutes) active.stalledMs = 0
					active.progressMinutes = progress.currentMinutesWatched

					message = `[TWITCH] ${active.task.key}: Twitch progress ${progress.currentMinutesWatched}/${progress.requiredMinutesWatched} min`

					await this.claimReadyDrop(progress)

					if (
						!progress.isClaimed &&
						progress.currentMinutesWatched < progress.requiredMinutesWatched &&
						active.stalledMs >= STALL_INTERVAL
					) {
						active.failedChannels.set(active.stream.user_id, now + STALL_INTERVAL)
						active.rotate = true
						active.retryAt = now + WATCH_INTERVAL
						active.nextStream = 0
						active.lastGoodAt = null
						active.stalledMs = 0
						this.twitch.playback = null
						this.log(
							`[VIEWING] ${active.task.key}: no Twitch progress for 5 min on ${active.stream.user_login}, trying another eligible channel`
						)
					}
				} else {
					active.progressMinutes = null
					active.stalledMs = 0
					message = '[TWITCH] ' + active.task.key + ': no progress reported in Twitch inventory yet'
				}

				if (message !== active.progressMessage) this.log(message)
				active.progressMessage = message
				active.nextProgress = now + 60_000
			}

			active.failures = 0

			await this.persist()
		} catch (error) {
			if (this.signal?.aborted || error.fatal) throw error

			active.lastGoodAt = null
			active.nextStream = 0
			active.stalledMs = 0
			active.failures++

			const delay = Math.max(WATCH_INTERVAL * 2 ** (active.failures - 1), error.retryAfterMs || 0)
			const next = active.failures >= 3 ? 'deferring task' : 'retry in ' + Math.ceil(delay / 1000) + 's'
			const rotate = phase === 'VIEWING' && active.stream && error.status !== 429 && !error.retryAfterMs && active.failures < 3

			if (rotate) {
				active.failedChannels.set(active.stream.user_id, this.now() + STALL_INTERVAL)
				active.rotate = true
				active.retryAt = this.now() + delay
			}

			this.log(
				`[ERROR] [${phase}] ${active.task.key} [${active.stream?.user_login || 'channel selection'}]: ${error.message} | failure ${active.failures}/3, ${rotate ? 'trying another eligible channel, fallback ' : ''}${next}`
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
