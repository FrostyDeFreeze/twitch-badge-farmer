import type { Attempt, AttemptStatus, Campaign, CollectorState, Config, DropReference, GlobalBadge, SelectedStream, Task } from './types.ts'
import type { Twitch } from './twitch.ts'
import { clock, createLogger, duration, type Logger } from './logger.ts'

interface CollectorOptions {
	config: Config
	signal?: AbortSignal | undefined
	twitch: Pick<Twitch, 'globalBadges' | 'badges' | 'inventory' | 'selectStream' | 'dropProgress' | 'watch' | 'playback'>
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

function dailyWindow(task: Task, now: number) {
	const daily = task.daily!

	return JSON.stringify([
		task.drop,
		daily.windowStartedAt,
		daily.windowEndsAt,
		daily.requiredDays,
		daily.windowEndsAt !== null && daily.windowEndsAt <= now
	])
}

// when the next daily window opens, or null when the task can be viewed now
export function nextWindowAt(task: Task, now: number, attempt?: Attempt) {
	const daily = task.daily

	// a group without inventory progress is looked up on eligible channels
	if (!task.days || !daily) return null
	if (daily.completedDays >= daily.requiredDays || ['CLAIMED', 'FULFILLED'].includes(daily.status)) return null
	if (daily.windowStartedAt !== null && daily.windowStartedAt > now) return daily.windowStartedAt
	if (daily.nextEligibleAt !== null && daily.nextEligibleAt > now) return daily.nextEligibleAt
	// a completed portion is remembered only for a known window, otherwise nothing could end the wait
	if ((daily.windowEndsAt !== null && attempt?.dailyCompletedWindow === dailyWindow(task, now)) || (task.serverMinutes ?? 0) >= task.minutes)
		return Math.max(now + 60000, daily.windowEndsAt ?? now)

	return null
}

function dailyWait(task: Task, now: number, attempt?: Attempt) {
	const at = nextWindowAt(task, now, attempt)

	return at === null ? 0 : at - now
}

export const WATCH_INTERVAL = 20_000

const IDLE_INTERVAL = 180_000
const INVENTORY_INTERVAL = 120_000
const CATALOG_INTERVAL = 900_000
const RETRY_INTERVAL = 900_000
const CONFIRMATION_GRACE = 300_000
const STALL_INTERVAL = 300_000
const DAY = 86_400_000

// an attempt cannot finish when the event ends before its unwatched minutes, remaining days and confirmation
function feasible(task: Task, now: number, attempt?: Attempt) {
	const left = (watched = 0) => Math.max(0, task.minutes - watched) * 60_000

	if (!task.days) return now + left(task.serverMinutes) + CONFIRMATION_GRACE <= task.endAt

	const remaining = task.days - (task.daily?.completedDays ?? 0)

	if (remaining <= 0) return true

	const wait = dailyWait(task, now, attempt)
	const start = now + wait
	const windowEndsAt = task.daily?.windowEndsAt ?? null
	// every day needs its own 24-hour window, the next one opens when the current one ends
	const nextWindow = !wait && windowEndsAt !== null && windowEndsAt > now ? windowEndsAt : start + DAY
	const finish = remaining > 1 ? nextWindow + (remaining - 2) * DAY + left() : start + left(wait ? 0 : task.serverMinutes)

	return finish + CONFIRMATION_GRACE <= task.endAt
}

function conditionSignature(task: Task, drop: DropReference | null | undefined = task.drop) {
	return JSON.stringify([
		task.availabilityId,
		// Twitch's minutes found after the first viewed minutes refine the same conditions, not new ones
		task.catalogMinutes ?? task.minutes,
		task.days,
		task.days ? (drop ?? null) : null,
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
		this.owned = new Set()

		this.active = null
	}

	async persist() {
		try {
			await this.save(this.state)
		} catch {
			const error = new Error('State | Could not save | Viewing stopped')

			error.fatal = true

			throw error
		}
	}

	async campaigns() {
		if (this.now() < this.nextDropsInventory) return

		this.dropCampaigns = await this.twitch.inventory()
		this.nextDropsInventory = this.now() + 60_000
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

				this.owned = owned
				this.inventoryReady = true
			} catch (error) {
				if (!(error instanceof Error)) throw error

				this.nextInventory = now + Math.max(INVENTORY_INTERVAL, error.retryAfterMs || 0)

				if (this.signal?.aborted || error.fatal) throw error

				this.log.warn(`Could not refresh owned badges | Retrying in ${duration(this.nextInventory - now)}`)
				this.log.debug('[TWITCH] Owned badges | ' + error.message)
			}
		}

		if (!this.active) await this.campaigns()

		if (now >= this.nextCatalog) {
			this.nextCatalog = now + CATALOG_INTERVAL

			try {
				const [data, globals] = await Promise.all([
					fetchJson('https://api.streamdatabase.com/events', { signal: this.signal, label: 'StreamDatabase' }),
					this.twitch.globalBadges()
				])

				const { tasks, skipped } = buildTasks(data, this.owned, now, globals, this.dropCampaigns)

				this.catalog = data
				this.globals = globals
				const message = `Found ${tasks.length} available badge${tasks.length === 1 ? '' : 's'}`

				if (message !== this.catalogMessage) {
					this.log.info(message)
				}
				this.log.debug(`[CATALOG] Refreshed | Available: ${tasks.length} | Skipped: ${skipped.length}`)
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

				this.log.warn(`Could not refresh the badge catalog | Retrying in ${duration(this.nextCatalog - now)}`)
				this.log.debug('[CATALOG] Refresh failed | ' + error.message)
			}
		}
	}

	async finish(status: AttemptStatus, now: number, deferMs = 0) {
		const { task } = this.active!
		const attempt = this.state.attempts[task.key]!

		attempt.status = status
		attempt.deferUntil = now + deferMs

		if (status === 'earned') {
			delete this.state.attempts[task.key]
			this.log.success(task.title + ' | Badge earned')
			this.log.debug('[REWARD] ' + task.key + ' | Ownership confirmed')
		} else {
			const reasons: Partial<Record<AttemptStatus, string>> = {
				waiting: 'No eligible live stream',
				'waiting-day': "Today's viewing done",
				'waiting-progress': 'Waiting for Twitch daily progress',
				unconfirmed: 'Viewing done, but Twitch has not granted the badge',
				error: 'Failed 3 times in a row',
				'expired-or-unavailable': 'Expired or no longer available'
			}
			const next = !deferMs
				? ''
				: status === 'waiting-day'
					? 'Next window at ' + clock(now + deferMs)
					: (status === 'waiting-progress' ? 'Checking again in ' : 'Retrying in ') + duration(deferMs)
			const message = [task.title, reasons[status] || status, next].filter(Boolean).join(' | ')

			if (status === 'error' || status === 'unconfirmed') this.log.warn(message)
			// waiting is reported once when the queue becomes idle
			else if (status !== 'waiting') this.log.log({ tag: 'WAIT', message })
			this.log.debug(`[VIEWING] ${task.key} | Stopped: ${status}`)
		}

		this.state.active = null
		this.active = null
		this.twitch.playback = null

		await this.persist()
	}

	// returns a delay that ends this step, or undefined to keep viewing
	async dailyStep(now: number): Promise<number | undefined> {
		const active = this.active!
		const attempt = this.state.attempts[active.task.key]!
		const current = active.task.daily

		if (now < active.nextProgress) {
			return current && (current.completedDays >= current.requiredDays || ['CLAIMED', 'FULFILLED'].includes(current.status))
				? WATCH_INTERVAL
				: undefined
		}

		// a group without inventory progress is found on an eligible channel first
		if (!active.drop) return undefined

		await this.campaigns()

		const progress = await this.twitch.dropProgress(active.drop, active.task.key, this.dropCampaigns, this.now())

		if (!progress?.daily) {
			// Twitch lists a channel-discovered group in the inventory only after its first minutes
			if (!active.task.drop) {
				active.nextProgress = this.now() + 60_000

				return undefined
			}

			await this.finish('waiting-progress', this.now(), 60_000)

			return 0
		}

		const daily = progress.daily

		active.task.serverMinutes = progress.currentMinutesWatched
		active.task.daily = daily

		const window = dailyWindow(active.task, this.now())

		if (
			progress.currentMinutesWatched >= progress.requiredMinutesWatched ||
			(attempt.dailyWindow === window && attempt.dailyCompletedDays !== undefined && daily.completedDays > attempt.dailyCompletedDays)
		)
			attempt.dailyCompletedWindow = window

		attempt.dailyCompletedDays = daily.completedDays

		if (attempt.dailyWindow !== window) {
			attempt.dailyWindow = window
			attempt.attemptedMs = 0

			active.lastGoodAt = null
			active.stalledMs = 0
			active.progressMinutes = null
		}

		if (progress.currentMinutesWatched !== active.progressMinutes) active.stalledMs = 0
		active.progressMinutes = progress.currentMinutesWatched

		const message = `${active.task.title} | Days: ${daily.completedDays}/${daily.requiredDays} | Today: ${progress.currentMinutesWatched}/${progress.requiredMinutesWatched} min`

		if (message !== active.progressMessage) this.log.log({ tag: 'WATCH', message })

		active.progressMessage = message
		active.nextProgress = this.now() + 60000

		// Twitch grants the badge itself once the days are complete
		if (progress.isClaimed || daily.completedDays >= daily.requiredDays) {
			attempt.completedAt ??= this.now()

			if (this.now() - attempt.completedAt >= CONFIRMATION_GRACE) {
				await this.finish('unconfirmed', this.now(), RETRY_INTERVAL)

				return 0
			}

			this.nextInventory = Math.min(this.nextInventory, this.now() + 60000)
			active.lastGoodAt = null
			this.twitch.playback = null

			await this.persist()

			return WATCH_INTERVAL
		}

		const wait = dailyWait(active.task, this.now(), attempt)

		if (wait) {
			await this.finish('waiting-day', this.now(), wait)

			return 0
		}

		return undefined
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
			return this.idle('Loading the badge catalog and owned badges')
		}

		if (this.active && this.owned.has(this.active.task.key)) {
			await this.finish('earned', now)

			return 0
		}

		const { tasks } = buildTasks(this.catalog, this.owned, now, this.globals, this.dropCampaigns)

		// Twitch remains the source of truth, so attempts of earned, expired or vanished badges are dropped
		for (const key of Object.keys(this.state.attempts)) {
			if (key !== this.active?.task.key && !tasks.some(task => task.key === key)) delete this.state.attempts[key]
		}

		if (this.active) {
			const task = tasks.find(task => task.key === this.active!.task.key)

			if (!task) {
				await this.finish('expired-or-unavailable', now)

				return 0
			}

			const signature = conditionSignature(task)
			const attempt = this.state.attempts[task.key]!

			// a group found on a channel enters the inventory after its first minutes under the same identity
			if (
				signature !== attempt.signature &&
				conditionSignature(task, null) === attempt.signature &&
				JSON.stringify(task.drop) === JSON.stringify(this.active.drop)
			) {
				attempt.signature = signature
			} else if (signature !== attempt.signature) {
				attempt.attemptedMs = 0
				attempt.signature = signature

				this.active.stream = null
				this.active.lastGoodAt = null
				this.active.nextStream = 0
				this.active.drop = null
				this.active.failedChannels.clear()
				this.active.progressMinutes = null
				this.active.stalledMs = 0

				this.log.info(task.title + ' | Catalog conditions changed | Restarting the attempt')
				this.log.debug('[VIEWING] ' + task.key + ' | Signature changed | Attempt reset')
			}

			if (!feasible(task, now, this.state.attempts[task.key])) {
				await this.finish('expired-or-unavailable', now)

				return 0
			}

			if (task.minutes !== this.active.task.minutes && task.catalogMinutes !== undefined) {
				this.log.info(`${task.title} | Required viewing: ${task.minutes} min (catalog: ${task.catalogMinutes} min)`)
			}

			this.active.task = task
		}

		if (!this.active) {
			const available = tasks.filter(task => {
				const attempt = this.state.attempts[task.key]
				const deferred = attempt?.status === 'waiting-day' || attempt?.status === 'waiting-progress' ? 0 : attempt?.deferUntil || 0

				return deferred <= now && dailyWait(task, now, attempt) === 0 && feasible(task, now, attempt)
			})

			const first = available[0]
			const resumed = available.find(task => task.key === this.state.active)
			// a badge sharing the first one's group gains nothing from resuming, the first is earned sooner
			const sameGroup = resumed?.drop && JSON.stringify(resumed.drop) === JSON.stringify(first?.drop)
			const task = resumed && !sameGroup && (resumed.serverMinutes || !first?.serverMinutes) ? resumed : first

			if (!task) {
				const windows = tasks.flatMap(task => nextWindowAt(task, now, this.state.attempts[task.key]) ?? [])

				if (windows.length) {
					const next = Math.min(...windows)

					// wake when the window opens, not up to an idle interval later
					return this.idle('Waiting for the next daily window | Opens at ' + clock(next), Math.min(IDLE_INTERVAL, next - now))
				}

				return this.idle(
					(tasks.some(task => feasible(task, now, this.state.attempts[task.key]))
						? 'No eligible live streams'
						: tasks.length
							? 'Not enough time left for available badges'
							: 'No badges to collect') + ` | Checking again in ${duration(IDLE_INTERVAL)}`,
					IDLE_INTERVAL
				)
			}

			this.idleMessage = ''

			const attempt: Attempt = this.state.attempts[task.key] ?? { attemptedMs: 0, deferUntil: 0, status: 'watching' }
			const signature = conditionSignature(task)

			if (attempt.signature !== signature || ['unconfirmed', 'error'].includes(attempt.status)) {
				attempt.attemptedMs = 0
				delete attempt.completedAt
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

			const viewing =
				`${task.minutes} min${(task.days ?? 1) > 1 ? '/day × ' + task.days + ' days' : ''}` +
				(task.catalogMinutes === undefined ? '' : ` (catalog: ${task.catalogMinutes} min)`)

			this.log.info(
				[
					task.title,
					'Selected',
					'Required viewing: ' + viewing,
					task.serverMinutes ? `Progress: ${task.serverMinutes}/${task.minutes} min` : ''
				]
					.filter(Boolean)
					.join(' | ')
			)
			this.log.debug(
				`[VIEWING] ${task.key} | Reward: ${task.drop ? (task.drop.kind === 'reward-group' ? 'daily group ' : 'Drop ') + task.drop.id : 'looked up on channels'}`
			)

			await this.persist()
		}

		const active = this.active
		const attempt = this.state.attempts[active.task.key]!

		let phase = 'TWITCH'

		try {
			if (active.task.days) {
				const delay = await this.dailyStep(now)

				if (delay !== undefined) return delay
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
					this.log.log({
						tag: 'WATCH',
						message: [active.task.title, 'Watching ' + stream.user_login, stream.game_name].filter(Boolean).join(' | ')
					})
					this.log.debug(`[VIEWING] ${active.task.key} | Broadcast: ${stream.id} | Reward: ${stream.drop.id}`)
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

			if (!active.task.days && now >= active.nextProgress) {
				await this.campaigns()

				const progress = await this.twitch.dropProgress(active.drop!, active.task.key, this.dropCampaigns, this.now())
				let message

				if (progress) {
					if (progress.currentMinutesWatched !== active.progressMinutes) active.stalledMs = 0
					active.progressMinutes = progress.currentMinutesWatched

					message = `${active.task.title} | Progress: ${progress.currentMinutesWatched}/${progress.requiredMinutesWatched} min`

					if (progress.isClaimed) active.stalledMs = 0
				} else {
					active.progressMinutes = null
					active.stalledMs = 0
					message = active.task.title + ' | Waiting for Twitch progress'
				}

				if (message !== active.progressMessage) {
					this.log.log({ tag: 'WATCH', message })
					this.log.debug(
						`[TWITCH] ${active.task.key} | ${progress ? `Drop ${active.drop!.id}: ${progress.currentMinutesWatched}/${progress.requiredMinutesWatched} min, claimed: ${progress.isClaimed ? 'yes' : 'no'}` : 'Drop not in the inventory yet'}`
					)
				}
				active.progressMessage = message
				active.nextProgress = now + 60_000
			}

			if (active.progressMinutes !== null && active.progressMinutes < active.task.minutes && active.stalledMs >= STALL_INTERVAL) {
				active.failedChannels.set(active.stream!.user_id, now + STALL_INTERVAL)
				active.rotate = true
				active.retryAt = now + WATCH_INTERVAL
				active.nextStream = 0
				active.lastGoodAt = null
				active.stalledMs = 0
				this.twitch.playback = null
				this.log.warn(
					`${active.task.title} | No progress on ${active.stream!.user_login} for ${duration(STALL_INTERVAL)} | Switching channel`
				)
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
			const rotate = phase === 'VIEWING' && active.stream && error.status !== 429 && !error.retryAfterMs && active.failures < 3

			if (rotate) {
				active.failedChannels.set(active.stream!.user_id, this.now() + STALL_INTERVAL)
				active.rotate = true
				active.retryAt = this.now() + delay
			}

			const reason = error.status === 429 ? 'Twitch request limit' : phase === 'VIEWING' ? 'Stream connection lost' : 'Twitch data unavailable'

			// the third failure is reported once by finish
			if (active.failures < 3)
				this.log.warn(`${active.task.title} | ${reason} | ${rotate ? 'Switching channel' : 'Retrying in ' + duration(delay)}`)
			this.log.debug(
				`[${phase}] ${active.task.key} | ${active.stream?.user_login || 'Channel selection'} | ${error.message} | Failure ${active.failures}/3`
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
