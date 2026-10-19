import type { Campaign, Drop, GlobalBadge, Task } from './types.ts'

interface Dates {
	start_at_date?: string
	start_at_time?: string
	end_at_date?: string
	end_at_time?: string
}

interface Objective {
	type: string
	minutes?: number
	days?: number | null
	twitch_global_chat_badges?: { set_id?: string; version?: { id?: string | number } }[]
}

interface Availability extends Dates {
	_id?: string | number
	scope?: string
	cost?: string
	hidden?: boolean
	revocable?: boolean
	chance_denominator?: number | null
	channel_count?: number | null
	categories?: { game: { id: string; name?: string } }[] | null
	channels?: { user: { id: string; login: string } }[] | null
	objectives?: Objective[][] | null
}

interface CatalogEvent extends Dates {
	hidden?: boolean
	twitch_global_badges: {
		current: { set_id?: string; version: { id?: string | number; title?: string; image_url_4x?: string } }
		availability?: Availability[]
	}[]
}

interface SkippedBadge {
	key: string
	title: string
	reason: string
}

function badgeKey(setId: string | undefined, version: string | number | null | undefined) {
	if (!setId || version == null) {
		throw new Error('Missing badge identifier')
	}

	return `${setId}:${version}`
}

function dateAt(availability: Dates, event: Dates, prefix: 'start' | 'end', end: boolean) {
	const ownDate = availability[`${prefix}_at_date`]
	const date = ownDate || event[`${prefix}_at_date`]
	const time = availability[`${prefix}_at_time`] || (!ownDate ? event[`${prefix}_at_time`] : '') || (end ? '23:59:59.999' : '00:00')

	if (!date) throw new Error('Missing availability dates')

	const timestamp = Date.parse(date + 'T' + time + 'Z')

	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
		throw new Error('Invalid availability dates')
	}

	return timestamp
}

function watchMinutes(objectives: Objective[][] | null | undefined, owned: Set<string>) {
	if (!Array.isArray(objectives) || !objectives.length) throw new Error('Missing structured objectives')

	const watches: number[] = []

	for (const group of objectives) {
		if (!Array.isArray(group) || !group.length) throw new Error('Unknown objectives')

		const unlocked = group.some(
			objective =>
				objective.type === 'twitch_unlock' &&
				objective.twitch_global_chat_badges?.some(badge => owned.has(badgeKey(badge.set_id, badge.version?.id)))
		)

		if (unlocked) continue

		const options = group.filter(
			(objective): objective is Objective & { minutes: number } =>
				objective.type === 'twitch_watch' &&
				typeof objective.minutes === 'number' &&
				Number.isSafeInteger(objective.minutes) &&
				objective.minutes > 0 &&
				(objective.days == null || objective.days === 1)
		)

		if (!options.length) throw new Error('Unsupported, multi-day or unmet objectives')

		watches.push(Math.min(...options.map(objective => objective.minutes)))
	}

	if (watches.length !== 1) throw new Error('Ambiguous viewing objectives')

	return watches[0]!
}

function restrictions(availability: Availability) {
	const { categories, channels, channel_count: channelCount } = availability

	if (categories === undefined || channels === undefined) throw new Error('Missing eligibility restrictions')
	if (categories !== null && (!Array.isArray(categories) || !categories.length)) throw new Error('Unknown categories')
	if (channels !== null && (!Array.isArray(channels) || !channels.length)) throw new Error('Unknown channels')

	const eligibleCategories = categories ?? []
	const eligibleChannels = (channels ?? []).map(channel => ({ id: channel.user?.id, login: channel.user?.login }))

	if (eligibleCategories.some(category => !category.game?.id) || eligibleChannels.some(channel => !channel.id || !channel.login)) {
		throw new Error('Missing category or channel identifiers')
	}

	if (channelCount != null && channelCount !== eligibleChannels.length) {
		throw new Error('Incomplete eligible channel list')
	}

	return {
		categoryIds: [...new Set(eligibleCategories.map(category => category.game.id))],
		categoryNames: eligibleCategories.map(category => category.game.name || category.game.id),
		channels: eligibleChannels
	}
}

export function matchesDrop(task: Task, campaign: Campaign, drop: Drop, now = Date.now()) {
	const names = [task.title, task.rewardTitle].filter(Boolean).map(name => name.trim().toLowerCase())

	return (
		(!campaign.startAt || Date.parse(campaign.startAt) <= now) &&
		(!campaign.endAt || Date.parse(campaign.endAt) > now) &&
		(!campaign.game || !task.categoryIds.length || task.categoryIds.includes(campaign.game.id)) &&
		drop.requiredMinutesWatched === task.minutes &&
		!drop.requiredSubs &&
		!drop.requiredTurboSubs &&
		drop.self?.hasPreconditionsMet !== false &&
		Date.parse(drop.startAt) <= now &&
		Date.parse(drop.endAt) > now &&
		drop.benefitEdges?.some(edge => typeof edge.benefit?.name === 'string' && names.includes(edge.benefit.name.trim().toLowerCase()))
	)
}

export function buildTasks(
	data: unknown,
	owned = new Set<string>(),
	now = Date.now(),
	globals = new Map<string, GlobalBadge>(),
	campaigns: Campaign[] = []
) {
	if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data))
		throw new Error('StreamDatabase: unsupported response format')

	const tasks = new Map<string, Task>()
	const skipped: SkippedBadge[] = []

	for (const event of data.data as CatalogEvent[]) {
		if (!Array.isArray(event.twitch_global_badges)) throw new Error('StreamDatabase: missing badge list')

		for (const badge of event.twitch_global_badges) {
			const key = badgeKey(badge.current?.set_id, badge.current?.version?.id)
			const rewardTitle = badge.current.version.title || key
			const title = globals.get(key)?.title || rewardTitle

			if (!badge.availability?.length) {
				skipped.push({ key, title, reason: 'Missing availability conditions' })

				continue
			}

			for (const availability of badge.availability) {
				try {
					const startAt = dateAt(availability, event, 'start', false)
					const endAt = dateAt(availability, event, 'end', true)

					if (startAt >= endAt) throw new Error('Invalid availability window')
					if (now >= endAt) continue
					if (owned.has(key)) throw new Error('Already owned')
					if (event.hidden || availability.hidden) throw new Error('Hidden record')
					if (availability.scope !== 'global') throw new Error('Not a global badge')
					if (availability.cost !== 'free') throw new Error('Paid or unknown cost')
					if (availability.revocable) throw new Error('Temporary badge')

					if (availability.chance_denominator != null && availability.chance_denominator !== 1) {
						throw new Error('Random reward')
					}

					if (now < startAt) throw new Error('Event has not started')

					const minutes = watchMinutes(availability.objectives, owned)
					const task: Task = {
						key,
						title,
						rewardTitle,
						image: globals.get(key)?.imageURL || badge.current.version.image_url_4x,
						availabilityId: availability._id,
						minutes,
						startAt,
						endAt,
						...restrictions(availability)
					}

					const previous = tasks.get(key)

					if (!previous || minutes < previous.minutes || (minutes === previous.minutes && endAt < previous.endAt)) {
						tasks.set(key, task)
					}
				} catch (error) {
					if (!(error instanceof Error)) throw error

					skipped.push({ key, title, reason: error.message })
				}
			}
		}
	}

	for (const task of tasks.values()) {
		const matches = campaigns.flatMap(campaign =>
			(campaign.timeBasedDrops ?? [])
				.filter(
					drop =>
						matchesDrop(task, campaign, drop, now) &&
						!drop.self?.isClaimed &&
						Number.isFinite(drop.self?.currentMinutesWatched) &&
						drop.self!.currentMinutesWatched > 0
				)
				.map(drop => ({ campaignId: campaign.id, id: drop.id, minutes: drop.self!.currentMinutesWatched }))
		)

		if (matches.length === 1) {
			const { campaignId, id, minutes } = matches[0]!

			task.drop = { campaignId, id }
			task.serverMinutes = minutes
		}
	}

	return {
		tasks: [...tasks.values()].sort(
			(a, b) =>
				Number(Boolean(b.serverMinutes)) - Number(Boolean(a.serverMinutes)) ||
				Math.max(0, a.minutes - (a.serverMinutes || 0)) - Math.max(0, b.minutes - (b.serverMinutes || 0)) ||
				a.endAt - b.endAt ||
				a.key.localeCompare(b.key)
		),
		skipped: skipped.filter(record => !tasks.has(record.key))
	}
}

export function describeSkipped(skipped: SkippedBadge[]) {
	const badges = new Map<string, { title: string; reasons: Set<string> }>()

	for (const { key, title, reason } of skipped) {
		if (!badges.has(key)) badges.set(key, { title, reasons: new Set() })

		badges.get(key)!.reasons.add(reason)
	}

	return [...badges].map(([key, badge]) => `[CATALOG] Skipped: ${key} | ${[...badge.reasons].join('; ')}`)
}
