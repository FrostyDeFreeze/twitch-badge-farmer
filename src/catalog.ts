import type { Campaign, Drop, DropProgress, GlobalBadge, Task } from './types.ts'
import { dailyProgress, matchesReward, rewardBadgeKey } from './rewards.ts'

interface Dates {
	start_at_date?: string
	start_at_time?: string
	end_at_date?: string
	end_at_time?: string
}

interface Objective extends Dates {
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
		current: { set_id?: string; version: { id?: string | number; title?: string } }
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

function subscriptionOnly(group: Objective[]) {
	return group.every(objective => ['twitch_subscription', 'twitch_gift_subscription'].includes(objective.type))
}

// Twitch names a Drop reward by the full badge title or by its part after the last ' - '
function rewardNames(...titles: string[]) {
	return [...new Set(titles.flatMap(title => [title, title.split(' - ').at(-1)!]).map(normalizeName))].filter(Boolean)
}

function normalizeName(name: string) {
	return name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

function watchRequirement(objectives: Objective[][] | null | undefined, owned: Set<string>, progress: DropProgress | undefined, now: number) {
	if (!Array.isArray(objectives) || !objectives.length) throw new Error('Missing structured objectives')

	const watches: { minutes: number; days: number }[] = []
	let prerequisite = false

	for (const group of objectives) {
		if (!Array.isArray(group) || !group.length) throw new Error('Unknown objectives')

		const unlocked = group.some(
			objective =>
				objective.type === 'twitch_unlock' &&
				objective.twitch_global_chat_badges?.some(badge => owned.has(badgeKey(badge.set_id, badge.version?.id)))
		)

		if (unlocked) {
			prerequisite = true

			continue
		}

		const options = group
			.filter(
				(objective): objective is Objective & { minutes: number } =>
					objective.type === 'twitch_watch' &&
					typeof objective.minutes === 'number' &&
					Number.isSafeInteger(objective.minutes) &&
					objective.minutes > 0 &&
					(objective.days == null || (Number.isSafeInteger(objective.days) && objective.days > 0))
			)
			.sort((a, b) => a.minutes * (a.days ?? 1) - b.minutes * (b.days ?? 1))

		if (!options.length) {
			if (progress?.daily && subscriptionOnly(group)) continue

			throw new Error('Unsupported or unmet objectives')
		}

		const watch = options[0]!

		if (watch.end_at_date) {
			const deadline = dateAt(watch, {}, 'end', true)
			const completed = watches.reduce((sum, item) => sum + item.days, 0) + (watch.days ?? 1)

			if (now >= deadline && (progress?.daily?.completedDays ?? 0) < completed) throw new Error('Viewing stage expired')
		}

		watches.push({ minutes: watch.minutes, days: watch.days ?? 1 })
	}

	if (!watches.length || (watches.length > 1 && !progress?.daily)) throw new Error('Ambiguous viewing objectives')

	const minutes = watches[0]!.minutes
	const days = watches.reduce((sum, watch) => sum + watch.days, 0)

	if (
		watches.some(watch => watch.minutes !== minutes) ||
		(watches.length > 1 && (progress!.requiredMinutesWatched !== minutes || progress!.daily!.requiredDays !== days))
	)
		throw new Error('Unsupported staged viewing objectives')

	return { minutes, days, prerequisite }
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
		drop.benefitEdges?.some(edge => typeof edge.benefit?.name === 'string' && task.rewardNames.includes(normalizeName(edge.benefit.name)))
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
	const nameKeys = new Map<string, Set<string>>()

	for (const event of data.data as CatalogEvent[]) {
		if (!Array.isArray(event.twitch_global_badges)) throw new Error('StreamDatabase: missing badge list')

		for (const badge of event.twitch_global_badges) {
			const key = badgeKey(badge.current?.set_id, badge.current?.version?.id)
			const rewardTitle = badge.current.version.title || key
			const title = globals.get(key)?.title || rewardTitle
			const names = rewardNames(title, rewardTitle)

			for (const name of names) nameKeys.set(name, (nameKeys.get(name) ?? new Set()).add(key))

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
					if (!['free', 'paid'].includes(availability.cost || '')) throw new Error('Paid or unknown cost')
					if (availability.revocable) throw new Error('Temporary badge')

					if (availability.chance_denominator != null && availability.chance_denominator !== 1) {
						throw new Error('Random reward')
					}

					if (now < startAt) throw new Error('Event has not started')

					const rewards = campaigns.flatMap(campaign =>
						(campaign.rewardGroups ?? [])
							.filter(
								group =>
									rewardBadgeKey(group) === key &&
									(!campaign.startAt || Date.parse(campaign.startAt) <= now) &&
									(!campaign.endAt || Date.parse(campaign.endAt) > now)
							)
							.flatMap(group => {
								const progress = dailyProgress(group, now)

								return progress ? [{ campaign, group, progress }] : []
							})
					)

					const reward = rewards.length === 1 ? rewards[0] : undefined
					const paid = availability.cost === 'paid'
					let requirement

					try {
						requirement = watchRequirement(availability.objectives, owned, reward?.progress, now)
					} catch (error) {
						if (paid) throw new Error('Paid or unknown cost')

						throw error
					}

					const { minutes, days, prerequisite } = requirement

					// an owned prerequisite unlocks a paid evolution; an acquired container must already show on Twitch
					if (paid && !(days > 1 && (prerequisite || (reward && availability.objectives?.some(subscriptionOnly)))))
						throw new Error('Paid or unknown cost')
					if (days > 1 && rewards.length > 1) throw new Error('Ambiguous daily reward')
					// a listed group without usable progress means Twitch rejects it, such as for unmet prerequisites
					if (
						days > 1 &&
						!rewards.length &&
						campaigns.some(campaign => campaign.rewardGroups?.some(group => rewardBadgeKey(group) === key))
					)
						throw new Error('Daily reward unavailable on Twitch')

					const task: Task = {
						key,
						title,
						rewardNames: names,
						availabilityId: availability._id,
						minutes,
						...(days > 1 ? { days } : {}),
						startAt,
						endAt,
						...restrictions(availability)
					}

					if (days > 1 && reward) {
						if (!matchesReward(task, reward.campaign, reward.group, now)) throw new Error('Daily reward requirements do not match')

						task.drop = { id: reward.group.id, campaignId: reward.campaign.id, kind: 'reward-group' }
						task.serverMinutes = reward.progress.currentMinutesWatched
						task.daily = reward.progress.daily!
					}

					const previous = tasks.get(key)

					if (
						!previous ||
						minutes * days < previous.minutes * (previous.days ?? 1) ||
						(minutes * days === previous.minutes * (previous.days ?? 1) && endAt < previous.endAt)
					) {
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
		// a short name shared by several catalog badges cannot identify a reward
		task.rewardNames = task.rewardNames.filter(name => nameKeys.get(name)!.size === 1)

		if (task.days) continue

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
